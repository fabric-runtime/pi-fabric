import {
  type SelectListLayoutOptions,
  type Component,
  type SettingsListTheme,
  type SelectListTheme,
  type SelectItem,
  type SettingItem,
  Container,
  Input,
  Text,
  Spacer,
  SelectList,
  SettingsList,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  unique,
  BOOLEANS,
  COMPACTION_DEFAULT_THRESHOLD_LABEL,
  COMPACTION_PERCENT_OPTION_LABEL,
  COMPACTION_TOKENS_OPTION_LABEL,
  COMPACTION_PERCENT_MIN,
  COMPACTION_PERCENT_MAX,
  clampCompactionPercentThreshold,
  parseFormattedNumericValue,
  formatTokens,
} from "./settings-values.js";
import {
  MIN_COMPACTION_TOKEN_THRESHOLD,
  MAX_COMPACTION_TOKEN_THRESHOLD,
  clampCompactionTokenThreshold,
} from "../config.js";
import {
  THINKING_LEVELS,
  thinkingLabel,
} from "../thinking.js";
import {
  type ModelSource,
  INHERIT_VALUE,
} from "./model-picker.js";
import { FabricModelSelector } from "./fabric-model-selector.js";

const SUBMENU_LAYOUT: SelectListLayoutOptions = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 32,
};

type SettingsSubmenu = (currentValue: string, done: (selectedValue?: string) => void) => Component;

export const settingsListTheme = (theme: Theme): SettingsListTheme => ({
  label: (text, selected) => (selected ? theme.fg("accent", text) : text),
  value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
  description: (text) => theme.fg("dim", text),
  cursor: theme.fg("accent", "→ "),
  hint: (text) => theme.fg("dim", text),
});

const selectListTheme = (theme: Theme): SelectListTheme => ({
  selectedPrefix: (text) => theme.fg("accent", text),
  selectedText: (text) => theme.fg("accent", text),
  description: (text) => theme.fg("muted", text),
  scrollInfo: (text) => theme.fg("muted", text),
  noMatch: (text) => theme.fg("muted", text),
});

const numericOptions = (
  values: readonly number[],
  format: (value: number) => string,
  currentValue: string,
): SelectItem[] => {
  const options: SelectItem[] = values.map((value) => ({
    value: String(value),
    label: format(value),
  }));
  if (!options.some((option) => option.value === currentValue || option.label === currentValue)) {
    options.unshift({ value: currentValue, label: currentValue });
  }
  return options;
};

export const setting = (
  id: string,
  label: string,
  currentValue: string,
  rest: {
    description?: string;
    values?: readonly string[];
    submenu?: SettingsSubmenu;
  } = {},
): SettingItem => {
  const item: SettingItem = { id, label, currentValue };
  if (rest.description !== undefined) item.description = rest.description;
  if (rest.values !== undefined) item.values = [...rest.values];
  if (rest.submenu !== undefined) item.submenu = rest.submenu;
  return item;
};

export const numericSubmenu = (
  theme: Theme,
  values: readonly number[],
  format: (value: number) => string,
  title: string,
  description: string,
): SettingsSubmenu => (currentValue, done) => {
  const options = numericOptions(values, format, currentValue);
  const selectedValue =
    options.find((option) => option.value === currentValue || option.label === currentValue)?.value ??
    currentValue;
  return new SelectSubmenu(
    theme,
    title,
    description,
    options,
    selectedValue,
    (value) => done(options.find((option) => option.value === value)?.label ?? value),
    () => done(),
  );
};

export const nonNegativeIntegerSubmenu = (
  theme: Theme,
  title: string,
  description: string,
): SettingsSubmenu => (currentValue, done) =>
  new IntegerInputSubmenu(theme, title, description, currentValue, done, () => done());

export const probabilitySubmenu = (
  theme: Theme,
  title: string,
  description: string,
): SettingsSubmenu => (currentValue, done) =>
  new ProbabilityInputSubmenu(theme, title, description, currentValue, done, () => done());

export const stringInputSubmenu = (
  theme: Theme,
  title: string,
  description: string,
): SettingsSubmenu => (currentValue, done) =>
  new StringInputSubmenu(theme, title, description, currentValue, done, () => done());

