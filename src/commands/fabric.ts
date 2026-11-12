import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { CapturedToolCatalog } from "../capture/catalog.js";
import type { FabricState } from "../fabric-state.js";
import type { FabricUiController } from "../ui/controller.js";
import { FABRIC_WIDGET_FOCUS_SHORTCUT } from "../ui/widget-keys.js";
import { safeText } from "../ui/format.js";
import {
  FABRIC_DECISION_REQUEST_EVENT,
  FABRIC_DECISIONS_CAPABILITY_EVENT,
  FABRIC_PEER_AWAIT_SETTLE_EVENT,
  FABRIC_PEER_CARDS_EVENT,
  readFabricDecisionRequestV1,
  readFabricDecisionsCapabilityRequestV1,
  FABRIC_PREWALK_REQUEST_EVENT,
  readFabricPeerAwaitSettleRequestV1,
  readFabricPeerCardsRequestV1,
  readFabricPrewalkRequestV1,
} from "../protocol.js";
import type { FabricDecisionsTarget } from "../decisions/events.js";
import { armFabricPrewalkSession } from "../prewalk/arm.js";
import { restoreBorrowedInPlaceMain } from "../prewalk/return.js";
import { setActiveCompiledSurface } from "../entropy/active.js";
import { truncateMiddle } from "../util.js";

// Startup-graph helpers the lazy subcommands use. Passing them in keeps the
// handler's build entry from splitting these modules out of the startup chunk.
const commandHost = {
  armFabricPrewalkSession,
  restoreBorrowedInPlaceMain,
  setActiveCompiledSurface,
  truncateMiddle,
};
export type FabricCommandHost = typeof commandHost;

export interface FabricCommandDeps {
  state: FabricState;
  fabricUi: FabricUiController;
  capturedTools: CapturedToolCatalog;
  applyFabricMode: () => void;
  suspendToolCapture: () => void;
  autoArmPrewalk?: (context: ExtensionContext) => Promise<void>;
  refreshCodePreviewSettings?: () => void;
  refreshToolDisplay?: () => void;
}

