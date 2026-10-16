import path from "node:path";
import { resolveAgentDir } from "../core/agent-dir.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { CodePreviewSettings } from "./code-preview.js";
import type { FabricConversationState, FabricConversationTarget, FabricConversationView } from "./conversation.js";
import type { NativeConversationReader, NativeConversationSource } from "./conversation-native-reader.js";
import type { FabricConversationTranscriptRendererOptions } from "./conversation-render.js";
import type { FabricActivityRun } from "../activity/types.js";
import type {
  FabricActorBindingScope,
  FabricActorDelivery,
  FabricActorHostEvent,
} from "../actors/types.js";
import type { FabricState } from "../fabric-state.js";
import type { FabricThinking } from "../thinking.js";
import type { MeshEvent } from "../mesh/store.js";
import type { FabricDashboardMessageTarget } from "./dashboard.js";
import type { ModelSource } from "./model-picker.js";
import { createDashboardSnapshot, FabricDashboardSnapshotCache } from "./snapshot.js";
import { safeText } from "./format.js";
import { isActiveStatus, type FabricDashboardSnapshot, type FabricUiActor, type FabricUiAgent } from "./types.js";
import { FabricWidget, shouldShowFabricWidget } from "./widget.js";
import { WIDGET_ACTIVITY_LOG_LINES } from "./widget-activity.js";
import { FabricWidgetRetention } from "./retention.js";
import { AgentTranscriptReader, type FabricTranscriptSource } from "./transcript.js";

const WIDGET_ID = "pi-fabric";
const ACTIVITY_REFRESH_MS = 100;

const emptySnapshot = (): FabricDashboardSnapshot => {
  const now = Date.now();
  return {
    now,
    runs: [],
    main: {
      id: "main",
      name: "Main",
      kind: "main",
      status: "idle",
      runner: "pi",
      transport: "host",
      cwd: process.cwd(),
      startedAt: now,
      updatedAt: now,
      pendingMessages: false,
      local: true,
    },
    peers: [],
    agents: [],
    actors: [],
    componentGraph: { components: [], edges: [], cycles: [] },
    globalActors: [],
    state: [],
    events: [],
  };
};

export class FabricUiController {
  #context: ExtensionContext | undefined;
  #snapshot: FabricDashboardSnapshot = emptySnapshot();
  #events: MeshEvent[] = [];
  #meshOffset = 0;
  #timer: NodeJS.Timeout | undefined;
  #activityUnsubscribe: (() => void) | undefined;
  #actorUnsubscribe: (() => void) | undefined;
  #agentUnsubscribe: (() => void) | undefined;
  #shellUnsubscribe: (() => void) | undefined;
  #tasksOpen = false;
  #tasksView: import("./shell-tasks.js").ShellTasksView | undefined;
  #closeTasks: (() => void) | undefined;
  #scheduledRefresh: NodeJS.Timeout | undefined;
  #widgetTui: TUI | undefined;
  #dashboardTui: TUI | undefined;
  #widgetMounted = false;
  #widget: FabricWidget | undefined;
  /** Component that had focus before the widget took it (normally the editor). */
  #widgetReturnFocus: Component | undefined;
  /** Pi's hideThinkingBlock for the widget pane; read once, at the first expansion. */
  #widgetHideThinking: boolean | undefined;
  #widgetHideThinkingLoad: Promise<void> | undefined;
  #lastRefreshErrorAt = 0;
  #lastRefreshAt = 0;
  #dashboardOpen = false;
  #conversationOpen = false;
  #conversationState: FabricConversationState | undefined;
  #conversationView: FabricConversationView | undefined;
  #conversationTui: TUI | undefined;
  #closeConversation: (() => void) | undefined;
  #epoch = 0;
  #activityRevision: number | undefined;
  // Tracks whether #activityRuns was last fetched with full payloads. The
  // dashboard needs args/result/preview to render call detail; the periodic
  // refresh instead pulls payload-free summaries so streaming runs stop
  // paying a deep clone of up to 1,000 bounded call payloads per tick.
  #activityRunsDetailed = true;
  #activityRuns: FabricActivityRun[] = [];
  #activityView: ((detailed?: boolean) => FabricActivityRun[]) | undefined;
  readonly #transcripts = new AgentTranscriptReader();
  /** Deeper pages for the widget's activity pane, so a turn's early thinking and tool calls stay visible. */
  readonly #widgetTranscripts = new AgentTranscriptReader(WIDGET_ACTIVITY_LOG_LINES);
  readonly #conversationReaders = new Map<string, NativeConversationReader>();
  #activeConversationReader: string | undefined;
  readonly #snapshotCache = new FabricDashboardSnapshotCache();
  #refreshGeneration = 0;
  readonly #widgetRetention = new FabricWidgetRetention();

