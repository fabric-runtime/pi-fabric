import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "../ui/dynamic-border.js";
import {
  Container,
  SelectList,
  Spacer,
  Text,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { FabricTraceSafeError } from "../audit/trace.js";

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
    readonly headless?: (action: ResolvedFabricAction, reason?: string) => Promise<boolean>,
  ) {}

  /** `humanWait` pauses the program deadline only while a person is asked:
   * the screen prompt or a headless decision. Policy checks and the auto
   * classifier still spend the normal budget. */
  async approve(
    action: ResolvedFabricAction,
    args: Record<string, unknown> = {},
    humanWait?: FabricHumanWait,
  ): Promise<void> {
    const override = actionApprovalOverride(this.config.actions, action.ref);
    // An action-level deny is absolute: no inherited or session risk grant lifts it.
    if (override === "deny") {
      throw new FabricTraceSafeError(`${action.ref} is denied by the Fabric approvals.actions policy`);
    }
    // This is an immutable host capability, not a model/configurable network grant.
    if (action.risk === "network" && this.brokeredNetwork?.(action.provider) === true) return;
    // Exact ref beats provider wildcard beats the risk-class mode.
    const mode = override ?? this.config[action.risk];
    if (
      mode === "allow" ||
      (!this.brokeredNetwork && (
        this.#inheritedRisks.has(action.risk) ||
        this.sessionApprovals.approvedRisks.has(action.risk)
      ))
    ) return;
    if (mode === "deny") {
      throw new FabricTraceSafeError(`${action.ref} is denied by the Fabric ${action.risk} policy`);
    }

    await this.sessionApprovals.serialize(async () => {
      if (this.sessionApprovals.approvedRisks.has(action.risk)) return;
      if (mode !== "auto") {
        await this.#requestApproval(action, undefined, humanWait);
        return;
      }

      let decision: FabricAutoApprovalDecision;
      try {
        decision = await this.classifier.classify(
          action,
          args,
          this.context,
          this.config.model,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.onAutoDecision?.({
          action: action.ref,
          risk: action.risk,
          decision: "escalate",
          reason: "Classifier unavailable; explicit approval required",
          error: message,
          at: Date.now(),
        });
        await this.#requestApproval(
          action,
          `Auto mode could not determine safety: ${message}`,
          humanWait,
        );
        return;
      }
      this.onAutoDecision?.({
        action: action.ref,
        risk: action.risk,
        decision: decision.decision,
        reason: decision.reason,
        model: decision.model,
        at: Date.now(),
        ...(decision.verdicts ? { verdicts: decision.verdicts } : {}),
        ...(decision.threshold !== undefined ? { threshold: decision.threshold } : {}),
      }, decision);
      if (decision.decision === "allow") return;
      await this.#requestApproval(
        action,
        `Auto mode escalated (${decision.model}): ${decision.reason}`,
        humanWait,
      );
    });
  }

  async #requestApproval(
    action: ResolvedFabricAction,
    escalationReason?: string,
    humanWait?: FabricHumanWait,
  ): Promise<void> {
    const ask = <T>(wait: () => Promise<T>): Promise<T> => humanWait ? humanWait(wait) : wait();
    if (!this.context.hasUI) {
      if (this.config.headless === "decision" && this.headless) {
        const headless = this.headless;
        if (await ask(() => headless(action, escalationReason))) return;
        throw new FabricTraceSafeError(`${action.ref} approval was denied, cancelled, or expired`);
      }
      throw new FabricTraceSafeError(`${action.ref} requires approval, but no interactive UI is available`);
    }

    const notification = escalationReason
      ? `Fabric auto mode needs approval: ${action.ref} · ${escalationReason}`
      : `Fabric permission requested: ${action.ref} needs ${action.risk} access`;
    this.context.ui.notify(notification, "warning");
    const choice = await ask(() => this.context.mode === "tui"
      ? this.#requestTuiApproval(action, escalationReason)
      : this.#requestDialogApproval(action, escalationReason));

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
  ): Promise<ApprovalChoice> {
    const session = sessionLabel(action.risk);
    const picked = await this.context.ui.select(
      [
        `Pi Fabric permission · ${action.ref} requests ${action.risk} access. ${action.description}`,
        escalationReason,
      ].filter(Boolean).join(" · "),
      [onceLabel, session, "Deny"],
    );
    if (picked === onceLabel) return "allow-once";
    if (picked === session) return "allow-session";
    return "deny";
  }

  async #requestTuiApproval(
    action: ResolvedFabricAction,
    escalationReason?: string,
  ): Promise<ApprovalChoice> {
    const choice = await this.context.ui.custom<ApprovalChoice>((tui, theme, _keybindings, done) => {
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
  }
}
