import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricConfig } from "../config.js";

export const modelCompactionKey = (
  model: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id"> | undefined,
): string | undefined => model ? `${model.provider}/${model.id}` : undefined;

// A configured token threshold takes precedence over a ratio for the same
// model; the settings UI keeps the maps mutually exclusive, and hand-written
// configs resolve to the more explicit token value.
const configuredCompactionTokenThreshold = (
  config: FabricConfig,
  modelKey: string | undefined,
): number | undefined =>
  modelKey === undefined ? undefined : config.compaction.tokenThresholds[modelKey];

const configuredCompactionThreshold = (
  config: FabricConfig,
  modelKey: string | undefined,
): number | undefined =>
  modelKey === undefined ? undefined : config.compaction.thresholds[modelKey];

const runThresholdCompact = (
  context: ExtensionContext,
): Promise<boolean> => new Promise<boolean>((resolve) => {
  if (context.signal?.aborted) {
    resolve(false);
    return;
  }
  context.compact({
    onComplete: () => resolve(true),
    onError: (error) => {
      if (context.hasUI) {
        context.ui.notify(`Fabric threshold compaction failed: ${error.message}`, "warning");
      }
      resolve(false);
    },
  });
});

export type AutoCompactionTrigger = "headroom" | "tokens" | "ratio";

// Headroom left in the window for the next response. `outputReserveTokens`
// of 0 disables the trigger; unknown usage never triggers.
export const outputReserveBreached = (
  usage: { tokens: number | null; contextWindow: number } | undefined,
  outputReserveTokens: number,
): boolean =>
  outputReserveTokens > 0
  && usage !== undefined
  && usage.tokens !== null
  && Number.isFinite(usage.contextWindow)
  && usage.contextWindow > 0
  && usage.contextWindow - usage.tokens < outputReserveTokens;

const autoCompactionTrigger = (
  context: ExtensionContext,
  config: FabricConfig,
): AutoCompactionTrigger | undefined => {
  const modelKey = modelCompactionKey(context.model);
  const usage = context.getContextUsage();
  if (usage === undefined) return undefined;

  if (outputReserveBreached(usage, config.compaction.outputReserveTokens)) return "headroom";

  const tokenThreshold = configuredCompactionTokenThreshold(config, modelKey);
  if (tokenThreshold !== undefined) {
    return usage.tokens !== null && usage.tokens >= tokenThreshold ? "tokens" : undefined;
  }

  const threshold = configuredCompactionThreshold(config, modelKey);
  if (threshold === undefined || usage.percent === null) return undefined;
  return usage.percent / 100 >= threshold ? "ratio" : undefined;
};

export const compactAtConfiguredThreshold = async (
  context: ExtensionContext,
  config: FabricConfig,
  onTrigger?: (trigger: AutoCompactionTrigger, committed: boolean) => void,
): Promise<boolean> => {
  if (context.signal?.aborted) return false;
  const trigger = autoCompactionTrigger(context, config);
  if (trigger === undefined) return false;
  const committed = await runThresholdCompact(context);
  onTrigger?.(trigger, committed);
  return committed;
};