  constructor(
    readonly state: FabricState,
    readonly codePreviewSettings?: CodePreviewSettings,
    readonly conversationRenderers?: FabricConversationTranscriptRendererOptions,
  ) {}

  start(context: ExtensionContext): void {
    this.stop();
    this.#context = context;
    if (!this.state.config.ui.enabled || context.mode !== "tui") return;
    if (this.state.config.mesh.enabled) {
      this.#events = this.state.mesh.read({ limit: this.state.config.ui.eventHistory });
      this.#meshOffset = this.state.mesh.latestOffset();
    }
    this.#activityUnsubscribe = this.state.activity.subscribe(() => this.#scheduleRefresh());
    this.#actorUnsubscribe = this.state.actors.subscribe(() => this.#scheduleRefresh());
    this.#agentUnsubscribe = this.state.agents.subscribeUi(() => this.#scheduleRefresh());
    this.#shellUnsubscribe = this.state.shellJobs?.subscribe(() => this.#scheduleRefresh());
    this.#refresh();
    this.#schedulePoll();
  }

  stop(): void {
    this.#epoch++;
    this.#closeTasks?.();
    this.#closeTasks = undefined;
    this.#tasksView?.dispose();
    this.#tasksView = undefined;
    this.#tasksOpen = false;
    this.#shellUnsubscribe?.();
    this.#shellUnsubscribe = undefined;
    this.#closeConversation?.();
    this.#closeConversation = undefined;
    this.#conversationView?.dispose();
    this.#conversationView = undefined;
    this.#conversationTui = undefined;
    this.#conversationOpen = false;
    this.#conversationState?.clear();
    this.#conversationState = undefined;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#scheduledRefresh) clearTimeout(this.#scheduledRefresh);
    this.#timer = undefined;
    this.#scheduledRefresh = undefined;
    // Hand focus back before the widget goes away, and drop the editor of this session.
    this.#releaseWidget();
    this.#widgetReturnFocus = undefined;
    this.#widgetHideThinking = undefined;
    this.#widgetHideThinkingLoad = undefined;
    this.#widget = undefined;
    this.#activityUnsubscribe?.();
    this.#activityUnsubscribe = undefined;
    this.#actorUnsubscribe?.();
    this.#actorUnsubscribe = undefined;
    this.#agentUnsubscribe?.();
    this.#agentUnsubscribe = undefined;
    if (this.#context?.mode === "tui") {
      this.#context.ui.setWidget(WIDGET_ID, undefined);
    }
    this.#context = undefined;
    this.#widgetTui = undefined;
    this.#dashboardTui = undefined;
    this.#widgetMounted = false;
    this.#events = [];
    this.#meshOffset = 0;
    this.#snapshot = emptySnapshot();
    this.#widgetRetention.clear();
    this.#lastRefreshErrorAt = 0;
    this.#lastRefreshAt = 0;
    this.#dashboardOpen = false;
    this.#activityRevision = undefined;
    this.#activityRunsDetailed = true;
    this.#activityRuns = [];
    this.#activityView = undefined;
    this.#transcripts.clear();
    this.#widgetTranscripts.clear();
    for (const reader of this.#conversationReaders.values()) reader.clear();
    this.#conversationReaders.clear();
    this.#activeConversationReader = undefined;
    this.#snapshotCache.clear();
  }

  /** True while Fabric owns keyboard input, including asynchronous view setup. */
  get ownsInput(): boolean {
    // A focused widget owns Esc/arrows, so Esc there closes the pane instead of halting workers.
    return this.#dashboardOpen || this.#conversationOpen || this.#tasksOpen || this.#widget?.focused === true;
  }

  /** Focus the bottom widget so its participant rows can be expanded in place. */
  focusWidget(context: ExtensionContext): void {
    if (context.mode !== "tui") return;
    const tui = this.#widgetTui as (TUI & { getFocusedComponent?(): unknown }) | undefined;
    const widget = this.#widget;
    if (!tui || !widget) {
      context.ui.notify("No Fabric activity to expand", "info");
      return;
    }
    if (widget.focused) return this.#releaseWidget();
    const current = tui.getFocusedComponent?.();
    if (current && current !== widget) this.#widgetReturnFocus = current as Component;
    widget.selectDefault();
    tui.setFocus(widget);
    tui.requestRender();
  }

  /** Return focus to the editor; a `forward` key the widget did not use goes to the editor too. */
  #releaseWidget(forward?: string): void {
    const tui = this.#widgetTui;
    if (!tui || !this.#widget?.focused) return;
    const target = this.#widgetReturnFocus;
    tui.setFocus(target ?? null);
    if (forward !== undefined) target?.handleInput?.(forward);
    tui.requestRender();
  }

  /** Read Pi's hideThinkingBlock off the startup path, then redraw the pane. */
  #widgetHidesThinking(context: ExtensionContext, tui: TUI): boolean {
    if (this.#widgetHideThinking !== undefined) return this.#widgetHideThinking;
    const epoch = this.#epoch;
    this.#widgetHideThinkingLoad ??= (async () => {
      let hidden = false;
      try {
        const { loadHostSdk } = await import("../core/host-sdk.js");
        const { SettingsManager } = await loadHostSdk();
        hidden = SettingsManager.create(context.cwd, resolveAgentDir(), { projectTrusted: context.isProjectTrusted?.() ?? false })
          .getHideThinkingBlock();
      } catch { /* no host settings: show thinking, as Pi does by default */ }
      if (epoch !== this.#epoch) return;
      this.#widgetHideThinking = hidden;
      tui.requestRender();
    })();
    // Until the setting is known, show the marker only: never flash reasoning a user hid.
    return true;
  }