export const compactionThresholdSubmenu = (theme: Theme): SettingsSubmenu => (currentValue, done) =>
  new CompactionThresholdSubmenu(theme, currentValue, done);

export const stringOptionsSubmenu = (
  theme: Theme,
  values: readonly string[],
  title: string,
  description: string,
): SettingsSubmenu => (currentValue, done) => {
  const options = values.map((value) => ({ value, label: value }));
  if (!options.some((option) => option.value === currentValue)) {
    options.unshift({ value: currentValue, label: currentValue });
  }
  const selectedValue =
    options.find((option) => option.value === currentValue || option.label === currentValue)
      ?.value ?? currentValue;
  return new SelectSubmenu(
    theme,
    title,
    description,
    options,
    selectedValue,
    (value) => done(value),
    () => done(),
  );
};

export const listSubmenu = (
  theme: Theme,
  id: string,
  title: string,
  description: string,
  candidates: readonly string[],
  currentList: readonly string[],
  onCommit: (selected: string[]) => void,
): SettingsSubmenu => {
  const prefix = `${id}.`;
  return (_currentValue, done) => {
    const items = unique([...candidates, ...currentList]).map((name) =>
      setting(`${id}.${name}`, name, currentList.includes(name) ? "true" : "false", {
        description: `Toggle ${name}.`,
        values: BOOLEANS,
      }),
    );
    const onChange = (_itemId: string, _newValue: string): void => {
      const selected = items
        .filter((item) => item.currentValue === "true")
        .map((item) => item.id.slice(prefix.length));
      onCommit(selected);
    };
    return new SectionSubmenu(theme, title, description, items, onChange, () => done(), true);
  };
};

// Append a › to the label of every item that opens a submenu, so it is
// obvious which rows drill in (vs. inline value cycling). Mutates in place to
// preserve the shared item references that listSubmenu updates live.
export const markDrillIn = (items: SettingItem[]): SettingItem[] => {
  for (const item of items) {
    if (item.submenu && !item.label.endsWith("›")) item.label = `${item.label} ›`;
  }
  return items;
};

export const sectionSubmenu = (
  theme: Theme,
  title: string,
  description: string,
  items: SettingItem[] | (() => SettingItem[]),
  persist: (id: string, value: string) => void,
  // A factory can defer discovery without opting into rebuilding static editor rows.
  options: { refreshOnChange?: boolean } = {},
): SettingsSubmenu => (_currentValue, done) => {
  const getItems = () => markDrillIn(typeof items === "function" ? items() : items);
  // Match the root page: sections get type-to-search filtering too.
  return new SectionSubmenu(theme, title, description, getItems(), persist, () => done(), true,
    typeof items === "function" && options.refreshOnChange !== false ? getItems : undefined);
};

abstract class NumericInputSubmenu extends Container {
  abstract validate(value: string): string | undefined;
  readonly input: Input;
  private readonly validationText: Text;

  constructor(
    theme: Theme,
    title: string,
    description: string,
    currentValue: string,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("muted", description), 0, 0));
    this.addChild(new Spacer(1));

    this.input = new Input();
    this.input.handleInput(currentValue);
    this.input.focused = true;
    this.validationText = new Text("", 0, 0);
    this.input.onSubmit = (value) => {
      const error = this.validate(value);
      if (error) {
        this.validationText.setText(theme.fg("error", error));
        return;
      }
      onSelect(String(Number(value.trim())));
    };
    this.input.onEscape = onCancel;
    this.addChild(this.input);
    this.addChild(this.validationText);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to go back"), 0, 0));
  }

  handleInput(data: string): void {
    this.validationText.setText("");
    this.input.handleInput(data);
  }

  render(width: number): readonly string[] {
    this.input.focused = true;
    return super.render(width);
  }

  submitRpc(value: string): void {
    this.input.setValue(value);
    this.input.handleInput("\r");
  }
}

export class IntegerInputSubmenu extends NumericInputSubmenu {
  validate(value: string): string | undefined {
    const normalized = value.trim();
    return /^\d+$/.test(normalized) && Number.isSafeInteger(Number(normalized))
      ? undefined : "Enter a non-negative safe integer.";
  }
}

