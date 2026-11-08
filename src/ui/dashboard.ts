import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodePreviewSettings } from "./code-preview.js";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import {
  getKeybindings,
  Key,
  matchesKey,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { truncateStyledText as truncateToWidth } from "./truncate.js";
import type { FabricActivityRun } from "../activity/types.js";
import type { FabricAgentMessageDelivery } from "../main-agent.js";
import type {
  FabricActorBindingScope,
  FabricActorDelivery,
  FabricActorHostEvent,
} from "../actors/types.js";
import { isFabricThinking, type FabricThinking } from "../thinking.js";
import {
  entitiesForOverview,
  filters,
  groupEntities,
  matchesFilter,
  phasePanels,
  tokensFor,
  type Entity,
  type EntityGroup,
  type OverviewView,
  type Pane,
  type PhasePanel,
  type StatusFilter,
} from "./dashboard-model.js";
import { colorStatus, entityTail, statusGlyph } from "./dashboard-presentation.js";
import {
  DashboardDetailRenderer,
  type FabricTranscriptTarget,
} from "./dashboard-detail.js";
import { renderFabricTopologyPanel } from "./dashboard-fabric-graph.js";
import { DashboardGraphController } from "./dashboard-graph-controller.js";
import { DashboardModalController, type DashboardModalContent } from "./dashboard-modal-controller.js";
import { FabricHostEventSelector } from "./fabric-host-event-selector.js";
import { FabricActorDeliverySelector } from "./fabric-actor-delivery-selector.js";
import { FabricActorToolSelector } from "./fabric-actor-tool-selector.js";
import { FabricModelSelector } from "./fabric-model-selector.js";
import { FabricThinkingSelector } from "./fabric-thinking-selector.js";
import {
  formatClock,
  formatDuration,
  formatTokens,
  padToWidth,
  safeText,
  wrapPlainText,
} from "./format.js";
import { INHERIT_VALUE, type ModelSource } from "./model-picker.js";
import {
  buildProjectMeshTopology,
  type FabricProjectMeshModel,
} from "./topology.js";
import type { FabricAgentTranscript } from "./transcript.js";
import type { FabricDashboardSnapshot, FabricUiActor, FabricUiAgent } from "./types.js";
import { isActiveStatus } from "./types.js";

const DASHBOARD_OVERLAY_HEIGHT_PERCENT = 90;
const DASHBOARD_OVERLAY_VERTICAL_MARGIN = 1;

const dashboardOverlayRows = (terminalRows: number): number =>
  Math.max(
    1,
    Math.min(
      Math.floor((terminalRows * DASHBOARD_OVERLAY_HEIGHT_PERCENT) / 100),
      terminalRows - DASHBOARD_OVERLAY_VERTICAL_MARGIN * 2,
    ),
  );

export interface FabricDashboardMessageTarget {
  id: string;
  name: string;
  kind: "main" | "peer" | "agent" | "actor" | "meshParticipant";
}

interface FabricDashboardKeybindings {
  matches(data: string, keybinding: "app.tools.expand"): boolean;
  getKeys(keybinding: "app.tools.expand"): string[];
}

export class FabricDashboard implements Component, Focusable {
  focused = false;
  private pane: Pane = "phases";
  private overviewView: OverviewView = "activity";
  private readonly graph = new DashboardGraphController(() => this.tui.requestRender());
  private phaseIndex = 0;
  private entityIndex = 0;
  private runIndex = 0;
  private selectedRunId: string | undefined;
  private runSelectionTouched = false;
  private selectedEntityId: string | undefined;
  private filter: StatusFilter = "all";
  private phaseSelectionTouched = false;
  private selectedPhaseId: string | undefined;
  private detailId: string | undefined;
  private detailScroll = 0;
  private detailMaxScroll = 0;
  private transcriptPageAnchor: "start" | "end" | undefined;
  private transcriptToolsExpanded = false;
  private detailSelectionRestore:
    | { runSelectionTouched: boolean; phaseSelectionTouched: boolean }
    | undefined;
  private detailView: "summary" | "transcript" = "summary";
  private transcriptFollowing = true;
  private readonly detailRenderer: DashboardDetailRenderer;
  private readonly highlightInvalidate = (): void => this.tui.requestRender();
  private mode: "overview" | "detail" | "help" = "overview";
  private readonly modal: DashboardModalController;
  private pendingStop: { id: string; expiresAt: number } | undefined;
  private readonly modelSource: ModelSource | undefined;
  private readonly claudeModelSource: ModelSource | undefined;
  private readonly onAgentSteer: ((agentId: string, message: string) => void) | undefined;
  private readonly onAgentFollowUp: ((agentId: string, message: string) => void) | undefined;
  private readonly onAgentStop: ((agentId: string) => void) | undefined;
  private readonly onConversation: ((id: string) => void) | undefined;
  private readonly onTargetMessage:
    | ((
        target: FabricDashboardMessageTarget,
        message: string,
        delivery: FabricAgentMessageDelivery,
      ) => void)
    | undefined;
  private readonly agentTranscript:
    | ((agent: FabricUiAgent, followLatest: boolean) => FabricAgentTranscript)
    | undefined;
  private readonly actorTranscript:
    | ((actor: FabricUiActor, followLatest: boolean) => FabricAgentTranscript)
    | undefined;
  private readonly loadOlderTranscript: ((target: FabricTranscriptTarget) => boolean) | undefined;
  private readonly loadNewerTranscript: ((target: FabricTranscriptTarget) => boolean) | undefined;
  private readonly loadLatestTranscript: ((target: FabricTranscriptTarget) => boolean) | undefined;
  private readonly onActorModel:
    | ((
        actorId: string,
        model: string | undefined,
        scope: FabricActorBindingScope,
      ) => void)
    | undefined;
  private readonly onActorThinking:
    | ((
        actorId: string,
        thinking: FabricThinking | undefined,
        scope: FabricActorBindingScope,
      ) => void)
    | undefined;
  private readonly onActorEvents:
    | ((actorId: string, events: FabricActorHostEvent[]) => void)
    | undefined;
  private readonly onActorDeliveryPolicy:
    | ((actorId: string, delivery: FabricActorDelivery, triggerTurn: boolean) => void)
    | undefined;
  private readonly onGlobalDeliveryPolicy:
    | ((actorId: string, delivery: FabricActorDelivery, triggerTurn: boolean) => void)
    | undefined;
  private readonly onGlobalEvents:
    | ((globalActorId: string, events: FabricActorHostEvent[]) => void)
    | undefined;
  private readonly onActorTools: ((actorId: string, tools: string[]) => void) | undefined;
  private readonly actorDefaultTools: string[];
  private readonly onClearMessages: ((actorId: string) => void) | undefined;
  private readonly onActorInstructions:
    | ((actorId: string, instructions: string) => void)
    | undefined;
  private readonly onGlobalInstructions:
    | ((globalActorId: string, instructions: string) => void)
    | undefined;
  private readonly onImportActor: ((globalActorId: string) => void) | undefined;
  private readonly onExportActor: ((actorId: string) => void) | undefined;
  private readonly onRemoveGlobalActor: ((globalActorId: string) => void) | undefined;
  private readonly codePreviewSettings: CodePreviewSettings | undefined;
  private readonly keybindings: FabricDashboardKeybindings | undefined;

  constructor(
    readonly tui: TUI,
    readonly theme: Theme,
    readonly snapshot: () => FabricDashboardSnapshot,
    readonly done: () => void,
    options: {
      modelSource?: ModelSource;
      codePreviewSettings?: CodePreviewSettings;
      keybindings?: FabricDashboardKeybindings;
      claudeModelSource?: ModelSource;
      onAgentSteer?: (agentId: string, message: string) => void;
      onAgentFollowUp?: (agentId: string, message: string) => void;
      onAgentStop?: (agentId: string) => void;
      onConversation?: (id: string) => void;
      onTargetMessage?: (
        target: FabricDashboardMessageTarget,
        message: string,
        delivery: FabricAgentMessageDelivery,
      ) => void;
      agentTranscript?: (
        agent: FabricUiAgent,
        followLatest: boolean,
      ) => FabricAgentTranscript;
      actorTranscript?: (
        actor: FabricUiActor,
        followLatest: boolean,
      ) => FabricAgentTranscript;
      loadOlderTranscript?: (target: FabricTranscriptTarget) => boolean;
      loadNewerTranscript?: (target: FabricTranscriptTarget) => boolean;
      loadLatestTranscript?: (target: FabricTranscriptTarget) => boolean;
      onActorModel?: (
        actorId: string,
        model: string | undefined,
        scope: FabricActorBindingScope,
      ) => void;
      onActorThinking?: (
        actorId: string,
        thinking: FabricThinking | undefined,
        scope: FabricActorBindingScope,
      ) => void;
      onActorEvents?: (actorId: string, events: FabricActorHostEvent[]) => void;
      onActorDeliveryPolicy?: (
        actorId: string,
        delivery: FabricActorDelivery,
        triggerTurn: boolean,
      ) => void;
      onGlobalDeliveryPolicy?: (
        actorId: string,
        delivery: FabricActorDelivery,
        triggerTurn: boolean,
      ) => void;
      onGlobalEvents?: (globalActorId: string, events: FabricActorHostEvent[]) => void;
      onActorTools?: (actorId: string, tools: string[]) => void;
      actorDefaultTools?: string[];
      onClearMessages?: (actorId: string) => void;
      onActorInstructions?: (actorId: string, instructions: string) => void;
      onGlobalInstructions?: (globalActorId: string, instructions: string) => void;
      onImportActor?: (globalActorId: string) => void;
      onExportActor?: (actorId: string) => void;
      onRemoveGlobalActor?: (globalActorId: string) => void;
    } = {},
  ) {
    this.focused = true;
    this.modal = new DashboardModalController(tui, theme);
    this.modelSource = options.modelSource;
    this.codePreviewSettings = options.codePreviewSettings;
    this.keybindings = options.keybindings;
    this.claudeModelSource = options.claudeModelSource;
    this.onAgentSteer = options.onAgentSteer;
    this.onAgentFollowUp = options.onAgentFollowUp;
    this.onAgentStop = options.onAgentStop;
    this.onConversation = options.onConversation;
    this.onTargetMessage = options.onTargetMessage;
    this.agentTranscript = options.agentTranscript;
    this.actorTranscript = options.actorTranscript;
    this.loadOlderTranscript = options.loadOlderTranscript;
    this.loadNewerTranscript = options.loadNewerTranscript;
    this.loadLatestTranscript = options.loadLatestTranscript;
    this.onActorModel = options.onActorModel;
    this.onActorThinking = options.onActorThinking;
    this.onActorEvents = options.onActorEvents;
    this.onGlobalEvents = options.onGlobalEvents;
    this.onActorDeliveryPolicy = options.onActorDeliveryPolicy;
    this.onGlobalDeliveryPolicy = options.onGlobalDeliveryPolicy;
    this.onActorTools = options.onActorTools;
    this.actorDefaultTools = options.actorDefaultTools ?? [];
    this.onClearMessages = options.onClearMessages;
    this.onActorInstructions = options.onActorInstructions;
    this.onGlobalInstructions = options.onGlobalInstructions;
    this.onImportActor = options.onImportActor;
    this.onExportActor = options.onExportActor;
    this.onRemoveGlobalActor = options.onRemoveGlobalActor;
    this.detailRenderer = new DashboardDetailRenderer(tui, theme, snapshot, {
      agentTranscript: this.agentTranscript,
      actorTranscript: this.actorTranscript,
      codePreviewSettings: this.codePreviewSettings,
      actorDefaultTools: this.actorDefaultTools,
    });
  }

  handleInput(data: string): void {
    if (this.mode === "help") {
      if (
        data === "?" ||
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c"))
      ) {
        this.mode = this.detailId ? "detail" : "overview";
      }
      this.tui.requestRender();
      return;
    }
    if (this.modal.handleInput(data)) return;

    const snapshot = this.snapshot();
    const run = this.selectRun(snapshot);
    const panels = phasePanels(snapshot, run);
    this.syncPhase(run, panels);
    const panel = panels[this.phaseIndex];
    const projectMesh = this.projectMesh(snapshot);
    const allEntities = entitiesForOverview(
      snapshot,
      run,
      panel,
      this.overviewView,
      projectMesh,
    );
    const entities = allEntities.filter(
      (entity) => entity.kind === "main" || matchesFilter(entity.status, this.filter),
    );
    this.syncEntitySelection(entities, this.overviewView !== "activity");

    if (data === "C" && this.onConversation) {
      const entity = this.detailId
        ? allEntities.find((candidate) => candidate.id === this.detailId)
        : entities[this.entityIndex];
      const target = entity ? this.messageTarget(entity) : undefined;
      if (target) this.onConversation(target.id);
      return;
    }

    if (data === "?") {
      this.mode = "help";
      this.tui.requestRender();
      return;
    }

    if (this.detailId) {
      if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c")) ||
        matchesKey(data, Key.left) ||
        data === "h"
      ) {
        this.closeDetail();
      } else if (data === "t") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (detail && this.hasTranscript(detail)) {
          this.detailView = this.detailView === "summary" ? "transcript" : "summary";
          this.detailScroll = 0;
          this.transcriptPageAnchor = undefined;
          this.transcriptFollowing = true;
        }
      } else if (
        this.detailView === "transcript" &&
        this.matchesTranscriptToolToggle(data)
      ) {
        this.transcriptToolsExpanded = !this.transcriptToolsExpanded;
      } else if (matchesKey(data, Key.up) || data === "k") {
        if (this.detailScroll > 0) {
          if (this.detailView === "transcript") this.transcriptFollowing = false;
          this.detailScroll--;
        } else if (this.detailView === "transcript") {
          const detail = allEntities.find((entity) => entity.id === this.detailId);
          const target = detail ? this.transcriptTarget(detail) : undefined;
          if (target && this.loadOlderTranscript?.(target)) {
            this.transcriptPageAnchor = "end";
            this.transcriptFollowing = false;
          }
        }
      } else if (matchesKey(data, Key.down) || data === "j") {
        if (this.detailScroll < this.detailMaxScroll) {
          if (this.detailView === "transcript") this.transcriptFollowing = false;
          this.detailScroll++;
        } else if (this.detailView === "transcript") {
          const detail = allEntities.find((entity) => entity.id === this.detailId);
          const target = detail ? this.transcriptTarget(detail) : undefined;
          if (target && this.loadNewerTranscript?.(target)) {
            this.transcriptPageAnchor = "start";
            this.transcriptFollowing = false;
          }
        }
      } else if (data === "G" && this.detailView === "transcript") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        const target = detail ? this.transcriptTarget(detail) : undefined;
        if (target) this.loadLatestTranscript?.(target);
        this.transcriptPageAnchor = undefined;
        this.transcriptFollowing = true;
        this.detailScroll = this.detailMaxScroll;
      } else if (matchesKey(data, Key.home) || data === "g") {
        if (this.detailView === "transcript") {
          this.transcriptPageAnchor = undefined;
          this.transcriptFollowing = false;
        }
        this.detailScroll = 0;
      } else if (data === "s" || data === "u") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        const delivery = data === "s" ? "steer" : "followUp";
        if (detail && this.canMessage(detail, delivery)) {
          this.openAgentMessageEditor(detail, delivery);
        }
      } else if (data === "m" || data === "M") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (
          detail &&
          detail.kind === "actor" &&
          detail.status !== "stopped" &&
          (data === "m" || detail.value.local !== false)
        ) {
          this.openModelPicker(detail, data === "M" ? "project" : "session");
        }
      } else if (data === "e" || data === "E") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (
          detail &&
          detail.kind === "actor" &&
          detail.status !== "stopped" &&
          (data === "e" || detail.value.local !== false)
        ) {
          this.openThinkingPicker(detail, data === "E" ? "project" : "session");
        }
      } else if (data === "y") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (
          detail &&
          (detail.kind === "globalActor" ||
            (detail.kind === "actor" && detail.value.local !== false))
        ) {
          this.openDeliveryPicker(detail);
        }
      } else if (data === "v") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (detail?.kind === "globalActor") {
          this.openEventsPicker(detail);
        } else if (
          detail &&
          detail.kind === "actor" &&
          detail.status !== "stopped" &&
          detail.value.local !== false
        ) {
          this.openEventsPicker(detail);
        }
      } else if (data === "o") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (
          detail &&
          detail.kind === "actor" &&
          detail.status !== "stopped" &&
          detail.value.local !== false
        ) {
          this.openToolsPicker(detail);
        }
      } else if (data === "c") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (
          detail &&
          detail.kind === "actor" &&
          detail.status !== "stopped" &&
          detail.value.local !== false &&
          this.onClearMessages
        ) {
          this.onClearMessages(detail.value.id);
        }
      } else if (data === "i") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (
          detail &&
          (detail.kind === "globalActor" ||
            (detail.kind === "actor" && detail.value.local !== false))
        ) {
          this.openInstructionsEditor(detail);
        }
      } else if (data === "x") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (detail && this.canStop(detail)) {
          this.requestParticipantStop(detail);
        } else if (
          detail &&
          detail.kind === "actor" &&
          detail.status !== "stopped" &&
          this.onExportActor
        ) {
          this.onExportActor(detail.value.id);
        }
      } else if (data === "p") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (detail && detail.kind === "globalActor" && this.onImportActor) {
          this.onImportActor(detail.value.id);
        }
      } else if (data === "d") {
        const detail = allEntities.find((entity) => entity.id === this.detailId);
        if (detail && detail.kind === "globalActor" && this.onRemoveGlobalActor) {
          this.onRemoveGlobalActor(detail.value.id);
        }
      }
      this.tui.requestRender();
      return;
    }

    if (data === "1" || data === "2") {
      const nextOverview: OverviewView = data === "1" ? "activity" : "topology";
      if (nextOverview !== this.overviewView) {
        if (nextOverview === "activity") {
          this.graph.stopCameraAnimation();
          this.graph.stopEffectsAnimation();
        }
        this.overviewView = nextOverview;
        this.pane = nextOverview === "activity" ? "phases" : "entities";
        this.entityIndex = 0;
        this.selectedEntityId = undefined;
        this.pendingStop = undefined;
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (this.overviewView === "activity" && this.pane === "entities") {
        this.pane = "phases";
      } else {
        this.done();
        return;
      }
    } else if (this.overviewView === "topology" && data === "r") {
      this.graph.toggleReplay(snapshot.events, (projectMesh ?? this.projectMesh(snapshot))?.routes ?? []);
      this.graph.startEffectsAnimation();
      this.tui.requestRender();
      return;
    } else if (
      this.overviewView === "topology" &&
      this.graph.replayIndex !== undefined &&
      data === " "
    ) {
      this.graph.togglePlayback();
      this.graph.startEffectsAnimation();
      this.tui.requestRender();
      return;
    } else if (
      this.overviewView === "topology" &&
      this.graph.replayIndex !== undefined &&
      (matchesKey(data, Key.left) || matchesKey(data, Key.right))
    ) {
      this.graph.stepReplay(matchesKey(data, Key.left) ? -1 : 1);
      this.tui.requestRender();
      return;
    } else if (this.overviewView === "topology" && (data === "+" || data === "=" || data === "-")) {
      this.graph.changeReplaySpeed(data === "-" ? -1 : 1);
      this.tui.requestRender();
      return;
    } else if (this.overviewView === "topology" && data === "H") {
      this.graph.toggleHistory();
      this.tui.requestRender();
      return;
    } else if (this.overviewView === "topology" && data === "M") {
      const selected = this.pane === "entities" ? entities[this.entityIndex] : undefined;
      if (
        selected?.kind === "actor" &&
        selected.status !== "stopped" &&
        selected.value.local !== false &&
        this.modelSourceForActor(selected.value) &&
        this.onActorModel
      ) {
        this.detailId = selected.id;
        this.openModelPicker(selected, "project");
      } else {
        this.graph.toggleReducedMotion();
      }
      this.tui.requestRender();
      return;
    } else if (
      this.overviewView === "topology" &&
      (matchesKey(data, Key.left) || matchesKey(data, Key.right) ||
        matchesKey(data, Key.up) || matchesKey(data, Key.down) || data === "h" || data === "l")
    ) {
      const direction =
        matchesKey(data, Key.left) || data === "h"
          ? "left"
          : matchesKey(data, Key.right) || data === "l"
            ? "right"
            : matchesKey(data, Key.up)
              ? "up"
              : "down";
      const target = this.graph.directionalTarget(this.selectedEntityId, direction);
      const targetIndex = target ? entities.findIndex((entity) => entity.id === target) : -1;
      if (targetIndex >= 0) {
        this.entityIndex = targetIndex;
        this.selectedEntityId = target;
        this.pendingStop = undefined;
      }
      this.tui.requestRender();
      return;
    } else if (matchesKey(data, Key.tab) && this.overviewView === "topology") {
      this.entityIndex = entities.length > 0 ? (this.entityIndex + 1) % entities.length : 0;
      this.selectedEntityId = entities[this.entityIndex]?.id;
      this.pendingStop = undefined;
      this.tui.requestRender();
      return;
    } else if (matchesKey(data, Key.tab) && this.overviewView === "activity") {
      this.pane = this.pane === "phases" ? "entities" : "phases";
    } else if (
      this.overviewView === "activity" &&
      (matchesKey(data, Key.left) || data === "h")
    ) {
      this.pane = "phases";
    } else if (
      this.overviewView === "activity" &&
      (matchesKey(data, Key.right) || data === "l")
    ) {
      this.pane = "entities";
    } else if (matchesKey(data, Key.up) || data === "k") {
      if (this.overviewView === "activity" && this.pane === "phases") {
        this.phaseIndex = Math.max(0, this.phaseIndex - 1);
        this.phaseSelectionTouched = true;
        this.entityIndex = 0;
        this.selectedEntityId = undefined;
      } else {
        this.entityIndex = Math.max(0, this.entityIndex - 1);
      }
    } else if (matchesKey(data, Key.down) || data === "j") {
      if (this.overviewView === "activity" && this.pane === "phases") {
        this.phaseIndex = Math.min(Math.max(0, panels.length - 1), this.phaseIndex + 1);
        this.phaseSelectionTouched = true;
        this.entityIndex = 0;
        this.selectedEntityId = undefined;
      } else {
        this.entityIndex = Math.min(Math.max(0, entities.length - 1), this.entityIndex + 1);
      }
    } else if (
      ["m", "M", "e", "E", "y", "v", "o", "i", "c", "s", "u", "x", "p", "d"].includes(data) &&
      this.pane === "entities"
    ) {
      const selected = entities[this.entityIndex];
      if (selected) {
        if (
          (data === "s" || data === "u") &&
          this.canMessage(selected, data === "s" ? "steer" : "followUp")
        ) {
          this.detailId = selected.id;
          this.openAgentMessageEditor(selected, data === "s" ? "steer" : "followUp");
        } else if (data === "x" && this.canStop(selected)) {
          this.requestParticipantStop(selected);
        } else if (
          data === "x" &&
          selected.kind === "actor" &&
          selected.status !== "stopped" &&
          this.onExportActor
        ) {
          this.onExportActor(selected.value.id);
        } else if (
          (data === "m" || data === "M") &&
          selected.kind === "actor" &&
          selected.status !== "stopped" &&
          (data === "m" || selected.value.local !== false)
        ) {
          this.detailId = selected.id;
          this.openModelPicker(selected, data === "M" ? "project" : "session");
        } else if (
          (data === "e" || data === "E") &&
          selected.kind === "actor" &&
          selected.status !== "stopped" &&
          (data === "e" || selected.value.local !== false)
        ) {
          this.detailId = selected.id;
          this.openThinkingPicker(selected, data === "E" ? "project" : "session");
        } else if (
          data === "y" &&
          (selected.kind === "globalActor" ||
            (selected.kind === "actor" &&
              selected.status !== "stopped" &&
              selected.value.local !== false))
        ) {
          this.detailId = selected.id;
          this.openDeliveryPicker(selected);
        } else if (data === "v" && selected.kind === "globalActor") {
          this.detailId = selected.id;
          this.openEventsPicker(selected);
        } else if (
          data === "v" &&
          selected.kind === "actor" &&
          selected.status !== "stopped" &&
          selected.value.local !== false
        ) {
          this.detailId = selected.id;
          this.openEventsPicker(selected);
        } else if (
          data === "o" &&
          selected.kind === "actor" &&
          selected.status !== "stopped" &&
          selected.value.local !== false
        ) {
          this.detailId = selected.id;
          this.openToolsPicker(selected);
        } else if (
          data === "c" &&
          selected.kind === "actor" &&
          selected.status !== "stopped" &&
          selected.value.local !== false &&
          this.onClearMessages
        ) {
          this.onClearMessages(selected.value.id);
        } else if (
          data === "i" &&
          (selected.kind === "globalActor" ||
            (selected.kind === "actor" && selected.value.local !== false))
        ) {
          this.detailId = selected.id;
          this.openInstructionsEditor(selected);
        } else if (data === "p" && selected.kind === "globalActor" && this.onImportActor) {
          this.onImportActor(selected.value.id);
        } else if (data === "d" && selected.kind === "globalActor" && this.onRemoveGlobalActor) {
          this.onRemoveGlobalActor(selected.value.id);
        }
      }
    } else if (data === " " && this.pane === "entities") {
      const selected = entities[this.entityIndex];
      if (selected && this.hasTranscript(selected)) {
        this.detailId = selected.id;
        this.detailView = "transcript";
        this.detailScroll = 0;
        this.transcriptPageAnchor = undefined;
        this.transcriptFollowing = true;
      }
    } else if (matchesKey(data, Key.enter)) {
      if (this.overviewView === "activity" && this.pane === "phases") {
        this.pane = "entities";
      } else {
        const selected = entities[this.entityIndex];
        if (selected) {
          this.detailId = selected.id;
          this.detailView = "summary";
          this.detailScroll = 0;
          this.transcriptFollowing = true;
        }
      }
    } else if (data === "f") {
      const next = (filters.indexOf(this.filter) + 1) % filters.length;
      this.filter = filters[next] ?? "all";
      this.entityIndex = 0;
      this.selectedEntityId = undefined;
      this.tui.requestRender();
      return;
    } else if (data === "[") {
      this.runIndex = Math.min(Math.max(0, snapshot.runs.length - 1), this.runIndex + 1);
      this.selectedRunId = snapshot.runs[this.runIndex]?.id;
      this.runSelectionTouched = true;
      this.resetSelection();
      this.tui.requestRender();
      return;
    } else if (data === "]") {
      this.runIndex = Math.max(0, this.runIndex - 1);
      this.selectedRunId = snapshot.runs[this.runIndex]?.id;
      this.runSelectionTouched = true;
      this.resetSelection();
      this.tui.requestRender();
      return;
    } else if (data === "G") {
      if (this.overviewView === "activity" && this.pane === "phases") {
        this.phaseIndex = Math.max(0, panels.length - 1);
        this.phaseSelectionTouched = true;
        this.entityIndex = 0;
        this.selectedEntityId = undefined;
      } else {
        this.entityIndex = Math.max(0, entities.length - 1);
      }
    } else if (data === "g") {
      if (this.overviewView === "activity" && this.pane === "phases") {
        this.phaseIndex = 0;
        this.phaseSelectionTouched = true;
        this.entityIndex = 0;
        this.selectedEntityId = undefined;
      } else {
        this.entityIndex = 0;
      }
    }
    if (this.phaseSelectionTouched) this.selectedPhaseId = panels[this.phaseIndex]?.id;
    if (this.detailId) {
      this.pinDetailSelection(run, panel, this.overviewView === "activity");
    }
    if (this.pane === "entities") {
      this.selectedEntityId = entities[this.entityIndex]?.id;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.mode === "help") return this.renderHelp(width);
    const modal = this.modal.render(width, (w, content) => this.renderModal(w, content));
    if (modal) return modal;
    const snapshot = this.snapshot();
    const run = this.selectRun(snapshot);
    const panels = phasePanels(snapshot, run);
    this.syncPhase(run, panels);
    const panel = panels[this.phaseIndex];
    const projectMesh = this.projectMesh(snapshot);
    const allEntities = entitiesForOverview(
      snapshot,
      run,
      panel,
      this.overviewView,
      projectMesh,
    );
    const entities = allEntities.filter(
      (entity) => entity.kind === "main" || matchesFilter(entity.status, this.filter),
    );
    this.syncEntitySelection(entities, this.overviewView !== "activity");
    if (this.detailId) {
      const detail = allEntities.find((entity) => entity.id === this.detailId);
      if (detail) return this.renderDetail(width, snapshot, detail);
      this.closeDetail();
    }
    return this.renderOverview(
      width,
      snapshot,
      run,
      panels,
      entities,
      allEntities,
      projectMesh,
    );
  }

  invalidate(): void {
    this.detailRenderer.invalidate();
  }

  dispose(): void {
    this.modal.dispose();
    this.pendingStop = undefined;
    this.graph.stopCameraAnimation();
    this.graph.stopEffectsAnimation();
    this.detailRenderer.invalidate();
    this.mode = "overview";
  }

  private transcriptTarget(entity: Entity): FabricTranscriptTarget | undefined {
    if (entity.kind === "agent" || entity.kind === "actor") return entity.value;
    return undefined;
  }

  private hasTranscript(entity: Entity): boolean {
    return (
      (entity.kind === "agent" && this.agentTranscript !== undefined) ||
      (entity.kind === "actor" && this.actorTranscript !== undefined)
    );
  }

  private matchesTranscriptToolToggle(data: string): boolean {
    if (this.keybindings) return this.keybindings.matches(data, "app.tools.expand");
    const keybindings = getKeybindings();
    const keys = keybindings.getKeys("app.tools.expand");
    return keys.length > 0
      ? keybindings.matches(data, "app.tools.expand")
      : matchesKey(data, Key.ctrl("o"));
  }

  private transcriptToolToggleHint(): string {
    const keys = (this.keybindings ?? getKeybindings()).getKeys("app.tools.expand");
    const key = keys.length > 0 ? keys.join("/") : this.keybindings ? "unbound" : "ctrl+o";
    return `${key} ${this.transcriptToolsExpanded ? "collapse" : "expand"} tools`;
  }

  private messageTarget(entity: Entity): FabricDashboardMessageTarget | undefined {
    if (entity.kind === "main") {
      return { id: entity.value.id, name: "Main", kind: "main" };
    }
    if (entity.kind === "peer") {
      return { id: entity.value.id, name: entity.value.name, kind: "peer" };
    }
    if (entity.kind === "agent") {
      return { id: entity.value.id, name: entity.value.name, kind: "agent" };
    }
    if (entity.kind === "actor") {
      return { id: entity.value.id, name: entity.value.name, kind: "actor" };
    }
    if (entity.kind === "meshParticipant") {
      return { id: entity.value.id, name: entity.value.name, kind: "meshParticipant" };
    }
    return undefined;
  }

  private canMessage(entity: Entity, delivery: FabricAgentMessageDelivery): boolean {
    const target = this.messageTarget(entity);
    if (!target) return false;
    if (target.kind === "agent") {
      if (!isActiveStatus(entity.status)) return false;
      if (
        entity.kind === "agent" &&
        entity.value.capabilities &&
        !entity.value.capabilities.includes(delivery)
      ) {
        return false;
      }
      return Boolean(
        this.onTargetMessage ||
          (delivery === "steer" ? this.onAgentSteer : this.onAgentFollowUp),
      );
    }
    if (!this.onTargetMessage) return false;
    if (target.kind === "actor") return entity.status !== "stopped" && delivery === "steer";
    if (target.kind === "meshParticipant" && entity.kind === "meshParticipant") {
      const participant = entity.value.participant;
      return participant
        ? !participant.stale && participant.capabilities.includes(delivery)
        : true;
    }
    return true;
  }

  private openAgentMessageEditor(
    entity: Entity,
    delivery: FabricAgentMessageDelivery,
  ): void {
    const target = this.messageTarget(entity);
    if (!target || !this.canMessage(entity, delivery)) return;
    this.modal.openMessage(target, delivery, (message) => {
      if (this.onTargetMessage) {
        this.onTargetMessage(target, message, delivery);
      } else if (target.kind === "agent") {
        if (delivery === "steer") this.onAgentSteer?.(target.id, message);
        else this.onAgentFollowUp?.(target.id, message);
      }
    }, () => { this.mode = this.detailId ? "detail" : "overview"; });
  }

  private canStop(entity: Entity): entity is Extract<
    Entity,
    { kind: "agent" } | { kind: "meshParticipant" }
  > {
    if (!this.onAgentStop) return false;
    if (entity.kind === "agent") {
      return (
        isActiveStatus(entity.status) &&
        (!entity.value.capabilities || entity.value.capabilities.includes("stop"))
      );
    }
    if (entity.kind === "meshParticipant") {
      const participant = entity.value.participant;
      return Boolean(
        participant &&
          !participant.stale &&
          participant.capabilities.includes("stop"),
      );
    }
    return false;
  }

  private requestParticipantStop(
    entity: Extract<Entity, { kind: "agent" } | { kind: "meshParticipant" }>,
  ): void {
    if (!this.onAgentStop || !this.canStop(entity)) return;
    const now = Date.now();
    if (this.pendingStop?.id === entity.value.id && this.pendingStop.expiresAt > now) {
      this.pendingStop = undefined;
      this.onAgentStop(entity.value.id);
      return;
    }
    this.pendingStop = { id: entity.value.id, expiresAt: now + 2_000 };
  }

  private renderModal(width: number, content: DashboardModalContent): string[] {
    if (width < 24) return this.renderNarrowFallback(width, content.narrowTitle, "esc cancel");
    const lines = [this.topBorder(width, content.title)];
    for (const line of content.render(width - 2)) lines.push(this.row(width, line));
    lines.push(this.middleBorder(width));
    lines.push(this.row(width, this.theme.fg("dim", content.hint)));
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private renderHelp(width: number): string[] {
    if (width < 24) return this.renderNarrowFallback(width, "dashboard help", "? or esc close");
    const lines = [this.topBorder(width, "Fabric dashboard help")];
    const mainActions = [
      this.onTargetMessage ? "s message/steer" : undefined,
      this.onTargetMessage ? "u queue follow-up" : undefined,
      "enter details",
    ].filter((value): value is string => Boolean(value));
    const agentActions = [
      this.agentTranscript ? "space transcript peek" : undefined,
      this.onTargetMessage || this.onAgentSteer ? "s steer now" : undefined,
      this.onTargetMessage || this.onAgentFollowUp ? "u queue follow-up" : undefined,
      this.onAgentStop ? "x twice stop" : undefined,
      "enter details",
    ].filter((value): value is string => Boolean(value));
    const actorActions = [
      this.actorTranscript ? "space transcript peek" : undefined,
      this.onTargetMessage ? "s queue message" : undefined,
      (this.modelSource || this.claudeModelSource) && this.onActorModel ? "m session model · M pin model" : undefined,
      this.onActorThinking ? "e session thinking · E pin thinking" : undefined,
      this.onActorDeliveryPolicy ? "y delivery policy" : undefined,
      this.onActorEvents ? "v events" : undefined,
      this.onActorTools ? "o tools" : undefined,
      this.onActorInstructions ? "i instructions" : undefined,
      this.onClearMessages ? "c clear mailbox" : undefined,
      this.onExportActor ? "x export" : undefined,
    ].filter((value): value is string => Boolean(value));
    const templateActions = [
      this.onGlobalDeliveryPolicy ? "y delivery policy" : undefined,
      this.onGlobalInstructions ? "i instructions" : undefined,
      this.onImportActor ? "p import" : undefined,
      this.onRemoveGlobalActor ? "d delete" : undefined,
    ].filter((value): value is string => Boolean(value));
    const help = [
      ["Navigate", "Topology: arrows/h/l move spatially · j/k ordered selection · tab next · enter inspect · esc back"],
      ["Views", "1 Activity · 2 unified Topology"],
      ...(this.onConversation ? [["Chat", "Shift+C opens the selected participant conversation · Esc returns to Main"]] : []),
      ["Topology", "Main branches into Participants (sessions, agents, actors) and Mesh (namespaced topics and hierarchical state); traffic travels on decaying edges"],
      ["Motion", "r replay/live · space pause/play · ←/→ step · +/- speed · H history · M reduced motion (pins the model on an editable actor row)"],
      ["Runs", "[ older · ] newer · f cycle status filter"],
      ...(mainActions.length > 1 ? [["Main", mainActions.join(" · ")]] : []),
      ...(agentActions.length > 1 ? [["Agents", agentActions.join(" · ")]] : []),
      ...(actorActions.length > 0 ? [["Actors", actorActions.join(" · ")]] : []),
      ...(templateActions.length > 0 ? [["Templates", templateActions.join(" · ")]] : []),
      [
        "Details",
        `↑↓/jk lazy scroll · g page top · G live tail · ${this.transcriptToolToggleHint()} · t transcript/summary · ? close help`,
      ],
    ];
    for (const [label, value] of help) {
      const prefix = `${this.theme.fg("accent", `${label}:`)} `;
      const wrapped = wrapPlainText(value ?? "", Math.max(1, width - 2 - visibleWidth(prefix)), 3);
      if (wrapped[0]) lines.push(this.row(width, prefix + wrapped[0]));
      for (const continuation of wrapped.slice(1)) {
        lines.push(this.row(width, " ".repeat(visibleWidth(prefix)) + continuation));
      }
    }
    lines.push(this.middleBorder(width));
    lines.push(this.row(width, this.theme.fg("dim", "  ? or esc close")));
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private modelSourceForActor(actor: FabricUiActor): ModelSource | undefined {
    return actor.runner === "claude" ? this.claudeModelSource : this.modelSource;
  }

  private openModelPicker(
    entity: Entity,
    scope: FabricActorBindingScope = "session",
  ): void {
    if (entity.kind !== "actor" || !this.onActorModel) return;
    const actor = entity.value;
    if (scope === "project" && actor.local === false) return;
    const source = this.modelSourceForActor(actor);
    if (!source) return;
    const projectModel = actor.projectDefaults?.model ?? (actor.binding ? undefined : actor.model);
    const currentValue = scope === "session" ? actor.binding?.model : projectModel;
    const runtimeDefault = actor.runner === "claude"
      ? "Fabric Claude model (or Claude Code runtime default)"
      : "Fabric Pi model (or host default)";
    this.modal.openPicker("model", actor.name, (close) => new FabricModelSelector({
      theme: this.theme,
      source,
      currentValue: currentValue ?? INHERIT_VALUE,
      headerText: scope === "session"
        ? actor.runner === "claude"
          ? `Model for Claude actor "${actor.name}" · session binding. Inherit uses the project default.`
          : `Model for actor "${actor.name}" · session binding. Inherit uses the project default.`
        : `Project model default for actor "${actor.name}". This pin is shared by every session.`,
      inheritName: scope === "session"
        ? `Use project default (${projectModel ?? runtimeDefault})`
        : `Clear project pin; use ${runtimeDefault}`,
      onSelect: (value) => {
        const model = value === INHERIT_VALUE ? undefined : value;
        this.onActorModel!(actor.id, model, scope);
        close();
      },
      onCancel: () => close(),
    }), () => { this.mode = "detail"; });
  }

  private openThinkingPicker(
    entity: Entity,
    scope: FabricActorBindingScope = "session",
  ): void {
    if (entity.kind !== "actor" || !this.onActorThinking) return;
    const actor = entity.value;
    if (scope === "project" && actor.local === false) return;
    const projectThinking =
      actor.projectDefaults?.thinking ?? (actor.binding ? undefined : actor.thinking);
    const currentValue = scope === "session" ? actor.binding?.thinking : projectThinking;
    this.modal.openPicker("thinking", actor.name, (close) => new FabricThinkingSelector({
      theme: this.theme,
      currentValue: currentValue ?? INHERIT_VALUE,
      headerText: scope === "session"
        ? `Thinking level for actor "${actor.name}" · session binding. Inherit uses the project default.`
        : `Project thinking default for actor "${actor.name}". This pin is shared by every session.`,
      inheritName: scope === "session"
        ? `Use project default (${projectThinking ?? "Fabric default"})`
        : "Clear project pin; use the Fabric default thinking level",
      onSelect: (value) => {
        const thinking = value === INHERIT_VALUE ? undefined : value;
        this.onActorThinking!(
          actor.id,
          isFabricThinking(thinking) ? thinking : undefined,
          scope,
        );
        close();
      },
      onCancel: () => close(),
    }), () => { this.mode = "detail"; });
  }

  private openDeliveryPicker(entity: Entity): void {
    if (entity.kind !== "actor" && entity.kind !== "globalActor") return;
    const target = entity.value;
    const callback =
      entity.kind === "actor" ? this.onActorDeliveryPolicy : this.onGlobalDeliveryPolicy;
    if (
      !callback ||
      (entity.kind === "actor" &&
        (entity.status === "stopped" || entity.value.local === false))
    ) return;
    this.modal.openPicker("delivery", target.name, (close) => new FabricActorDeliverySelector({
      theme: this.theme,
      currentValue: { delivery: target.delivery, triggerTurn: target.triggerTurn },
      headerText: `Delivery policy for ${entity.kind === "actor" ? "actor" : "template"} "${target.name}". Active delivery requires an explicit resume choice.`,
      onSelect: (policy) => {
        callback(target.id, policy.delivery, policy.triggerTurn);
        close();
      },
      onCancel: () => close(),
    }), () => { this.mode = "detail"; });
  }

  private openEventsPicker(entity: Entity): void {
    let callback: ((id: string, events: FabricActorHostEvent[]) => void) | undefined;
    if (entity.kind === "globalActor") callback = this.onGlobalEvents;
    else if (entity.kind === "actor" && entity.value.local !== false) callback = this.onActorEvents;
    if (!callback || (entity.kind !== "actor" && entity.kind !== "globalActor")) return;
    const actor = entity.value;
    const label = entity.kind === "actor" ? "actor" : "template";
    this.modal.openPicker("events", actor.name, (close) => new FabricHostEventSelector({
      theme: this.theme,
      currentValue: actor.events,
      headerText: `Host events for ${label} "${actor.name}". Toggle with space, Enter to apply, Esc to cancel.`,
      onSelect: (events) => {
        callback(actor.id, events);
        close();
      },
      onCancel: () => close(),
    }), () => { this.mode = "detail"; });
  }

  private openToolsPicker(entity: Entity): void {
    if (entity.kind !== "actor" || entity.value.local === false || !this.onActorTools) return;
    const actor = entity.value;
    this.modal.openPicker("tools", actor.name, (close) => new FabricActorToolSelector({
      theme: this.theme,
      currentValue: actor.tools ?? this.actorDefaultTools,
      headerText: `Tools for actor "${actor.name}". Toggle with space, Enter to apply, Esc to cancel. Pi actors always retain fabric_exec.`,
      onSelect: (tools) => {
        this.onActorTools!(actor.id, tools);
        close();
      },
      onCancel: () => close(),
    }), () => { this.mode = "detail"; });
  }

  /**
   * Open the embedded multi-line editor for an actor's default instruction.
   * Matches Pi's editor dialog convention (Enter submit, Shift+Enter newline,
   * Esc/Ctrl+C cancel) so a steering user edits the persona with the same
   * muscle memory as the chat input. Works for both live project actors and
   * global templates; the submit routes to the scope-appropriate callback.
   */
  private openInstructionsEditor(entity: Entity): void {
    let kind: "actor" | "globalActor";
    let id: string;
    let name: string;
    let instructions: string;
    if (entity.kind === "actor") {
      if (
        entity.status === "stopped" ||
        entity.value.local === false ||
        !this.onActorInstructions
      ) return;
      kind = "actor";
      id = entity.value.id;
      name = entity.value.name;
      instructions = entity.value.instructions;
    } else if (entity.kind === "globalActor") {
      if (!this.onGlobalInstructions) return;
      kind = "globalActor";
      id = entity.value.id;
      name = entity.value.name;
      instructions = entity.value.instructions;
    } else {
      return;
    }
    this.modal.openInstructions(name, instructions, (text) => {
      if (kind === "actor") this.onActorInstructions?.(id, text);
      else this.onGlobalInstructions?.(id, text);
    }, () => { this.mode = "detail"; });
  }

  private projectMesh(snapshot: FabricDashboardSnapshot): FabricProjectMeshModel | undefined {
    if (this.overviewView !== "topology") return undefined;
    return buildProjectMeshTopology({
      main: snapshot.main,
      actors: snapshot.actors,
      agents: snapshot.agents,
      state: snapshot.state,
      events: snapshot.events,
      ...(snapshot.participants ? { participants: snapshot.participants } : {}),
      now: snapshot.now,
    });
  }

  private renderOverview(
    width: number,
    snapshot: FabricDashboardSnapshot,
    run: FabricActivityRun | undefined,
    panels: PhasePanel[],
    entities: Entity[],
    allEntities: Entity[],
    meshModel?: FabricProjectMeshModel,
  ): string[] {
    if (width < 24) {
      return [truncateToWidth("too narrow · need 24 cols", width)];
    }
    const innerWidth = width - 2;
    const terminalRows = Math.max(
      1,
      this.tui.terminal?.rows ?? process.stdout.rows ?? 28,
    );
    const overlayRows = dashboardOverlayRows(terminalRows);
    const lines: string[] = [];
    const title =
      this.overviewView === "activity"
        ? `Fabric · ${run?.name ?? "session"} · Activity`
        : "Fabric · Topology";
    lines.push(this.topBorder(width, title));

    const runAgents = run
      ? snapshot.agents.filter((agent) => agent.runId === run.id)
      : snapshot.agents;
    const activeAgents = runAgents.filter((agent) => isActiveStatus(agent.status)).length;
    const hasDetachedWork = activeAgents > 0;
    const runTokens = tokensFor(snapshot, run);
    const largeRun = runAgents.length > 25 || runTokens > 1_500_000;
    const elapsed = run
      ? formatDuration(((hasDetachedWork ? snapshot.now : run.finishedAt) ?? snapshot.now) - run.startedAt)
      : undefined;
    const activeActors = snapshot.actors.filter((actor) => isActiveStatus(actor.status)).length;
    const summary = (
      meshModel
        ? [
            run?.name ? `focus ${run.name}` : undefined,
            run?.currentPhaseId
              ? `current ${run.phases.find((phase) => phase.id === run.currentPhaseId)?.name ?? run.currentPhaseId}`
              : undefined,
            `Participants ${snapshot.agents.filter((agent) => isActiveStatus(agent.status)).length}/${snapshot.agents.length} agents · ${activeActors}/${snapshot.actors.length} actors · ${meshModel.participants.length} remote`,
            `Mesh ${meshModel.topics.length} topics · ${snapshot.state.length} state`,
            this.graph.replayIndex !== undefined
              ? `${this.graph.replayPlaying ? "▶" : "Ⅱ"} replay ${this.graph.replayIndex + 1}/${Math.max(1, this.graph.replayLength)} · ${this.graph.replaySpeed}×`
              : undefined,
            snapshot.runs.length > 1 ? `run ${this.runIndex + 1}/${snapshot.runs.length}` : undefined,
          ]
        : [
            this.overviewView === "topology" ? run?.name : undefined,
            run?.status,
            largeRun ? "⚠ large run" : undefined,
            `${activeAgents}/${runAgents.length} run agents active`,
            `${snapshot.actors.length} actors`,
            runTokens > 0 ? `${formatTokens(runTokens)} tok` : undefined,
            elapsed,
            snapshot.runs.length > 1
              ? `run ${this.runIndex + 1}/${snapshot.runs.length}`
              : undefined,
          ]
    )
      .filter((value): value is string => Boolean(value))
      .join(" · ");
    const summaryText = safeText(summary);
    let headerLine = summaryText;
    if (
      run?.description &&
      this.overviewView === "activity"
    ) {
      const gap = "  ";
      const availableDescription = innerWidth - visibleWidth(summaryText) - gap.length;
      headerLine =
        availableDescription >= 12
          ? `${padToWidth(
              this.theme.fg("muted", safeText(run.description)),
              availableDescription,
            )}${gap}${this.theme.fg("dim", summaryText)}`
          : this.theme.fg("dim", summaryText);
    } else if (summaryText) {
      headerLine = this.theme.fg("dim", summaryText);
    }
    const minimumRows = 8;
    if (overlayRows < minimumRows) {
      return [
        title,
        this.theme.fg("dim", summaryText || "No Fabric activity yet"),
        this.theme.fg("dim", "1 activity · 2 topology · arrows move · esc close"),
      ]
        .slice(0, overlayRows)
        .map((line) => truncateToWidth(line, width, ""));
    }
    lines.push(this.row(width, headerLine || this.theme.fg("muted", "No Fabric activity yet")));
    lines.push(this.middleBorder(width));

    const desiredRunEvents = run?.events.slice(-2) ?? [];
    const desiredMeshEventCount = Math.max(0, 2 - desiredRunEvents.length);
    const desiredMeshEvents =
      desiredMeshEventCount > 0 ? snapshot.events.slice(-desiredMeshEventCount) : [];
    const optionalEventRoom = Math.max(0, overlayRows - minimumRows);
    const eventRows = optionalEventRoom >= 2 ? Math.min(2, optionalEventRoom - 1) : 0;
    const runEventRows = Math.min(desiredRunEvents.length, eventRows);
    const meshEventRows = Math.max(0, eventRows - runEventRows);
    const runEvents = runEventRows > 0 ? desiredRunEvents.slice(-runEventRows) : [];
    const meshEvents =
      meshEventRows > 0 ? desiredMeshEvents.slice(-meshEventRows) : [];
    const eventChromeRows = eventRows > 0 ? eventRows + 1 : 0;
    const maxBody = Math.max(
      1,
      Math.min(this.overviewView === "topology" ? 30 : 22, overlayRows - 7 - eventChromeRows),
    );
    if (this.overviewView === "topology") {
      const topology = meshModel ?? buildProjectMeshTopology({
        main: snapshot.main,
        actors: snapshot.actors,
        agents: snapshot.agents,
        state: snapshot.state,
        events: snapshot.events,
        ...(snapshot.participants ? { participants: snapshot.participants } : {}),
        now: snapshot.now,
      });
      this.graph.startEffectsAnimation();
      const replayFrame = this.graph.replayFrame(snapshot.events, topology.routes);
      const renderGraph = () => renderFabricTopologyPanel({
        theme: this.theme,
        filter: this.filter,
        selectedEntityId: this.selectedEntityId,
        snapshot,
        run,
        mesh: topology,
        allEntities,
        entities,
        width: innerWidth,
        height: maxBody,
        camera: this.graph.camera,
        invalidate: this.highlightInvalidate,
        animation: {
          now: Date.now(),
          reducedMotion: this.graph.reducedMotion,
          showHistory: this.graph.showHistory,
          ...(replayFrame
            ? { replayRouteId: replayFrame.route.id, replayLabel: replayFrame.event.kind }
            : {}),
        },
      });
      const cameraWasInitialized = this.graph.cameraInitialized;
      let rendered = renderGraph();
      this.graph.setPositions(rendered.positions);
      if (rendered.selectedPosition) this.graph.setCameraTarget(rendered.selectedPosition);
      if (!cameraWasInitialized && this.graph.cameraInitialized) rendered = renderGraph();
      for (const line of rendered.lines) lines.push(this.row(width, line));
    } else if (innerWidth >= 88) {
      const leftWidth = Math.min(38, Math.max(28, Math.floor((innerWidth - 1) * 0.34)));
      const rightWidth = innerWidth - leftWidth - 1;
      const leftLines = this.renderPhasePanel(panels, leftWidth, maxBody);
      const rightLines = this.renderEntityPanel(entities, rightWidth, maxBody, snapshot.now);
      for (let index = 0; index < maxBody; index++) {
        const left = leftLines[index] ?? "";
        const right = rightLines[index] ?? "";
        lines.push(
          this.row(
            width,
            `${padToWidth(left, leftWidth)}${this.theme.fg("borderMuted", "│")}${padToWidth(
              right,
              rightWidth,
            )}`,
          ),
        );
      }
    } else {
      const panelRows = Math.max(2, maxBody - 1);
      const phaseHeight = Math.max(1, Math.min(panels.length + 1, Math.floor(panelRows * 0.45)));
      const entityHeight = Math.max(1, panelRows - phaseHeight);
      for (const line of this.renderPhasePanel(panels, innerWidth, phaseHeight)) {
        lines.push(this.row(width, line));
      }
      lines.push(this.row(width, this.theme.fg("borderMuted", "─".repeat(innerWidth))));
      for (const line of this.renderEntityPanel(entities, innerWidth, entityHeight, snapshot.now)) {
        lines.push(this.row(width, line));
      }
    }

    if (eventRows > 0) {
      lines.push(this.middleBorder(width));
      let renderedEventRows = 0;
      for (const event of runEvents) {
        lines.push(
          this.row(
            width,
            colorStatus(
              this.theme,
              event.level === "success" ? "completed" : event.level,
              `[${formatClock(event.createdAt)}] ${safeText(event.message)}`,
            ),
          ),
        );
        renderedEventRows++;
      }
      for (const event of meshEvents) {
        const target = event.to ? ` → ${event.to}` : "";
        const text = event.text ? ` · ${safeText(event.text)}` : "";
        lines.push(
          this.row(
            width,
            this.theme.fg(
              "dim",
              `[${formatClock(event.createdAt)}] ${event.topic} · ${event.from.name}${target}${text}`,
            ),
          ),
        );
        renderedEventRows++;
      }
      while (renderedEventRows < eventRows) {
        lines.push(this.row(width, ""));
        renderedEventRows++;
      }
    }

    lines.push(this.middleBorder(width));
    const navigationHint =
      this.overviewView === "topology"
        ? this.graph.replayIndex !== undefined
          ? `replay ${this.graph.replayIndex + 1}/${Math.max(1, this.graph.replayLength)}${this.graph.replayLabel ? ` · ${safeText(this.graph.replayLabel)}` : ""} · r live · space ${this.graph.replayPlaying ? "pause" : "play"} · ←/→ step · +/- speed:${this.graph.replaySpeed}× · H history · M motion:${this.graph.reducedMotion ? "reduced" : "full"} · ? help`
          : `arrows/h/l move · j/k order · r replay · H history · M motion:${this.graph.reducedMotion ? "reduced" : "full"} · f filter:${this.filter} · 1 activity · ? help`
        : `↑↓/jk select · ←→/tab pane · enter inspect · f filter:${this.filter} · 2 topology · [ older · ] newer · ? help`;
    lines.push(this.row(width, this.theme.fg("dim", navigationHint)));
    const selectedEntity = entities[this.entityIndex];
    const actionHint =
      this.pane === "entities" && selectedEntity
        ? this.theme.fg("muted", `  ${this.overviewActionHint(selectedEntity)}`)
        : "";
    lines.push(this.row(width, actionHint));
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private overviewActionHint(entity: Entity): string {
    if (entity.kind === "main") {
      const actions = [
        this.canMessage(entity, "steer") ? "s message/steer" : undefined,
        this.canMessage(entity, "followUp") ? "u queue follow-up" : undefined,
        "enter details",
      ].filter((value): value is string => Boolean(value));
      return `Main actions: ${actions.join(" · ")}`;
    }
    if (entity.kind === "peer") {
      const actions = [
        this.canMessage(entity, "steer") ? "s steer" : undefined,
        this.canMessage(entity, "followUp") ? "u follow-up" : undefined,
        "enter details",
      ].filter((value): value is string => Boolean(value));
      return `peer actions: ${actions.join(" · ")}`;
    }
    if (entity.kind === "actor" && entity.status !== "stopped") {
      const owned = entity.value.local !== false;
      const actions = [
        this.actorTranscript
          ? `space ${isActiveStatus(entity.status) ? "live " : ""}transcript peek`
          : undefined,
        this.canMessage(entity, "steer") ? "s queue message" : undefined,
        this.modelSourceForActor(entity.value) && this.onActorModel
          ? `m session model${owned ? " · M pin model" : ""}`
          : undefined,
        this.onActorThinking
          ? `e session thinking${owned ? " · E pin thinking" : ""}`
          : undefined,
        owned && this.onActorDeliveryPolicy ? "y delivery policy" : undefined,
        owned && this.onActorEvents ? "v events" : undefined,
        owned && this.onActorTools ? "o tools" : undefined,
        owned && this.onActorInstructions ? "i instructions" : undefined,
        owned && this.onClearMessages ? "c clear mailbox" : undefined,
        this.onExportActor ? "x export" : undefined,
        "enter details",
      ].filter((value): value is string => Boolean(value));
      return `actor actions: ${actions.join(" · ")}`;
    }
    if (entity.kind === "globalActor") {
      const actions = [
        this.onGlobalDeliveryPolicy ? "y delivery policy" : undefined,
        this.onGlobalEvents ? "v events" : undefined,
        this.onGlobalInstructions ? "i instructions" : undefined,
        this.onImportActor ? "p import" : undefined,
        this.onRemoveGlobalActor ? "d delete" : undefined,
        "enter details",
      ].filter((value): value is string => Boolean(value));
      return `template actions: ${actions.join(" · ")}`;
    }
    if (entity.kind === "agent") {
      const armed =
        this.pendingStop?.id === entity.value.id && this.pendingStop.expiresAt > Date.now();
      const actions = [
        this.agentTranscript
          ? `space ${isActiveStatus(entity.status) ? "live " : ""}transcript peek`
          : undefined,
        this.canMessage(entity, "steer") ? "s steer" : undefined,
        this.canMessage(entity, "followUp") ? "u follow-up" : undefined,
        this.canStop(entity)
          ? armed
            ? "x again to stop"
            : "x stop"
          : undefined,
        "enter details",
      ].filter((value): value is string => Boolean(value));
      return `agent actions: ${actions.join(" · ")}`;
    }
    if (entity.kind === "meshParticipant") {
      const armed =
        this.pendingStop?.id === entity.value.id && this.pendingStop.expiresAt > Date.now();
      const actions = [
        this.canMessage(entity, "steer") ? "s steer" : undefined,
        this.canMessage(entity, "followUp") ? "u follow-up" : undefined,
        this.canStop(entity)
          ? armed
            ? "x again to stop"
            : "x stop"
          : undefined,
        "enter details",
      ].filter((value): value is string => Boolean(value));
      return `participant actions: ${actions.join(" · ")}`;
    }
    return "enter details";
  }

  private renderPhasePanel(panels: PhasePanel[], width: number, height: number): string[] {
    const lines = [
      truncateToWidth(
        `${this.pane === "phases" ? this.theme.fg("accent", "▸ ") : "  "}${this.theme.fg(
          "accent",
          "Activity",
        )}`,
        width,
      ),
    ];
    const available = Math.max(0, height - 1);
    const start = Math.max(
      0,
      Math.min(this.phaseIndex - Math.floor(available / 2), Math.max(0, panels.length - available)),
    );
    for (let index = start; index < Math.min(panels.length, start + available); index++) {
      const panel = panels[index];
      if (!panel) continue;
      const selected = index === this.phaseIndex;
      const prefix = selected ? "› " : "  ";
      const count = panel.total > 0 ? `${panel.completed}/${panel.total}` : "";
      const raw = `${prefix}${colorStatus(this.theme, panel.status, statusGlyph(panel.status))} ${this.theme.fg("muted", safeText(
        panel.name,
      ))}`;
      const countWidth = visibleWidth(count);
      const contentWidth = Math.max(0, width - countWidth - (count ? 1 : 0));
      let line = `${padToWidth(raw, contentWidth)}${count ? ` ${this.theme.fg("dim", count)}` : ""}`;
      if (selected && this.pane === "phases") {
        line = this.theme.bg("selectedBg", padToWidth(line, width));
      }
      lines.push(truncateToWidth(line, width, ""));
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private renderEntityPanel(
    entities: Entity[],
    width: number,
    height: number,
    now: number,
  ): string[] {
    const lines: string[] = [];
    const available = Math.max(0, height);
    const groupedRows: Array<
      | { type: "group"; group: EntityGroup }
      | { type: "spacer" }
      | { type: "entity"; entity: Entity; entityIndex: number }
    > = [];
    const groups = groupEntities(entities);
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex]!;
      if (groupIndex > 0) groupedRows.push({ type: "spacer" });
      groupedRows.push({ type: "group", group });
      for (const entry of group.entries) {
        groupedRows.push({ type: "entity", entity: entry.entity, entityIndex: entry.index });
      }
    }
    const selectedRow = Math.max(
      0,
      groupedRows.findIndex(
        (row) => row.type === "entity" && row.entityIndex === this.entityIndex,
      ),
    );
    const start = Math.max(
      0,
      Math.min(
        selectedRow - Math.floor(available / 2),
        Math.max(0, groupedRows.length - available),
      ),
    );
    for (let index = start; index < Math.min(groupedRows.length, start + available); index++) {
      const row = groupedRows[index];
      if (!row) continue;
      if (row.type === "spacer") {
        lines.push("");
        continue;
      }
      if (row.type === "group") {
        lines.push(
          truncateToWidth(
            this.theme.fg(
              "muted",
              `  ${this.theme.bold(row.group.label)} (${row.group.entries.length})`,
            ),
            width,
            "",
          ),
        );
        continue;
      }
      const entity = row.entity;
      const selected = row.entityIndex === this.entityIndex;
      const prefix = selected ? "› " : "  ";
      const lead = `${prefix}${colorStatus(this.theme, entity.status, statusGlyph(entity.status))} ${this.theme.fg("muted", safeText(
        entity.label,
      ))}`;
      const tail = safeText(entityTail(entity, now));
      let line = tail ? `${lead}  ${this.theme.fg("dim", tail)}` : lead;
      if (selected && this.pane === "entities") {
        line = this.theme.bg("selectedBg", padToWidth(line, width));
      }
      lines.push(truncateToWidth(line, width, ""));
    }
    if (entities.length === 0 && available > 0) {
      const label = this.filter === "all" ? "activity" : `${this.filter} activity`;
      lines.push(this.theme.fg("dim", `  (no ${label}; press f to change filter)`));
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private renderDetail(
    width: number,
    snapshot: FabricDashboardSnapshot,
    entity: Entity,
  ): string[] {
    const result = this.detailRenderer.render(
      width,
      snapshot,
      entity,
      {
        view: this.detailView,
        scroll: this.detailScroll,
        pageAnchor: this.transcriptPageAnchor,
        transcriptFollowing: this.transcriptFollowing,
        transcriptToolsExpanded: this.transcriptToolsExpanded,
      },
      this.detailActionHint(entity),
      (entity.kind === "agent" || entity.kind === "actor") && this.detailView === "transcript"
        ? this.transcriptToolToggleHint()
        : "",
    );
    this.detailScroll = result.scroll;
    this.detailMaxScroll = result.maxScroll;
    this.transcriptPageAnchor = result.pageAnchor;
    return result.lines;
  }

  private detailActionHint(entity: Entity): string {
    if (entity.kind === "main") {
      const actions = [
        this.canMessage(entity, "steer") ? "s message/steer now" : undefined,
        this.canMessage(entity, "followUp") ? "u queue follow-up" : undefined,
      ].filter((value): value is string => Boolean(value));
      return actions.length > 0
        ? `Main Pi agent actions: ${actions.join(" · ")}`
        : "Main Pi agent controls are unavailable in this session.";
    }
    if (entity.kind === "peer") {
      const actions = [
        this.canMessage(entity, "steer") ? "s steer over mesh" : undefined,
        this.canMessage(entity, "followUp") ? "u queue follow-up over mesh" : undefined,
      ].filter((value): value is string => Boolean(value));
      return actions.length > 0
        ? `Peer session actions: ${actions.join(" · ")}`
        : "Peer session is read-only.";
    }
    if (entity.kind === "agent") {
      const armed =
        this.pendingStop?.id === entity.value.id && this.pendingStop.expiresAt > Date.now();
      const actions = [
        this.canMessage(entity, "steer") ? "s steer now" : undefined,
        this.canMessage(entity, "followUp") ? "u queue follow-up" : undefined,
        this.canStop(entity)
          ? armed
            ? "x again to confirm stop"
            : "x stop"
          : undefined,
      ].filter((value): value is string => Boolean(value));
      const controls =
        actions.length > 0
          ? `One-shot agent actions: ${actions.join(" · ")}. `
          : "One-shot agent. ";
      return `${controls}Model and thinking are fixed at spawn; use a persistent actor for editable runtime settings.`;
    }
    if (entity.kind === "actor" && entity.status !== "stopped") {
      const owned = entity.value.local !== false;
      const actions = [
        this.canMessage(entity, "steer") ? "s queue message" : undefined,
        this.modelSourceForActor(entity.value) && this.onActorModel
          ? `m session model${owned ? " · M pin model" : ""}`
          : undefined,
        this.onActorThinking
          ? `e session thinking${owned ? " · E pin thinking" : ""}`
          : undefined,
        owned && this.onActorDeliveryPolicy ? "y delivery policy" : undefined,
        owned && this.onActorEvents ? "v events" : undefined,
        owned && this.onActorTools ? "o tools" : undefined,
        owned && this.onClearMessages ? "c clear mailbox" : undefined,
        owned && this.onActorInstructions ? "i instructions" : undefined,
        this.onExportActor ? "x export→global" : undefined,
      ].filter((value): value is string => Boolean(value));
      return actions.length > 0
        ? `Actor actions: ${actions.join(" · ")}`
        : "Actor settings are read-only in this session.";
    }
    if (entity.kind === "meshParticipant") {
      const armed =
        this.pendingStop?.id === entity.value.id && this.pendingStop.expiresAt > Date.now();
      const actions = [
        this.canMessage(entity, "steer") ? "s steer over mesh" : undefined,
        this.canMessage(entity, "followUp") ? "u queue follow-up over mesh" : undefined,
        this.canStop(entity)
          ? armed
            ? "x again to confirm stop"
            : "x stop"
          : undefined,
      ].filter((value): value is string => Boolean(value));
      return actions.length > 0
        ? `Remote participant actions: ${actions.join(" · ")}`
        : "Remote participant is read-only.";
    }
    if (entity.kind === "globalActor") {
      const actions = [
        this.onGlobalDeliveryPolicy ? "y delivery policy" : undefined,
        this.onGlobalEvents ? "v events" : undefined,
        this.onGlobalInstructions ? "i instructions" : undefined,
        this.onImportActor ? "p import" : undefined,
        this.onRemoveGlobalActor ? "d delete" : undefined,
      ].filter((value): value is string => Boolean(value));
      return actions.length > 0
        ? `Template actions: ${actions.join(" · ")}`
        : "Global template is read-only in this session.";
    }
    return "Read-only detail.";
  }

  private syncEntitySelection(entities: Entity[], preferAttention = false): void {
    if (entities.length === 0) {
      this.entityIndex = 0;
      this.selectedEntityId = undefined;
      return;
    }
    const retainedIndex = this.selectedEntityId
      ? entities.findIndex((entity) => entity.id === this.selectedEntityId)
      : -1;
    const failedIndex = preferAttention
      ? entities.findIndex(
          (entity) =>
            entity.kind !== "main" &&
            ["failed", "timed_out", "error"].includes(entity.status),
        )
      : -1;
    const blockedIndex = preferAttention
      ? entities.findIndex(
          (entity) => entity.kind !== "main" && entity.status === "blocked",
        )
      : -1;
    const activeIndex = preferAttention
      ? entities.findIndex(
          (entity) => entity.kind !== "main" && isActiveStatus(entity.status),
        )
      : -1;
    const attentionIndex =
      failedIndex >= 0 ? failedIndex : blockedIndex >= 0 ? blockedIndex : activeIndex;
    const firstWorkIndex = entities.findIndex((entity) => entity.kind !== "main");
    this.entityIndex =
      retainedIndex >= 0
        ? retainedIndex
        : attentionIndex >= 0
          ? attentionIndex
          : firstWorkIndex >= 0
            ? firstWorkIndex
            : Math.max(0, Math.min(this.entityIndex, entities.length - 1));
    this.selectedEntityId = entities[this.entityIndex]?.id;
  }

  private selectRun(snapshot: FabricDashboardSnapshot): FabricActivityRun | undefined {
    if (snapshot.runs.length === 0) {
      this.runIndex = 0;
      this.selectedRunId = undefined;
      return undefined;
    }
    if (!this.runSelectionTouched) {
      this.runIndex = 0;
      this.selectedRunId = snapshot.runs[0]?.id;
      return snapshot.runs[0];
    }
    const retainedIndex = this.selectedRunId
      ? snapshot.runs.findIndex((run) => run.id === this.selectedRunId)
      : -1;
    this.runIndex =
      retainedIndex >= 0
        ? retainedIndex
        : Math.max(0, Math.min(this.runIndex, snapshot.runs.length - 1));
    this.selectedRunId = snapshot.runs[this.runIndex]?.id;
    return snapshot.runs[this.runIndex];
  }

  private syncPhase(run: FabricActivityRun | undefined, panels: PhasePanel[]): void {
    if (panels.length === 0) {
      this.phaseIndex = 0;
      this.selectedPhaseId = undefined;
      return;
    }
    if (!this.phaseSelectionTouched) {
      const current = run?.currentPhaseId
        ? panels.findIndex((panel) => panel.id === run.currentPhaseId)
        : -1;
      const activeRunActivity = panels.findIndex(
        (panel) => panel.kind === "unphased" && isActiveStatus(panel.status),
      );
      if (current >= 0 && isActiveStatus(panels[current]!.status)) {
        this.phaseIndex = current;
      } else if (activeRunActivity >= 0) {
        this.phaseIndex = activeRunActivity;
      } else if (current >= 0) {
        this.phaseIndex = current;
      } else {
        this.phaseIndex = 0;
      }
    } else {
      const retainedIndex = this.selectedPhaseId
        ? panels.findIndex((panel) => panel.id === this.selectedPhaseId)
        : -1;
      this.phaseIndex =
        retainedIndex >= 0
          ? retainedIndex
          : Math.max(0, Math.min(this.phaseIndex, panels.length - 1));
    }
    this.phaseIndex = Math.max(0, Math.min(this.phaseIndex, panels.length - 1));
    this.selectedPhaseId = panels[this.phaseIndex]?.id;
  }

  private resetSelection(): void {
    this.phaseIndex = 0;
    this.entityIndex = 0;
    this.selectedEntityId = undefined;
    this.phaseSelectionTouched = false;
    this.selectedPhaseId = undefined;
    this.detailId = undefined;
    this.detailScroll = 0;
    this.detailMaxScroll = 0;
    this.transcriptPageAnchor = undefined;
    this.detailSelectionRestore = undefined;
    this.detailView = "summary";
    this.transcriptFollowing = true;
    this.pane = this.overviewView === "activity" ? "phases" : "entities";
  }

  private pinDetailSelection(
    run: FabricActivityRun | undefined,
    panel: PhasePanel | undefined,
    pinPhase: boolean,
  ): void {
    this.detailSelectionRestore ??= {
      runSelectionTouched: this.runSelectionTouched,
      phaseSelectionTouched: this.phaseSelectionTouched,
    };
    this.runSelectionTouched = true;
    this.selectedRunId = run?.id;
    if (pinPhase) {
      this.phaseSelectionTouched = true;
      this.selectedPhaseId = panel?.id;
    }
  }

  private closeDetail(): void {
    const restore = this.detailSelectionRestore;
    if (restore) {
      this.runSelectionTouched = restore.runSelectionTouched;
      this.phaseSelectionTouched = restore.phaseSelectionTouched;
    }
    this.detailSelectionRestore = undefined;
    this.detailId = undefined;
    this.detailScroll = 0;
    this.detailMaxScroll = 0;
    this.transcriptPageAnchor = undefined;
    this.detailView = "summary";
    this.transcriptFollowing = true;
  }

  private renderNarrowFallback(width: number, label: string, hint: string): string[] {
    return [safeText(label), hint]
      .map((line) => truncateToWidth(line, width, ""))
      .filter((line) => visibleWidth(line) > 0);
  }

  private topBorder(width: number, title: string): string {
    const border = (value: string) => this.theme.fg("borderMuted", value);
    const safeTitle = truncateToWidth(safeText(title), Math.max(0, width - 6));
    const styledTitle = ` ${this.theme.fg("accent", safeTitle)} `;
    const remaining = Math.max(0, width - 2 - visibleWidth(styledTitle));
    const left = Math.floor(remaining / 2);
    const right = remaining - left;
    return `${border(`╭${"─".repeat(left)}`)}${styledTitle}${border(`${"─".repeat(right)}╮`)}`;
  }

  private middleBorder(width: number): string {
    return this.theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`);
  }

  private bottomBorder(width: number): string {
    return this.theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
  }

  private row(width: number, content: string): string {
    const innerWidth = Math.max(0, width - 2);
    return `${this.theme.fg("borderMuted", "│")}${padToWidth(content, innerWidth)}${this.theme.fg(
      "borderMuted",
      "│",
    )}`;
  }
}