  async openTasks(context: ExtensionContext, query?: string): Promise<void> {
    if (this.ownsInput) return;
    const jobs = this.state.shellJobs;
    if (!jobs) { context.ui.notify("No shell task store in this session", "info"); return; }
    // Input ownership is claimed synchronously; reattached tasks arrive as store events.
    void jobs.durable?.resume();
    const candidates = query ? jobs.list().filter(job => job.id === query || job.id.startsWith(query)) : [];
    if (query && candidates.length !== 1) { context.ui.notify("Task ID is unknown or ambiguous", "warning"); return; }
    if (context.mode !== "tui") {
      context.ui.notify(JSON.stringify(query ? candidates[0] : jobs.list(), null, 2), "info");
      return;
    }
    if (!this.state.config.ui.enabled) { context.ui.notify("The Fabric UI is disabled by ui.enabled", "warning"); return; }
    if (!this.#context) this.start(context);
    this.#tasksOpen = true;
    const epoch = this.#epoch;
    try {
      const [{ ShellTasksView }, { imageSafeCustom }] = await Promise.all([import("./shell-tasks.js"), import("./image-overlays.js")]);
      if (epoch !== this.#epoch) return;
      await imageSafeCustom<void>(context.ui, (tui, theme, keys, done) => {
        this.#closeTasks = () => done();
        const id = candidates[0]?.id;
        this.#tasksView = new ShellTasksView({ jobs, theme, keys, done: () => done(), requestRender: () => tui.requestRender(),
          rows: () => tui.terminal?.rows ?? 24, ...(id ? { id } : {}) });
        return this.#tasksView;
      }, { overlay: true, overlayOptions: { width: "94%", maxHeight: "90%", anchor: "center", margin: 1 } });
    } finally {
      if (epoch === this.#epoch) {
        this.#tasksView?.dispose();
        this.#tasksView = undefined;
        this.#closeTasks = undefined;
        this.#tasksOpen = false;
      }
    }
  }