export function registerFabricCommand(pi: ExtensionAPI, deps: FabricCommandDeps): void {
  const { state, fabricUi } = deps;
  const unsubscribePrewalkRequests = pi.events?.on?.(FABRIC_PREWALK_REQUEST_EVENT, (value) => {
    const request = readFabricPrewalkRequestV1(value);
    if (!request || !request.claim()) return;
    void (async () => {
      try {
        await state.ensure(request.context);
        const { armPrewalk } = await import("./fabric-handler.js");
        request.respond(await armPrewalk(commandHost, state, request.context, pi));
      } catch (error) {
        request.respond({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
  if (unsubscribePrewalkRequests) {
    pi.on("session_shutdown", () => unsubscribePrewalkRequests());
  }

  // Peer queuing protocol (used by pi-queue-steer): enumerate live peer root
  // sessions and hold dispatch until they settle on the project mesh.
  const unsubscribePeerCards = pi.events?.on?.(FABRIC_PEER_CARDS_EVENT, (value) => {
    const request = readFabricPeerCardsRequestV1(value);
    if (!request || !request.claim()) return;
    void (async () => {
      try {
        await state.ensure(request.context);
        const { buildPeerCards } = await import("../topology/peer-settle.js");
        request.respond({ ok: true, cards: buildPeerCards(state.peerInfos()) });
      } catch (error) {
        request.respond({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
  const unsubscribePeerAwait = pi.events?.on?.(FABRIC_PEER_AWAIT_SETTLE_EVENT, (value) => {
    const request = readFabricPeerAwaitSettleRequestV1(value);
    if (!request || !request.claim()) return;
    void (async () => {
      try {
        await state.ensure(request.context);
        if (!state.config.mesh.enabled) {
          request.respond({ ok: false, error: "Fabric mesh is disabled; peers cannot be observed" });
          return;
        }
        const { awaitPeerSettle } = await import("../topology/peer-settle.js");
        request.respond(await awaitPeerSettle({
          poll: () => state.peerInfos(),
          ...(request.selector !== undefined ? { selector: request.selector } : {}),
          ...(request.settledForMs !== undefined ? { settledForMs: request.settledForMs } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
          ...(request.update ? { onUpdate: request.update } : {}),
        }));
      } catch (error) {
        request.respond({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
  if (unsubscribePeerCards || unsubscribePeerAwait) {
    pi.on("session_shutdown", () => {
      unsubscribePeerCards?.();
      unsubscribePeerAwait?.();
    });
  }

  // Durable decisions channel (used by question tools with no screen): hand a
  // question to a person through the project's decision store.
  const resolveDecisions = async (context: ExtensionContext): Promise<FabricDecisionsTarget> => {
    await state.ensure(context);
    if (!state.config.mesh.enabled) return { reason: "Fabric mesh is disabled; durable decisions are unavailable" };
    const store = state.decisionStore();
    return store ? { store } : { reason: "Durable decisions are unavailable in this Fabric host" };
  };
  const unsubscribeDecisionsCapability = pi.events?.on?.(FABRIC_DECISIONS_CAPABILITY_EVENT, (value) => {
    const request = readFabricDecisionsCapabilityRequestV1(value);
    if (!request || !request.claim()) return;
    // Loaded on first use so the decision store stays out of the startup graph.
    void import("../decisions/events.js").then(
      ({ answerFabricDecisionsCapability }) => answerFabricDecisionsCapability(request, resolveDecisions),
      (error: unknown) => request.respond({ ok: false, error: `Fabric decisions unavailable: ${String(error)}` }),
    );
  });
  // Aborted at session shutdown, so a request still waiting does not outlive
  // the session that took it; the abort cancels its stored decision.
  const decisionRequests = new AbortController();
  const unsubscribeDecisionRequest = pi.events?.on?.(FABRIC_DECISION_REQUEST_EVENT, (value) => {
    const request = readFabricDecisionRequestV1(value);
    if (!request || !request.claim()) return;
    void import("../decisions/events.js").then(
      ({ answerFabricDecisionRequest }) => answerFabricDecisionRequest(request, resolveDecisions, decisionRequests.signal),
      (error: unknown) => request.respond({ ok: false, error: `Fabric decisions unavailable: ${String(error)}` }),
    );
  });
  if (unsubscribeDecisionsCapability || unsubscribeDecisionRequest) {
    pi.on("session_shutdown", () => {
      unsubscribeDecisionsCapability?.();
      unsubscribeDecisionRequest?.();
      decisionRequests.abort();
    });
  }

  pi.registerShortcut?.(FABRIC_WIDGET_FOCUS_SHORTCUT, {
    description: "Focus the Fabric agent list",
    handler: async (context) => {
      if (context.mode !== "tui") return;
      fabricUi.focusWidget(context);
    },
  });

  pi.registerCommand("fabric", {
    description: "Open Fabric dashboard, chat or tasks, background a running workflow, arm prewalk, reload, or manage agents and actors",
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      const subcommands = [
        "status",
        "dashboard",
        "tasks",
        "background",
        "chat",
        "focus",
        "settings",
        "schema",
        "prewalk",
        "reload",
        "providers",
        "agents",
        "actors",
        "messages",
        "clear-messages",
        "events",
        "log",
        "export-log",
        "attach",
        "stop",
        "remove",
        "global",
        "import",
        "export",
        "kill",
        "repairs",
        "entropy",
        "permissions",
        "decisions",
        "programs",
        "run",
      ];
      const idCommands = new Set([
        "messages",
        "clear-messages",
        "events",
        "log",
        "export-log",
        "attach",
        "stop",
        "remove",
        "kill",
      ]);
      const firstSpace = argumentPrefix.indexOf(" ");
      if (firstSpace < 0) {
        const matches = subcommands.filter((name) => name.startsWith(argumentPrefix));
        return matches.length > 0 ? matches.map((name) => ({ value: name, label: name })) : null;
      }
      const subcommand = argumentPrefix.slice(0, firstSpace);
      const idPrefix = argumentPrefix.slice(firstSpace + 1);
      if (!state.initialized) return null;
      if (subcommand === "tasks") {
        const matches = state.shellJobs?.list().filter(job => job.id.startsWith(idPrefix)) ?? [];
        return matches.map(job => ({ value: `tasks ${job.id}`, label: job.id.slice(0, 8), description: safeText(job.description ?? job.command).slice(0, 120) }));
      }
      if (subcommand === "chat") {
        const snapshot = fabricUi.snapshot();
        const seen = new Set<string>();
        const targets = [snapshot.main, ...snapshot.peers, ...snapshot.actors, ...snapshot.agents, ...(snapshot.participants ?? [])];
        const matches = targets.filter((target) => {
          if (seen.has(target.id)) return false;
          seen.add(target.id);
          return `${target.id} ${target.name}`.toLowerCase().includes(idPrefix.toLowerCase());
        });
        return matches.length > 0 ? matches.map((target) => ({
          value: target.id,
          label: safeText(target.name),
          description: safeText(`${target.status} · ${target.id.slice(0, 8)}`),
        })) : null;
      }
      if (subcommand === "schema") {
        const modes = ["off", "audit", "enforce"].filter((mode) => mode.startsWith(idPrefix));
        return modes.length > 0 ? modes.map((value) => ({ value, label: value })) : null;
      }
      if (subcommand === "import") {
        const items: AutocompleteItem[] = [];
        try {
          for (const template of state.globalActors.list()) {
            items.push({
              value: template.name,
              label: template.name,
              description: `global ${template.runner} template · ${template.id.slice(0, 8)}`,
            });
          }
        } catch {
          /* global registry not initialized */
        }
        const filtered = items.filter((item) => item.value.startsWith(idPrefix));
        return filtered.length > 0 ? filtered : null;
      }
      if (!idCommands.has(subcommand)) {
        if (subcommand === "export") {
          const items: AutocompleteItem[] = [];
          try {
            for (const actor of state.actors.list()) {
              items.push({
                value: actor.name,
                label: actor.name,
                description: `${actor.status} ${actor.runner} actor · ${actor.id.slice(0, 8)}`,
              });
            }
          } catch {
            /* actors not initialized */
          }
          const filtered = items.filter((item) => item.value.startsWith(idPrefix));
          return filtered.length > 0 ? filtered : null;
        }
        return null;
      }
      const items: AutocompleteItem[] = [];
      try {
        for (const actor of state.actors.list()) {
          items.push({
            value: actor.name,
            label: actor.name,
            description: `${actor.status} ${actor.runner} actor · ${actor.id.slice(0, 8)}`,
          });
        }
      } catch {
        /* actors not initialized */
      }
      try {
        for (const agent of state.agents.list()) {
          const short = agent.id.slice(0, 8);
          items.push({
            value: short,
            label: short,
            description: `${agent.status} ${agent.runner} agent · ${agent.name}`,
          });
        }
      } catch {
        /* agents not initialized */
      }
      const filtered = items.filter((item) => item.value.startsWith(idPrefix));
      return filtered.length > 0 ? filtered : null;
    },
    // The subcommands load at first use, not while registering the command.
    async handler(argumentsText, context) {
      const [command, ...args] = argumentsText.trim().split(/\s+/);
      if (command === "background") {
        if (args.length) { context.ui.notify("Usage: /fabric background", "warning"); return; }
        // Extension commands run before queued input. Do not wait for runtime
        // initialization or load the full command handler to release Main.
        const count = state.programTasks.detachWaiting();
        context.ui.notify(count
          ? `Fabric: ${count === 1 ? "whole workflow moved" : `${count} whole workflows moved`} to the background. Work continues; completion will be reported. /fabric tasks`
          : "Fabric: no foreground workflow to background", "info");
        return;
      }
      const { runFabricCommand } = await import("./fabric-handler.js");
      await runFabricCommand(pi, deps, commandHost, argumentsText, context);
    },
  });
}