export class ProbabilityInputSubmenu extends NumericInputSubmenu {
  validate(value: string): string | undefined {
    const normalized = value.trim();
    const parsed = Number(normalized);
    return normalized && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
      ? undefined : "Enter a probability between 0 and 1.";
  }
}

export class StringInputSubmenu extends Container {
  readonly input: Input;

  constructor(
    theme: Theme,
    title: string,
    description: string,
    currentValue: string,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("muted", description), 0, 0));
    this.addChild(new Spacer(1));

    this.input = new Input();
    this.input.handleInput(currentValue);
    this.input.focused = true;
    this.input.onSubmit = (value) => onSelect(value.trim());
    this.input.onEscape = onCancel;
    this.addChild(this.input);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to go back"), 0, 0));
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  render(width: number): readonly string[] {
    this.input.focused = true;
    return super.render(width);
  }

  submitRpc(value: string): void {
    this.input.setValue(value);
    this.input.handleInput("\r");
  }
}

export class SelectSubmenu extends Container {
  readonly selectList: SelectList;
  readonly options: SelectItem[];

  constructor(
    theme: Theme,
    title: string,
    description: string | undefined,
    options: SelectItem[],
    currentValue: string,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.options = options;
    this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
    if (description) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(theme.fg("muted", description), 0, 0));
    }
    this.addChild(new Spacer(1));
    this.selectList = new SelectList(
      options,
      Math.min(options.length, 10),
      selectListTheme(theme),
      SUBMENU_LAYOUT,
    );
    const index = options.findIndex((option) => option.value === currentValue);
    if (index !== -1) this.selectList.setSelectedIndex(index);
    this.selectList.onSelect = (item) => onSelect(item.value);
    this.selectList.onCancel = onCancel;
    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
  }

  selectRpc(value: string): boolean {
    const option = this.options.find((candidate) => candidate.value === value);
    if (!option) return false;
    this.selectList.onSelect?.(option);
    return true;
  }
}

// Three-phase threshold picker: the root select offers Pi default plus
// custom percent / token drill-ins; each drill-in swaps in an integer input
// and Esc returns to the root select instead of closing the submenu.
export class CompactionThresholdSubmenu extends Container {
  selectList: SelectList | undefined;
  input: Input | undefined;
  private active!: Container & { handleInput(data: string): void };

  constructor(
    private readonly theme: Theme,
    private readonly currentValue: string,
    private readonly done: (selectedValue?: string) => void,
  ) {
    super();
    this.showSelect();
  }

  private swap(next: Container & { handleInput(data: string): void }): void {
    this.clear();
    this.addChild(next);
    this.active = next;
  }

  private showSelect(): void {
    const options: SelectItem[] = [
      { value: COMPACTION_DEFAULT_THRESHOLD_LABEL, label: COMPACTION_DEFAULT_THRESHOLD_LABEL },
      { value: COMPACTION_PERCENT_OPTION_LABEL, label: COMPACTION_PERCENT_OPTION_LABEL },
      { value: COMPACTION_TOKENS_OPTION_LABEL, label: COMPACTION_TOKENS_OPTION_LABEL },
    ];
    const select = new SelectSubmenu(
      this.theme,
      "Compaction threshold",
      "Percent of the context window that triggers compaction, or an exact token count, entered via the custom options.",
      options,
      this.currentValue,
      (value) => {
        if (value === COMPACTION_PERCENT_OPTION_LABEL) this.showPercent();
        else if (value === COMPACTION_TOKENS_OPTION_LABEL) this.showTokens();
        else this.done(value);
      },
      () => this.done(),
    );
    this.selectList = select.selectList;
    this.input = undefined;
    this.swap(select);
  }

  private showPercent(): void {
    const percent = /^(\d+)%$/.exec(this.currentValue);
    const inputSubmenu = new IntegerInputSubmenu(
      this.theme,
      "Compaction percent threshold",
      `Compaction triggers once context usage reaches this percent of its window (${COMPACTION_PERCENT_MIN}–${COMPACTION_PERCENT_MAX}).`,
      percent?.[1] ?? "",
      (value) => this.done(`${clampCompactionPercentThreshold(Number(value))}%`),
      () => this.showSelect(),
    );
    this.selectList = undefined;
    this.input = inputSubmenu.input;
    this.swap(inputSubmenu);
  }

