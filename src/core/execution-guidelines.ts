import type { FabricKernel } from "../runtime/kernel.js";

// Keep this authored rule source eager with registration. Lazy delivery receives
// the strings as arguments instead of creating another shared startup chunk.

const schemaDiscipline = "Form a falsifiable hypothesis covering the reported failure and affected paths. Let contrary evidence invalidate the plan. Verify postconditions before declaring success.";
const taskDiscipline = "Be ambitious and persistent: work through uncertainty, try alternatives, and verify the result. Treat new requests as additive, not replacements; keep existing work progressing unless explicitly reprioritized.";

/** One source for tool metadata and provider-portable execution instructions. */
export const fabricExecutionGuidelines = (
  kernel: FabricKernel = "typescript",
  pythonRuntime: "cpython" | "monty" = "monty",
  managedHost = false,
): string[] => managedHost ? [
  "Batch independent operations with bounded concurrency, keep dependent calls ordered, inspect results, and return compact evidence.",
  schemaDiscipline,
  taskDiscipline,
] : [
  kernel === "python"
    ? "Batch independent I/O in one `fabric_exec` Python program with `asyncio.gather`; await dependent steps sequentially. Coalesce independent replacements into one `await pi.edit(path=..., edits=[...])`. Inspect findings before choosing dependent reads or edits. Background long-running work when independent tasks can proceed; collect its result before completion. Return JSON-compatible evidence."
    : "Batch independent I/O in one `fabric_exec` program (`Promise.all` for parallel, sequential `await` for ordered). Coalesce independent replacements from one file snapshot into one `pi.edit({path, edits:[...]})`; use `all:true` only for intentional repeated exact anchors. Inspect findings before choosing dependent reads or edits. Background long-running work when independent tasks can proceed; collect its result before completion.",
  kernel === "python"
    ? "Search before reading with `await pi.grep(pattern=..., path=...)` or `await pi.find(pattern=..., path=...)`, then `await pi.read(path=..., offset=..., limit=...)`. Use Python dict syntax, `True`/`False`/`None`, and bounded searches; unbounded reads cap at 2000 lines or 50KB. Read continuation notices when needed."
    : "Search before reading: use `pi.grep`/`pi.find` to locate relevant lines, then `pi.read({path, offset, limit})` that range. Escape regex metacharacters, or use `literal:true` for exact punctuated text. Keep fan-out search limits small and widen only on misses. An unbounded `pi.read` returns at most 2000 lines or 50KB and, when truncated, ends with a `Use offset=…` continuation notice; reserve whole-file reads for small files you will use in full.",
  schemaDiscipline,
  taskDiscipline,
  "For edits/writes, pass named payloads through top-level `payloads`; each `π.key` must exactly match a key there; prefer `pi.edit`/`pi.write`. `pi.bash`: no stdin.",
  "Use `display.name` and objective `display.description`; Fabric pairs them with verified outcomes in deterministic compaction.",
  ...(kernel === "python" && pythonRuntime === "monty" ? ["Monty requires acyclic JSON host arguments. For underscore-prefixed provider/tool names, use `await tools.call(ref=..., args={...})`, not direct attributes. Use `payloads['key']` for private/non-identifier payload keys."] : []),
];

/** All owned variants, including rules registered before a kernel change. */
export const fabricOwnedExecutionGuidelines = (): string[] => [...new Set([
  ...fabricExecutionGuidelines(),
  ...fabricExecutionGuidelines("python", "monty"),
  ...fabricExecutionGuidelines("python", "cpython"),
  ...fabricExecutionGuidelines("typescript", "monty", true),
])];
