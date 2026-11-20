import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, getKeybindings, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { FabricAgentMessageDelivery } from "../main-agent.js";
import type { FabricDashboardMessageTarget } from "./dashboard.js";

interface ModalChild {
  focused: boolean;
  handleInput(data: string): void;
  render(width: number): readonly string[];
}

export interface DashboardModalContent {
  title: string;
  narrowTitle: string;
  hint: string;
  render(width: number): readonly string[];
}

type PickerKind = "model" | "thinking" | "delivery" | "events" | "tools";

interface ActiveModal {
  kind: "picker" | "editor";
  child: ModalChild;
  content: DashboardModalContent;
  onClose(): void;
}

const editorTheme = (theme: Theme): EditorTheme => ({
  borderColor: (value: string) => theme.fg("borderMuted", value),
  selectList: {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("muted", text),
    noMatch: (text: string) => theme.fg("muted", text),
  },
});

/** Owns transient input capture; dashboard selection and action eligibility stay outside. */
export class DashboardModalController {
  private active: ActiveModal | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
  ) {}

  openPicker(
    kind: PickerKind,
    name: string,
    create: (close: () => void) => ModalChild,
    onClose: () => void,
  ): void {
    const child = create(() => this.close());
    this.open("picker", child, {
      title: `actor · ${name} · ${kind}`,
      narrowTitle: `actor · ${name}`,
      hint: `  Enter to select · Esc to cancel${kind === "model" ? " · type to filter" : ""}`,
    }, onClose);
  }

  openInstructions(
    name: string,
    instructions: string,
    onSubmit: (text: string) => void,
    onClose: () => void,
  ): void {
    this.openEditor({
      title: `instructions · ${name}`,
      narrowTitle: `instructions · ${name}`,
      hint: "  enter submit · shift+enter newline · esc cancel",
    }, instructions, (text) => {
      onSubmit(text);
      return true;
    }, onClose);
  }

  openMessage(
    target: FabricDashboardMessageTarget,
    delivery: FabricAgentMessageDelivery,
    onSubmit: (message: string) => void,
    onClose: () => void,
  ): void {
    const label = target.kind === "actor"
      ? "queue actor message"
      : delivery === "steer"
        ? target.kind === "main" ? "message or steer Main" : "steer now"
        : "queue follow-up";
    this.openEditor({
      title: `${label} · ${target.name}`,
      narrowTitle: `${delivery} · ${target.name}`,
      hint: "  enter send · shift+enter newline · esc cancel",
    }, undefined, (text) => {
      const message = text.trim();
      if (!message) return false;
      onSubmit(message);
      return true;
    }, onClose);
  }

  /** Returns true even when this input closes the modal: never leak it to navigation. */
  handleInput(data: string): boolean {
    const active = this.active;
    if (!active) return false;
    if (active.kind === "editor" && getKeybindings().matches(data, "tui.select.cancel")) {
      this.close();
    } else {
      active.child.handleInput(data);
    }
    this.tui.requestRender();
    return true;
  }

  render(
    width: number,
    frame: (width: number, content: DashboardModalContent) => string[],
  ): string[] | undefined {
    if (!this.active) return undefined;
    return width <= 0 ? [] : frame(width, this.active.content);
  }

  /** Disposal releases the child without running a navigation callback. */
  dispose(): void {
    this.active = undefined;
  }

  private close(): void {
    const active = this.active;
    this.active = undefined;
    active?.onClose();
  }

  private openEditor(
    content: Omit<DashboardModalContent, "render">,
    text: string | undefined,
    onSubmit: (text: string) => boolean,
    onClose: () => void,
  ): void {
    const editor = new Editor(this.tui, editorTheme(this.theme));
    if (text !== undefined) editor.setText(text);
    editor.onSubmit = (value) => {
      if (onSubmit(value)) this.close();
    };
    this.open("editor", editor, content, onClose);
  }

  private open(
    kind: ActiveModal["kind"],
    child: ModalChild,
    content: Omit<DashboardModalContent, "render">,
    onClose: () => void,
  ): void {
    child.focused = true;
    this.active = {
      kind,
      child,
      content: { ...content, render: (width) => child.render(width) },
      onClose,
    };
  }
}