  private showTokens(): void {
    const tokens = /^(.+?) tokens$/.exec(this.currentValue);
    const prefilled = tokens?.[1] === undefined
      ? ""
      : String(parseFormattedNumericValue(tokens[1]));
    const inputSubmenu = new IntegerInputSubmenu(
      this.theme,
      "Compaction token threshold",
      `Compaction triggers once context usage reaches this many tokens (${MIN_COMPACTION_TOKEN_THRESHOLD}–${MAX_COMPACTION_TOKEN_THRESHOLD}).`,
      prefilled,
      (value) => this.done(`${formatTokens(clampCompactionTokenThreshold(Number(value)))} tokens`),
      () => this.showSelect(),
    );
    this.selectList = undefined;
    this.input = inputSubmenu.input;
    this.swap(inputSubmenu);
  }

  handleInput(data: string): void {
    this.active.handleInput(data);
  }

  completeRpc(selectedValue: string): void {
    this.done(selectedValue);
  }
}

export const thinkingSubmenu = (
  theme: Theme,
  overrides: {
    title?: string;
    description?: string;
    // Label of an extra first option that clears the override (persists "").
    inheritLabel?: string;
  } = {},
): SettingsSubmenu => (currentValue, done) => {
  const canonicalCurrent =
    THINKING_LEVELS.find((level) => thinkingLabel(level) === currentValue) ?? currentValue;
  const options: SelectItem[] = THINKING_LEVELS.map((level) => ({
    value: level,
    label: thinkingLabel(level),
  }));
  if (overrides.inheritLabel) {
    options.unshift({ value: overrides.inheritLabel, label: overrides.inheritLabel });
  }
  if (!options.some((option) => option.value === canonicalCurrent)) {
    options.unshift({ value: canonicalCurrent, label: currentValue });
  }
  return new SelectSubmenu(
    theme,
    overrides.title ?? "Default thinking",
    overrides.description ??
      "Reasoning effort forwarded to spawned agents and actors when a call does not specify one. The level is clamped to each model's supported levels (next highest if unsupported).",
    options,
    canonicalCurrent,
    (value) => done(options.find((option) => option.value === value)?.label ?? value),
    () => done(),
  );
};

export const modelPickerSubmenu = (
  theme: Theme,
  source: ModelSource,
  options: {
    headerText?: string;
    inheritLabel?: string;
    inheritName?: string;
  } = {},
): SettingsSubmenu => (currentValue, done) => {
  const canonicalCurrent =
    options.inheritLabel && currentValue === options.inheritLabel
      ? INHERIT_VALUE
      : currentValue;
  return new FabricModelSelector({
    theme,
    source,
    currentValue: canonicalCurrent,
    onSelect: (value) =>
      done(
        value === INHERIT_VALUE && options.inheritLabel
          ? options.inheritLabel
          : value,
      ),
    onCancel: () => done(),
    ...(options.headerText ? { headerText: options.headerText } : {}),
    ...(options.inheritLabel ? { inheritLabel: options.inheritLabel } : {}),
    ...(options.inheritName ? { inheritName: options.inheritName } : {}),
  });
};

export class SectionSubmenu extends Container {
  settingsList: SettingsList;
  readonly items: SettingItem[];
  readonly applyChange: (id: string, newValue: string) => void;

  constructor(
    theme: Theme,
    title: string,
    description: string | undefined,
    items: SettingItem[],
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
    enableSearch = false,
    refreshItems?: () => SettingItem[],
  ) {
    super();
    this.items = items;
    const createList = () => new SettingsList(this.items, Math.min(this.items.length, 16),
      settingsListTheme(theme), this.applyChange, onCancel, { enableSearch });
    this.applyChange = (id, value) => {
      onChange(id, value);
      if (!refreshItems) return;
      // Preserve the array identity used by the RPC browser as well as the TUI.
      this.items.splice(0, this.items.length, ...refreshItems());
      this.removeChild(this.settingsList);
      this.settingsList = createList();
      this.settingsList.selectItem?.(id);
      this.addChild(this.settingsList);
    };
    this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
    if (description) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(theme.fg("muted", description), 0, 0));
    }
    this.addChild(new Spacer(1));
    this.settingsList = createList();
    this.addChild(this.settingsList);
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data);
  }
}
