import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "../ui/dynamic-border.js";
import {
  Container,
  SelectList,
  Spacer,
  Text,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { FabricTraceSafeError } from "../audit/trace-schema.js";
import { runAbortable, throwIfAborted } from "../async-settlement.js";

type ThemeColorApplicator = (name: string, text: string) => string;

const selectListThemeFor = (theme: unknown) => {
  const apply = (name: string, text: string): string =>
    (theme as { fg: ThemeColorApplicator }).fg(name, text);
  return {
    selectedPrefix: (text: string) => apply("accent", text),
    selectedText: (text: string) => apply("accent", text),
    description: (text: string) => apply("muted", text),
    scrollInfo: (text: string) => apply("muted", text),
    noMatch: (text: string) => apply("muted", text),
  };
};
import type { FabricApprovalConfig } from "../config.js";
import { actionApprovalOverride } from "./approval-overrides.js";
import type { FabricRisk } from "../protocol.js";
import type { ResolvedFabricAction } from "./action-registry.js";
import type { FabricHumanWait } from "../runtime/kernel.js";
import {
  FabricAutoApprovalClassifier,
  type FabricAutoApprovalDecision,
  type FabricAutoApprovalVerdicts,
} from "./auto-approval-classifier.js";
import type { FabricActionPolicyVerdict } from "./action-policy-hooks.js";

/** Opt-in extension policy at the approve stage, bound to one call site. */
export interface FabricActionPolicyGate {
  /** True when at least one hook may answer, so approve() may wait on it. */
  readonly active: boolean;
  evaluate(action: ResolvedFabricAction, args: Record<string, unknown>, signal?: AbortSignal): Promise<FabricActionPolicyVerdict | undefined>;
}

const inheritedRisks = (): FabricRisk[] => {
  const allowed = new Set<FabricRisk>(["read", "write", "execute", "network", "agent"]);
  return (process.env.PI_FABRIC_GRANTED_RISKS ?? "")
    .split(",")
    .filter((risk): risk is FabricRisk => allowed.has(risk as FabricRisk));
};

type ApprovalChoice = "allow-once" | "allow-session" | "deny";

const onceLabel = "Allow once";
const sessionLabel = (risk: FabricRisk): string =>
  `Allow ${risk} access for this session`;

export class FabricSessionApprovals {
  readonly approvedRisks = new Set<FabricRisk>();
  #generation = 0;
  #permissions: Promise<import("./permission-queue.js").FabricPermissionQueue> | undefined;

  get generation(): number { return this.#generation; }

  permissions(): Promise<import("./permission-queue.js").FabricPermissionQueue> {
    return this.#permissions ??= import("./permission-queue.js").then(({ FabricPermissionQueue }) => new FabricPermissionQueue());
  }

  clear(): void {
    this.#generation++;
    this.approvedRisks.clear();
    const previous = this.#permissions;
    this.#permissions = undefined;
    void previous?.then(queue => queue.clear(), () => {});
  }
  #tail: Promise<void> = Promise.resolve();

  async serialize<T>(request: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release: (() => void) | undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await request();
    } finally {
      release?.();
    }
  }
}

export interface FabricAutoApprovalAudit {
  action: string;
  risk: FabricRisk;
  decision: "allow" | "escalate";
  reason: string;
  model?: string;
  error?: string;
  at: number;
  /** Jev path only: per-question probabilities behind the decision. */
  verdicts?: FabricAutoApprovalVerdicts;
  /** Jev path only: effective auto-approval threshold. */
  threshold?: number;
  /** Set when an extension action policy hook settled the prompt instead of a classifier. */
  policyHook?: string;
}

export class ApprovalController {
  readonly #inheritedRisks = new Set<FabricRisk>(inheritedRisks());

  constructor(
    readonly config: FabricApprovalConfig,
    readonly context: ExtensionContext,
    readonly sessionApprovals = new FabricSessionApprovals(),
    readonly classifier = new FabricAutoApprovalClassifier(),
    readonly onAutoDecision?: (
      audit: FabricAutoApprovalAudit,
      decision?: FabricAutoApprovalDecision,
    ) => void,
    readonly brokeredNetwork?: (provider: string) => boolean,
    /** approvals.headless "decision": resolve to true only on an explicit approve. */
    readonly headless?: (action: ResolvedFabricAction, reason?: string, signal?: AbortSignal) => Promise<boolean>,
    /** Extension policy hooks; absent unless approvals.policyHooks is true. */
    readonly policyGate?: FabricActionPolicyGate,
  ) {}

  /** Policy only: true when approve() settles without a prompt or classifier call. */
  decidesWithoutInteraction(action: ResolvedFabricAction): boolean {
    // A hook may hold any action for a person, so its answer is never known in advance.
    if (this.policyGate?.active) return false;
    return this.#policyDecision(action) !== "interactive";
  }

  #policyDecision(action: ResolvedFabricAction): "allow" | "deny-action" | "deny-risk" | "interactive" {
    const override = actionApprovalOverride(this.config.actions, action.ref);
    // An action-level deny is absolute: no inherited or session risk grant lifts it.
    if (override === "deny") return "deny-action";
    // This is an immutable host capability, not a model/configurable network grant.
    if (action.risk === "network" && this.brokeredNetwork?.(action.provider) === true) return "allow";
    // Exact ref beats provider wildcard beats the risk-class mode.
    const mode = override ?? this.config[action.risk] ?? this.config.default ?? "allow";
    if (
      mode === "allow" ||
      (!this.brokeredNetwork && (
        this.#inheritedRisks.has(action.risk) ||
        this.sessionApprovals.approvedRisks.has(action.risk)
      ))
    ) return "allow";
    return mode === "deny" ? "deny-risk" : "interactive";
  }

  /** `humanWait` pauses the program deadline only while a person is asked:
   * the screen prompt or a headless decision. Policy checks and the auto
   * classifier still spend the normal budget. `signal` owns this call,
   * including queued prompts and all post-await approval side effects. */
  async approve(
    action: ResolvedFabricAction,
    args: Record<string, unknown> = {},
    humanWait?: FabricHumanWait,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const generation = this.sessionApprovals.generation;
    // Extension hooks run first. Their deny is absolute; their allow and hold
    // never lift a configured deny below.
    const hook = this.policyGate?.active
      ? await runAbortable(signal, () => this.policyGate!.evaluate(action, args, signal))
      : undefined;
    throwIfAborted(signal);
    if (hook?.decision === "deny") {
      throw new FabricTraceSafeError(
        `${action.ref} is denied by the Fabric action policy hook ${hook.hook}: ${hook.reason ?? "no reason given"}`,
      );
    }
    const policy = this.#policyDecision(action);
    if (policy === "deny-action") {
      throw new FabricTraceSafeError(`${action.ref} is denied by the Fabric approvals.actions policy`);
    }
    if (policy === "deny-risk") {
      throw new FabricTraceSafeError(`${action.ref} is denied by the Fabric ${action.risk} policy`);
    }
    const mode = actionApprovalOverride(this.config.actions, action.ref) ?? this.config[action.risk] ?? this.config.default ?? "allow";
    const queue = this.context.hasUI && mode === "auto" ? await this.sessionApprovals.permissions() : undefined;
    const assertCurrent = (): void => {
      throwIfAborted(signal);
      if (generation !== this.sessionApprovals.generation) throw new FabricTraceSafeError("Permission request cancelled: session changed");
    };
    assertCurrent();
    const existing = queue?.take(action, args, this.context.cwd);
    if (existing === "allowed") {
      this.onAutoDecision?.({ action: action.ref, risk: action.risk, decision: "allow",
        reason: "User approved this exact call once through /fabric permissions", at: Date.now() });
      return;
    }
    if (existing) throw new FabricTraceSafeError(queue!.message(existing));
    const escalate = async (reason: string): Promise<void> => {
      assertCurrent();
      if (!queue) return this.#requestApproval(action, reason, humanWait, signal);
      const record = queue.block(action, args, this.context.cwd, reason);
      this.context.ui.setStatus?.("fabric-permissions", `${queue.pendingCount} blocked · /fabric permissions`);
      throw new FabricTraceSafeError(queue.message(record));
    };
    if (hook?.decision === "hold") {
      // Auto holds are also asynchronous; an explicit once grant settles the hold.
      if (mode === "auto") return escalate(`Held by policy hook ${hook.hook}: ${hook.reason ?? "no reason given"}`);
      // Ask even when configuration or a session grant would allow the action.
      await runAbortable(signal, () => this.sessionApprovals.serialize(() => this.#requestApproval(
        action,
        `Held by policy hook ${hook.hook}: ${hook.reason ?? "no reason given"}`,
        humanWait,
        signal,
      )));
      return;
    }
    if (policy === "allow") return;
    // A hook allow settles an ask or auto prompt only. Record it like an auto
    // decision, so the settled prompt leaves a trace naming the hook.
    if (hook?.decision === "allow") {
      this.onAutoDecision?.({
        action: action.ref,
        risk: action.risk,
        decision: "allow",
        reason: `Allowed by Fabric action policy hook ${hook.hook}`,
        policyHook: hook.hook,
        at: Date.now(),
      });
      return;
    }
    if (mode !== "auto") {
      await runAbortable(signal, () => this.sessionApprovals.serialize(async () => {
        throwIfAborted(signal);
        if (!this.sessionApprovals.approvedRisks.has(action.risk)) {
          await this.#requestApproval(action, undefined, humanWait, signal);
        }
      }));
      return;
    }

    // Auto classifiers run concurrently; only explicit ask policies serialize
    // a human wait. Escalations are queued instead of opening a dialog.

    let decision: FabricAutoApprovalDecision;
    try {
      decision = await runAbortable(signal, () => this.classifier.classify(
        action, args, this.context, this.config.model,
      ));
    } catch (error) {
      assertCurrent();
      const message = error instanceof Error ? error.message : String(error);
      this.onAutoDecision?.({
        action: action.ref, risk: action.risk, decision: "escalate",
        reason: "Classifier unavailable; explicit approval required", error: message, at: Date.now(),
      });
      await escalate(`Auto mode could not determine safety: ${message}`);
      return;
    }
    assertCurrent();
    this.onAutoDecision?.({
      action: action.ref, risk: action.risk, decision: decision.decision,
      reason: decision.reason, model: decision.model, at: Date.now(),
      ...(decision.verdicts ? { verdicts: decision.verdicts } : {}),
      ...(decision.threshold !== undefined ? { threshold: decision.threshold } : {}),
    }, decision);
    if (decision.decision === "allow") return;
    await escalate(`Auto mode escalated (${decision.model}): ${decision.reason}`);
  }

  async #requestApproval(
    action: ResolvedFabricAction,
    escalationReason?: string,
    humanWait?: FabricHumanWait,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const ask = <T>(wait: () => Promise<T>): Promise<T> => runAbortable(signal, () => humanWait
      ? humanWait(() => runAbortable(signal, wait))
      : wait());
    if (!this.context.hasUI) {
      if (this.config.headless === "decision" && this.headless) {
        const headless = this.headless;
        const allowed = await ask(() => signal
          ? headless(action, escalationReason, signal)
          : headless(action, escalationReason));
        throwIfAborted(signal);
        if (allowed) return;
        throw new FabricTraceSafeError(`${action.ref} approval was denied, cancelled, or expired`);
      }
      throw new FabricTraceSafeError(`${action.ref} requires approval, but no interactive UI is available`);
    }

    const notification = escalationReason
      ? `Fabric auto mode needs approval: ${action.ref} · ${escalationReason}`
      : `Fabric permission requested: ${action.ref} needs ${action.risk} access`;
    this.context.ui.notify(notification, "warning");
    const choice = await ask(() => this.context.mode === "tui"
      ? this.#requestTuiApproval(action, escalationReason, signal)
      : this.#requestDialogApproval(action, escalationReason, signal));
    throwIfAborted(signal);

    if (choice === "deny") {
      this.context.ui.notify(`Denied ${action.risk} access for ${action.ref}`, "warning");
      throw new FabricTraceSafeError(`User denied ${action.risk} access for ${action.ref}`);
    }
    if (choice === "allow-session") {
      this.sessionApprovals.approvedRisks.add(action.risk);
      this.context.ui.notify(
        `Allowed ${action.risk} access for this Pi session`,
        "info",
      );
      return;
    }
    this.context.ui.notify(`Allowed once: ${action.ref}`, "info");
  }

  async #requestDialogApproval(
    action: ResolvedFabricAction,
    escalationReason?: string,
    signal?: AbortSignal,
  ): Promise<ApprovalChoice> {
    const session = sessionLabel(action.risk);
    const title = [
      `Pi Fabric permission · ${action.ref} requests ${action.risk} access. ${action.description}`,
      escalationReason,
    ].filter(Boolean).join(" · ");
    const options = [onceLabel, session, "Deny"];
    const picked = signal
      ? await this.context.ui.select(title, options, { signal })
      : await this.context.ui.select(title, options);
    if (picked === onceLabel) return "allow-once";
    if (picked === session) return "allow-session";
    return "deny";
  }

  async #requestTuiApproval(
    action: ResolvedFabricAction,
    escalationReason?: string,
    signal?: AbortSignal,
  ): Promise<ApprovalChoice> {
    // custom() has no signal option: finish through the host-owned callback.
    let dismiss: (() => void) | undefined;
    const onAbort = () => dismiss?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const choice = await this.context.ui.custom<ApprovalChoice>((tui, theme, _keybindings, done) => {
        dismiss = () => done("deny");
        if (signal?.aborted) queueMicrotask(dismiss);
        const container = new Container();
        container.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("warning", theme.bold("🛡  Pi Fabric permission request")), 1, 0),
        );
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            theme.fg("text", `${action.ref} requests ${action.risk} access.`),
            1,
            0,
          ),
        );
        container.addChild(new Text(theme.fg("muted", action.description), 1, 0));
        if (escalationReason) {
          container.addChild(new Spacer(1));
          container.addChild(
            new Text(theme.fg("warning", escalationReason), 1, 0),
          );
        }
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            theme.fg("dim", "Choose whether to allow only this call or this risk class for the session."),
            1,
            0,
          ),
        );
        container.addChild(new Spacer(1));
        const items: SelectItem[] = [
          {
            value: "allow-once",
            label: onceLabel,
            description: "Run only this requested action",
          },
          {
            value: "allow-session",
            label: sessionLabel(action.risk),
            description: "Do not ask again for this risk class until the Pi session ends",
          },
          {
            value: "deny",
            label: "Deny",
            description: "Block the requested action",
          },
        ];
        const list = new SelectList(items, items.length, selectListThemeFor(theme));
        list.onSelect = (item) => done(item.value as ApprovalChoice);
        list.onCancel = () => done("deny");
        container.addChild(list);
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("dim", "↑↓ navigate · enter select · esc deny"), 1, 0),
        );
        container.addChild(new Spacer(1));
        container.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      });
      return choice ?? "deny";
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
