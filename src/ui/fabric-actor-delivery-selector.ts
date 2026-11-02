import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  SelectList,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import type { FabricActorDeliveryPolicy } from "../actors/delivery-policy.js";

const LAYOUT: SelectListLayoutOptions = {
  minPrimaryColumnWidth: 18,
  maxPrimaryColumnWidth: 34,
};

const POLICIES: Array<FabricActorDeliveryPolicy & { value: string; label: string; description: string }> = [
  { value: "mailbox", label: "Mailbox only", description: "keep output in actor history", delivery: "mailbox", triggerTurn: false },
  { value: "steer-passive", label: "Steer · passive", description: "deliver now without starting idle Main", delivery: "steer", triggerTurn: false },
  { value: "steer-active", label: "Steer · resume Main", description: "deliver now and start Main when idle", delivery: "steer", triggerTurn: true },
  { value: "followUp-passive", label: "Legacy follow-up · passive", description: "steering alias; never starts idle Main", delivery: "followUp", triggerTurn: false },
  { value: "followUp-active", label: "Legacy follow-up · resume Main", description: "steering alias; starts Main when idle", delivery: "followUp", triggerTurn: true },
  { value: "next-turn", label: "Next user turn", description: "defer until the next user prompt", delivery: "nextTurn", triggerTurn: false },
];

const selectListTheme = (theme: Theme): SelectListTheme => ({
  selectedPrefix: (text) => theme.fg("accent", text),
  selectedText: (text) => theme.fg("accent", text),
  description: (text) => theme.fg("muted", text),
  scrollInfo: (text) => theme.fg("muted", text),
  noMatch: (text) => theme.fg("muted", text),
});

export interface FabricActorDeliverySelectorOptions {
  theme: Theme;
  currentValue: FabricActorDeliveryPolicy;
  onSelect: (policy: FabricActorDeliveryPolicy) => void;
  onCancel: () => void;
  headerText?: string;
}

export class FabricActorDeliverySelector extends Container implements Focusable {
  private readonly selectList: SelectList;
  focused = false;

  constructor(options: FabricActorDeliverySelectorOptions) {
    super();
    const current = POLICIES.find(
      (policy) =>
        policy.delivery === options.currentValue.delivery &&
        policy.triggerTurn === options.currentValue.triggerTurn,
    )?.value;
    const items: SelectItem[] = POLICIES.map((policy) => ({
      value: policy.value,
      label: `${policy.label}${policy.value === current ? " ✓" : ""}`,
      description: policy.description,
    }));
    this.addChild(
      new Text(
        options.theme.fg(
          "muted",
          options.headerText ?? "Choose how actor output enters Main and whether it starts a turn.",
        ),
        0,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.selectList = new SelectList(items, items.length, selectListTheme(options.theme), LAYOUT);
    const startIndex = items.findIndex((item) => item.value === current);
    if (startIndex >= 0) this.selectList.setSelectedIndex(startIndex);
    this.selectList.onSelect = (item) => {
      const policy = POLICIES.find((candidate) => candidate.value === item.value);
      if (policy) options.onSelect({ delivery: policy.delivery, triggerTurn: policy.triggerTurn });
    };
    this.selectList.onCancel = options.onCancel;
    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
  }
}