  async openConversation(context: ExtensionContext, query?: string): Promise<void> {
    if (this.#tasksOpen) return;
    if (context.mode !== "tui") {
      context.ui.notify("Fabric conversations are available in TUI mode", "warning");
      return;
    }
    if (!this.state.config.ui.enabled) {
      context.ui.notify("The Fabric UI is disabled by ui.enabled", "warning");
      return;
    }
    if (this.#dashboardOpen) {
      context.ui.notify("Close the dashboard or press Shift+C on a participant to chat", "info");
      return;
    }
    if (!this.#context) this.start(context);
    if (this.#conversationOpen && !this.#conversationView) return;
    const alreadyOpen = this.#conversationOpen;
    this.#conversationOpen = true;
    const epoch = this.#epoch;
    try {
      // Fabric is native ESM, so Pi's jiti virtual modules never apply: resolve
      // the running CLI's own SDK rather than a bare (unbundled) package import.
      const [{ initializeConversationHost }, { loadHostSdk }] =
        await Promise.all([import("./conversation-host.js"), import("../core/host-sdk.js")]);
      const conversationHost = await loadHostSdk();
      if (epoch !== this.#epoch) return;
      initializeConversationHost(conversationHost);
      const [{ FabricConversationView, FabricConversationState }, { conversationTargets, resolveConversationTarget }, { readConversationAppearance }, { NativeConversationReader }, { imageSafeCustom }] =
        await Promise.all([import("./conversation.js"), import("./conversation-targets.js"), import("./conversation-chrome.js"), import("./conversation-native-reader.js"), import("./image-overlays.js")]);
      if (epoch !== this.#epoch) return;
      this.#refresh();
      const initialTarget = query?.trim()
        ? resolveConversationTarget(conversationTargets(this.#snapshot), query.trim())
        : undefined;
      if (alreadyOpen) {
        if (initialTarget) this.#conversationView?.selectTarget(initialTarget.id);
        else this.#closeConversation?.();
        return;
      }
      if (initialTarget?.kind === "main") return;
      this.#conversationState ??= new FabricConversationState();
      let sourceAgents: FabricUiAgent[] | undefined;
      let sourceActors: FabricUiActor[] | undefined;
      let agentsById = new Map<string, FabricUiAgent>();
      let actorsById = new Map<string, FabricUiActor>();
      let targetDomains: unknown[] = [];
      let baseTargets: FabricConversationTarget[] = [];
      let enrichedTargets: FabricConversationTarget[] = [];
      let targetsById = new Map<string, FabricConversationTarget>();
      let modelGeneration = -1;
      let modelWindows = new Map<string, number | undefined>();
      const targets = (): FabricConversationTarget[] => {
        const snapshot = this.#snapshot;
        const domains = [snapshot.main, snapshot.agents, snapshot.actors, snapshot.peers, snapshot.participants];
        const changed = domains.some((domain, index) => domain !== targetDomains[index]);
        if (changed) {
          targetDomains = domains;
          baseTargets = conversationTargets(snapshot);
        }
        if (changed || modelGeneration !== this.#refreshGeneration) {
          modelGeneration = this.#refreshGeneration;
          const windows = new Map<string, number | undefined>();
          for (const target of baseTargets) {
            if (!target.model || windows.has(target.model)) continue;
            const split = target.model.indexOf("/");
            if (split < 1) continue;
            windows.set(target.model, context.modelRegistry?.find?.(
              target.model.slice(0, split), target.model.slice(split + 1),
            )?.contextWindow);
          }
          if (changed || windows.size !== modelWindows.size ||
            [...windows].some(([model, window]) => modelWindows.get(model) !== window)) {
            enrichedTargets = baseTargets.map((target) => {
              const contextWindow = target.model ? windows.get(target.model) : undefined;
              return contextWindow !== undefined ? { ...target, contextWindow } : target;
            });
            targetsById = new Map(enrichedTargets.map((target) => [target.id, target]));
          }
          modelWindows = windows;
        }
        return enrichedTargets;
      };
      const source = (id: string): NativeConversationSource => {
        if (sourceActors !== this.#snapshot.actors) {
          sourceActors = this.#snapshot.actors;
          actorsById = new Map(sourceActors.map((actor) => [actor.id, actor]));
        }
        if (sourceAgents !== this.#snapshot.agents) {
          sourceAgents = this.#snapshot.agents;
          agentsById = new Map(sourceAgents.map((agent) => [agent.id, agent]));
        }
        const actor = actorsById.get(id);
        if (actor) return { ...this.#actorTranscriptSource(actor), id, ...(actor.sessionFile ? { sessionFile: actor.sessionFile } : {}) };
        const agent = agentsById.get(id);
        return agent ? this.#agentTranscriptSource(agent) : { id, status: "unavailable" };
      };
      const readerFor = (id: string): NativeConversationReader => {
        if (this.#activeConversationReader !== id) this.#suspendConversationReader();
        this.#activeConversationReader = id;
        let reader = this.#conversationReaders.get(id);
        if (!reader) {
          reader = new NativeConversationReader();
          this.#conversationReaders.set(id, reader);
        }
        return reader;
      };
      const requireTarget = (id: string, action: "steer" | "followUp" | "stop"): void => {
        if (epoch !== this.#epoch || !this.#conversationOpen || !this.state.initialized) {
          throw new Error("This Fabric conversation is no longer attached");
        }
        this.#refresh();
        targets();
        const target = targetsById.get(id);
        const allowed = action === "stop" ? target?.canStop
          : action === "steer" ? target?.canSteer : target?.canFollowUp;
        if (!target || target.kind === "main" || !allowed) {
          throw new Error(target?.readOnlyReason ?? `Participant ${id} cannot receive ${action}`);
        }
      };
      this.#schedulePoll(true);
      await imageSafeCustom<void>(context.ui, (tui, theme, keybindings, done) => {
        if (epoch !== this.#epoch) {
          done(undefined);
          return { render: () => [], invalidate: () => {} };
        }
        this.#conversationTui = tui;
        this.#closeConversation = () => done(undefined);
        const view = new FabricConversationView(tui, theme, {
          targets,
          onTargetChange: (id) => {
            if (this.#activeConversationReader !== id) this.#suspendConversationReader();
          },
          appearance: readConversationAppearance(context.cwd, resolveAgentDir(), context.isProjectTrusted?.() ?? false),
          ...(initialTarget ? { initialTargetId: initialTarget.id } : {}),
          state: this.#conversationState!,
          keybindings,
          rendererOptions: this.conversationRenderers,
          queueEvents: this.state.pi?.events,
          ...(this.codePreviewSettings ? { codePreviewSettings: this.codePreviewSettings } : {}),
          transcript: (id, followLatest) => readerFor(id).read(source(id), followLatest),
          loadOlder: (id) => {
            const reader = readerFor(id);
            const before = reader.read(source(id), false);
            if (!before.hasMore) return false;
            const next = reader.loadOlder();
            return !!next && (next.revision !== before.revision || !next.hasMore);
          },
          loadNewer: (id) => {
            const reader = readerFor(id);
            const before = reader.read(source(id), false);
            const next = reader.loadNewer();
            return !!next && next.revision !== before.revision;
          },
          loadLatest: (id) => {
            const reader = readerFor(id);
            const before = reader.read(source(id), false);
            const next = reader.loadLatest();
            return !!next && next.revision !== before.revision;
          },
          send: async (id, message, delivery) => {
            requireTarget(id, delivery);
            const result = await this.state.queueUserMessage(id, message, delivery);
            if (epoch === this.#epoch) this.#refresh();
            return result;
          },
          stop: async (id) => {
            requireTarget(id, "stop");
            const result = await this.state.stopParticipant(id);
            if (epoch === this.#epoch) this.#refresh();
            return result;
          },
          close: () => done(undefined),
        });
        this.#conversationView = view;
        return view;
      }, {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
      });
    } catch (error) {
      if (epoch === this.#epoch) context.ui.notify(safeText(error instanceof Error ? error.message : String(error)), "error");
    } finally {
      if (!alreadyOpen && epoch === this.#epoch) {
        this.#conversationView?.dispose();
        this.#suspendConversationReader();
        this.#conversationView = undefined;
        this.#conversationTui = undefined;
        this.#closeConversation = undefined;
        this.#conversationOpen = false;
        this.#schedulePoll(true);
      }
    }
  }

  async openDashboard(context: ExtensionContext): Promise<void> {
    if (this.ownsInput) return;
    if (context.mode !== "tui") {
      context.ui.notify("The Fabric dashboard is available in TUI mode", "warning");
      return;
    }
    if (!this.state.config.ui.enabled) {
      context.ui.notify("The Fabric UI is disabled by ui.enabled", "warning");
      return;
    }
    if (!this.#context) this.start(context);
    // Set after start(): it calls stop(), which clears this flag. The flag
    // must be true before this refresh so the first dashboard frame renders
    // from full activity runs rather than stripped summaries.
    this.#dashboardOpen = true;
    this.#refresh();
    const [{ FabricDashboard }, { buildClaudeModelSource, buildModelSource }, { imageSafeCustom }] =
      await Promise.all([import("./dashboard.js"), import("./model-picker.js"), import("./image-overlays.js")]);
    const modelSource = buildModelSource(context.modelRegistry, resolveAgentDir());
    let claudeModelSource: ModelSource | undefined;
    if (this.#snapshot.actors.some((actor) => actor.runner === "claude")) {
      try {
        claudeModelSource = buildClaudeModelSource(await this.state.agents.claudeModels());
      } catch (error) {
        context.ui.notify(
          `Claude model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }
    const reportUpdate = (message: string, update: Promise<unknown>): void => {
      void update
        .then(() => {
          context.ui.notify(message, "info");
          this.#refresh();
        })
        .catch((error) =>
          context.ui.notify(error instanceof Error ? error.message : String(error), "error"),
        );
    };
    const onTargetMessage = (
      target: FabricDashboardMessageTarget,
      message: string,
      delivery: "steer" | "followUp",
    ): void => {
      const action =
        target.kind === "actor"
          ? "Message queued for actor"
          : delivery === "steer"
            ? `Steer queued for ${target.name}`
            : `Follow-up queued for ${target.name}`;
      reportUpdate(
        action,
        this.state.queueUserMessage(target.id, message, delivery),
      );
    };
    const onAgentStop = (agentId: string): void => {
      reportUpdate("Agent stopped", this.state.stopParticipant(agentId));
    };
    const onActorModel = (
      actorId: string,
      model: string | undefined,
      scope: FabricActorBindingScope,
    ): void => {
      reportUpdate(
        scope === "project" ? "Actor project model pinned" : "Actor session model updated",
        this.state.actors.setModel(actorId, model, scope),
      );
    };
    const onActorThinking = (
      actorId: string,
      thinking: FabricThinking | undefined,
      scope: FabricActorBindingScope,
    ): void => {
      reportUpdate(
        scope === "project"
          ? "Actor project thinking pinned"
          : "Actor session thinking updated",
        this.state.actors.setThinking(actorId, thinking, scope),
      );
    };
    const onActorEvents = (actorId: string, events: FabricActorHostEvent[]): void => {
      reportUpdate("Actor event subscriptions updated", this.state.actors.setEvents(actorId, events));
    };
    const onActorDeliveryPolicy = (
      actorId: string,
      delivery: FabricActorDelivery,
      triggerTurn: boolean,
    ): void => {
      reportUpdate(
        "Actor delivery policy updated",
        this.state.actors.setDeliveryPolicy(actorId, delivery, triggerTurn),
      );
    };
    const onGlobalDeliveryPolicy = (
      actorId: string,
      delivery: FabricActorDelivery,
      triggerTurn: boolean,
    ): void => {
      try {
        this.state.globalActors.update(actorId, { delivery, triggerTurn });
        context.ui.notify("Global actor delivery policy updated", "info");
        this.#refresh();
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    };
    const onGlobalEvents = (globalActorId: string, events: FabricActorHostEvent[]): void => {
      try {
        this.state.globalActors.update(globalActorId, { events });
        context.ui.notify("Global actor event subscriptions updated", "info");
        this.#refresh();
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    };
    const onActorTools = (actorId: string, tools: string[]): void => {
      reportUpdate("Actor tools updated", this.state.actors.setTools(actorId, tools));
    };
    const onClearMessages = (actorId: string): void => {
      reportUpdate("Actor mailbox cleared", this.state.actors.clearMessages(actorId));
    };
    const onActorInstructions = (actorId: string, instructions: string): void => {
      reportUpdate("Actor instructions updated", this.state.actors.setInstructions(actorId, instructions));
    };
    const onGlobalInstructions = (globalActorId: string, instructions: string): void => {
      try {
        this.state.globalActors.update(globalActorId, { instructions });
        context.ui.notify("Global actor instructions updated", "info");
        this.#refresh();
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    };
    const onImportActor = (globalActorId: string): void => {
      try {
        // resolve() rereads the template library and throws while it cannot be read.
        const def = this.state.globalActors.resolve(globalActorId);
        if (!def) return;
        this.state.actors
          .create(this.state.globalActors.toRequest(def))
          .then((actor) => {
            context.ui.notify(`Imported global actor "${def.name}" as ${actor.name}`, "info");
            this.#refresh();
          })
          .catch((error) =>
            context.ui.notify(error instanceof Error ? error.message : String(error), "error"),
          );
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    };
    const onExportActor = (actorId: string): void => {
      try {
        const def = this.state.actors.definition(actorId);
        const template = this.state.globalActors.create(def);
        context.ui.notify(`Exported "${template.name}" to global actors`, "info");
        this.#refresh();
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    };
    const onRemoveGlobalActor = (globalActorId: string): void => {
      try {
        const result = this.state.globalActors.remove(globalActorId);
        context.ui.notify(
          result.removed ? "Removed global actor template" : "Global actor not found",
          result.removed ? "info" : "warning",
        );
        this.#refresh();
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    };
    this.#schedulePoll(true);
    let conversationTarget: string | undefined;
    const epoch = this.#epoch;
    try {
      await imageSafeCustom<void>(context.ui,
        (tui, theme, keybindings, done) => {
          this.#dashboardTui = tui;
          return new FabricDashboard(tui, theme, () => this.#snapshot, () => done(undefined), {
            modelSource,
            keybindings,
            ...(this.codePreviewSettings
              ? { codePreviewSettings: this.codePreviewSettings }
              : {}),
            ...(claudeModelSource ? { claudeModelSource } : {}),
            onTargetMessage,
            onAgentStop,
            onConversation: (id) => {
              conversationTarget = id;
              done(undefined);
            },
            agentTranscript: (agent, followLatest) =>
              this.#transcripts.read(this.#agentTranscriptSource(agent), followLatest),
            actorTranscript: (actor, followLatest) =>
              this.#transcripts.read(this.#actorTranscriptSource(actor), followLatest),
            loadOlderTranscript: (target) =>
              this.#transcripts.loadOlder(this.#transcriptSource(target)),
            loadNewerTranscript: (target) =>
              this.#transcripts.loadNewer(this.#transcriptSource(target)),
            loadLatestTranscript: (target) =>
              this.#transcripts.loadLatest(this.#transcriptSource(target)),
            onActorModel,
            onActorThinking,
            onActorEvents,
            onActorDeliveryPolicy,
            onGlobalDeliveryPolicy,
            onGlobalEvents,
            onActorTools,
            actorDefaultTools: this.state.config.agents?.defaultTools ?? [],
            onClearMessages,
            onActorInstructions,
            onGlobalInstructions,
            onImportActor,
            onExportActor,
            onRemoveGlobalActor,
          });
        },
        {
          overlay: true,
          overlayOptions: {
            width: "94%",
            minWidth: 40,
            maxHeight: "90%",
            anchor: "center",
            margin: 1,
          },
        },
      );
    } finally {
      if (epoch === this.#epoch) {
        this.#dashboardOpen = false;
        this.#dashboardTui = undefined;
        this.#refresh();
        this.#schedulePoll(true);
      }
    }
    if (conversationTarget && epoch === this.#epoch) {
      await this.openConversation(context, conversationTarget);
    }
  }

  snapshot(): FabricDashboardSnapshot {
    return structuredClone(this.#snapshot);
  }

  #schedulePoll(reset = false): void {
    if (reset && this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#timer || !this.#context) return;
    const expiryDelay = this.#widgetRetention.nextExpiryDelay(this.#snapshot, Date.now());
    const active =
      expiryDelay !== undefined ||
      this.#snapshot.shells?.some(job => job.finishedAt === undefined) ||
      this.#snapshot.runs.some((run) => run.status === "running") ||
      this.#snapshot.peers.length > 0 ||
      this.#snapshot.agents.some((agent) => isActiveStatus(agent.status)) ||
      this.#snapshot.actors.some(
        (actor) =>
          isActiveStatus(actor.status) ||
          Boolean(actor.worker && isActiveStatus(actor.worker.status)),
      );
    if (!this.ownsInput && !active) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#refresh(false);
      this.#schedulePoll();
    }, Math.min(this.state.config.ui.refreshMs, expiryDelay ?? Infinity));
    this.#timer.unref();
  }

  #scheduleRefresh(): void {
    if (this.#scheduledRefresh || !this.#context) return;
    const elapsed = performance.now() - this.#lastRefreshAt;
    const delay = Math.max(
      0,
      Math.min(ACTIVITY_REFRESH_MS, this.state.config.ui.refreshMs) - elapsed,
    );
    this.#scheduledRefresh = setTimeout(() => {
      this.#scheduledRefresh = undefined;
      this.#refresh();
      this.#schedulePoll(true);
    }, delay);
    this.#scheduledRefresh.unref();
  }

  #agentTranscriptSource(agent: FabricUiAgent): FabricTranscriptSource {
    return { id: agent.id, status: agent.status, ...(agent.logFile ? { logFile: agent.logFile } : {}) };
  }

  #actorTranscriptSource(actor: FabricUiActor): FabricTranscriptSource {
    if (actor.worker?.logFile && isActiveStatus(actor.worker.status)) {
      return {
        id: `${actor.id}:${actor.worker.id}`,
        status: actor.worker.status,
        logFile: actor.worker.logFile,
      };
    }
    const retained = actor.lastRunId && actor.logDir
      ? path.join(actor.logDir, actor.lastRunId, "events.jsonl")
      : undefined;
    if (retained) return { id: actor.id, status: actor.status, logFile: retained };
    if (actor.sessionFile) {
      return { id: actor.id, status: actor.status, logFile: actor.sessionFile };
    }
    return { id: actor.id, status: actor.status };
  }

  #transcriptSource(target: FabricUiAgent | FabricUiActor): FabricTranscriptSource {
    return "recentMessages" in target
      ? this.#actorTranscriptSource(target)
      : this.#agentTranscriptSource(target);
  }

  #suspendConversationReader(): void {
    if (!this.#activeConversationReader) return;
    const reader = this.#conversationReaders.get(this.#activeConversationReader);
    // Readers retain lightweight loaded-range bookmarks. Never clear as a
    // fallback: that would lose pinned history or unavailable-file content.
    (reader as (NativeConversationReader & { suspend?: () => void }) | undefined)?.suspend?.();
    this.#activeConversationReader = undefined;
  }

  #refresh(force = true): void {
    this.#lastRefreshAt = performance.now();
    const context = this.#context;
    if (!context || !this.state.initialized) return;
    try {
      this.#pollMesh();
      const revision =
        typeof this.state.activity.revision === "function"
          ? this.state.activity.revision()
          : undefined;
      const detailed = this.#dashboardOpen;
      if (
        revision === undefined ||
        revision !== this.#activityRevision ||
        detailed !== this.#activityRunsDetailed
      ) {
        if (!this.#activityView && typeof this.state.activity.createRunView === "function") {
          this.#activityView = this.state.activity.createRunView();
        }
        this.#activityRuns = this.#activityView
          ? this.#activityView(detailed)
          : detailed || typeof this.state.activity.runSummaries !== "function"
            ? this.state.activity.runs()
            : this.state.activity.runSummaries();
        this.#activityRevision = revision;
        this.#activityRunsDetailed = detailed;
      }
      if (force || this.#dashboardOpen) this.#snapshotCache.clear();
      this.#refreshGeneration++;
      this.#snapshot = createDashboardSnapshot(
        this.state,
        this.#events,
        context,
        this.#activityRuns,
        this.#dashboardOpen ? undefined : this.#snapshotCache,
        this.#activityView !== undefined,
      );
      this.#widgetRetention.sync(this.#snapshot);
      this.#renderWidget(context);
      // Read the native source even when manager metadata is unchanged: log
      // appends and pinned-window growth do not require a status revision.
      if (this.#conversationTui && this.#conversationView?.refresh?.() !== false) {
        this.#conversationTui.requestRender();
      }
      if (this.#dashboardTui) this.#dashboardTui.requestRender();
      else if (this.#widgetTui && this.#widget?.hasChanged()) this.#widgetTui.requestRender();
    } catch (error) {
      const now = Date.now();
      if (now - this.#lastRefreshErrorAt >= 10_000) {
        this.#lastRefreshErrorAt = now;
        const message = error instanceof Error ? error.message : String(error);
        context.ui.notify(`Fabric dashboard refresh failed: ${message}`, "warning");
      }
    }
  }

  #pollMesh(): void {
    if (!this.state.config.mesh.enabled) return;
    const result = this.state.mesh.tail(this.#meshOffset, this.state.config.ui.eventHistory);
    this.#meshOffset = result.nextOffset;
    if (result.events.length === 0) return;
    this.#events.push(...result.events);
    const limit = this.state.config.ui.eventHistory;
    if (this.#events.length > limit) this.#events.splice(0, this.#events.length - limit);
  }

  #renderWidget(context: ExtensionContext): void {
    const config = this.state.config.ui;
    const shouldShow =
      context.mode === "tui" &&
      shouldShowFabricWidget(this.#snapshot, config.widget, this.#widgetRetention);
    if (shouldShow) {
      if (this.#widgetMounted) return;
      this.#widgetMounted = true;
      context.ui.setWidget(
        WIDGET_ID,
        (tui, theme) => {
          this.#widgetTui = tui;
          // Mouse clicks focus the widget without a shortcut, so remember the editor up front.
          const focused = (tui as TUI & { getFocusedComponent?(): unknown }).getFocusedComponent?.();
          if (focused) this.#widgetReturnFocus = focused as Component;
          this.#widget = new FabricWidget(
            theme,
            () => this.#snapshot,
            config.maxRows,
            () => tui.terminal?.rows ?? process.stdout.rows,
            this.#widgetRetention,
            {
              activity: (row) => {
                const target = row.kind === "actor"
                  ? this.#snapshot.actors.find((actor) => actor.id === row.id)
                  : this.#snapshot.agents.find((agent) => agent.id === row.id);
                return target ? this.#widgetTranscripts.read(this.#transcriptSource(target)) : undefined;
              },
              release: (forward) => this.#releaseWidget(forward),
              requestRender: () => tui.requestRender(),
              hideThinking: () => this.#widgetHidesThinking(context, tui),
            },
          );
          return this.#widget;
        },
        { placement: "aboveEditor" },
      );
      return;
    }
    if (!this.#widgetMounted) return;
    this.#releaseWidget();
    context.ui.setWidget(WIDGET_ID, undefined);
    this.#widgetMounted = false;
    this.#widgetTui = undefined;
    this.#widget = undefined;
  }
}
