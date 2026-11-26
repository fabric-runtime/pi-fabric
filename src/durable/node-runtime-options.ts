// TypeScript allocates substantial short-lived parser/checker data. Keep
// that part of the owned SDK process's V8 heap smaller without capping old
// space (which holds Pi's live context) or changing the Fabric guest heap.
export const durableTypeScriptNodeArgs = (
  kernel: string | undefined,
  nodeOptions = process.env.NODE_OPTIONS,
): readonly string[] => kernel === "typescript" && !nodeOptions?.trim()
  ? ["--max-semi-space-size=4"]
  : [];
