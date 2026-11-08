import "./fixtures/conversation-host.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createInteractiveTuiReference } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Text, TuiAltScreen, TuiMainScreen, stripTerminalSequences, type OverlayHandle, type Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { FabricConversationState, FabricConversationView } from "../src/ui/conversation.js";
import { FabricWidget } from "../src/ui/widget.js";
import type { FabricDashboardSnapshot, FabricUiAgent } from "../src/ui/types.js";
import { nativeTranscript, assistantMessage } from "./fixtures/native-conversation.js";

class PointerTerminal implements Terminal {
  columns = 100;
  rows = 24;
  kittyProtocolActive = false;
  output = "";
  input: (data: string) => void = () => {};
  start(onInput: (data: string) => void): void { this.input = onInput; }
  stop(): void { this.input = () => {}; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}
const theme = {
  fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text,
  bold: (text: string) => text, italic: (text: string) => text, underline: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;
const snapshot = (count: number): FabricDashboardSnapshot => ({
  now: 1000, sessionLabel: "Footer Main", peers: [], runs: [], actors: [], globalActors: [], state: [], events: [],
  componentGraph: { nodes: [], edges: [] },
  agents: Array.from({ length: count }, (_, i) => ({ id: `agent-${i}`, name: `Agent ${i}`, status: "running", transport: "process", cwd: "/tmp", startedAt: i, toolCalls: 0 } as FabricUiAgent)),
} as unknown as FabricDashboardSnapshot);
const targets = (current: FabricDashboardSnapshot) => [
  { id: "main", name: "Main", kind: "main" as const, status: "idle", canSteer: false, canFollowUp: false, canStop: false },
  ...current.agents.map(agent => ({ id: agent.id, name: agent.name, kind: "agent" as const, status: "completed", canSteer: false, canFollowUp: false, canStop: false })),
];

describe("participant footer through real mouse dispatch", () => {
  it.each([["regular", TuiMainScreen], ["fullscreen", TuiAltScreen]] as const)(
    "clicks Agent 2, then the painted Main row rather than its neighbour (%s)", async (_mode, Renderer) => {
      initTheme("dark", false);
      const terminal = new PointerTerminal();
      const tui = new Renderer(terminal);
      tui.addChild(new Text("Native Main"));
      const current = snapshot(3), state = new FabricConversationState(), close = vi.fn();
      let handle: OverlayHandle | undefined;
      const view = new FabricConversationView(createInteractiveTuiReference(() => tui), theme, {
        state, initialTargetId: "agent-1", targets: () => targets(current),
        transcript: id => nativeTranscript([assistantMessage(`History of ${id}`)]),
        loadOlder: () => false, loadNewer: () => false, loadLatest: () => false,
        send: vi.fn(), stop: vi.fn(), close,
        participants: interaction => new FabricWidget(theme, () => current, 6, () => terminal.rows, undefined, interaction),
      });
      const click = (y: number) => {
        terminal.input(`\x1b[<0;5;${y + 1}M`);
        terminal.input(`\x1b[<0;5;${y + 1}m`);
      };
      tui.start();
      handle = tui.showOverlay(view, { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 });
      try {
        await vi.waitFor(() => expect(terminal.output).toContain("History of agent-1"));
        const first = view.render(terminal.columns).map(stripTerminalSequences);
        click(first.findIndex(line => line.includes("Agent 2")));
        await vi.waitFor(() => expect(state.selectedId).toBe("agent-2"));
        const next = view.render(terminal.columns).map(stripTerminalSequences);
        click(next.findIndex(line => line.includes("Footer Main")));
        await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
        expect(state.selectedId).toBe("agent-2");
      } finally { view.dispose(); handle.hide(); state.clear(); tui.stop(); }
    },
  );
});
