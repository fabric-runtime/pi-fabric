import type { FabricKernel } from "../runtime/kernel.js";

// Keep this authored rule source eager with registration. Lazy delivery receives
// the strings as arguments instead of creating another shared startup chunk.

/** One source for tool metadata and provider-portable execution instructions. */
export const fabricExecutionGuidelines = (
  kernel: FabricKernel = "typescript",
  pythonRuntime: "cpython" | "monty" = "monty",
  managedHost = false,
): string[] => managedHost ? [
  "Batch independent operations with bounded concurrency, keep dependent calls ordered, inspect results, and return compact evidence.",
] : [
  kernel === "python"
    ? "Batch independent operations in one `fabric_exec` Python program with `asyncio.gather`; await dependent/conditional steps sequentially. Coalesce independent replacements into one `await pi.edit(path=..., edits=[...])`. Return only the compact final JSON-compatible value."
    : "Batch independent operations in one `fabric_exec` program (`Promise.all` for parallel, sequential `await` for ordered), not one call per tool; keep dependent/conditional steps sequential. Coalesce non-dependent replacements from one file snapshot into one `pi.edit({path, edits:[...]})`; use `all:true` only for intentional repeated exact anchors. Return only the compact final value; intermediate results stay in the sandbox.",
  kernel === "python"
    ? "Search before reading with `await pi.grep(pattern=..., path=...)` or `await pi.find(pattern=..., path=...)`, then `await pi.read(path=..., offset=..., limit=...)`. Use Python dict syntax, `True`/`False`/`None`, and bounded searches; unbounded reads cap at 2000 lines or 50KB. Read continuation notices when needed."
    : "Search before reading: use `pi.grep`/`pi.find` to locate relevant lines, then `pi.read({path, offset, limit})` that range. Escape regex metacharacters, or use `literal:true` for exact punctuated text. Keep fan-out search limits small and widen only on misses. An unbounded `pi.read` returns at most 2000 lines or 50KB and, when truncated, ends with a `Use offset=…` continuation notice; reserve whole-file reads for small files you will use in full.",
  "Keep the acceptance ledger in reasoning or concise progress notes (no tool call): define concrete checks, trace execution before editing, implement end to end, then run targeted tests and direct behavioral probes. Confirm requested public symbols, registrations, and configuration entries. Use the smallest checks that cover the ledger; escalate only for failures or cross-cutting risk. Inspect failures and iterate instead of rerunning unchanged passing checks. A build alone is not completion.",
  kernel === "python"
    ? "For test/probe nonzero exits, use `await pi.bash(command=..., settle=True)` and inspect the returned dict: `r['ok']`, `r['output']`, and `r.get('exitCode')`. Set shell `timeout` in seconds once for long suites. Return decisions and evidence rather than raw logs."
    : "Amortize round trips without inflating context: batch only independent, bounded work. Keep search→read and edit→verify sequential when an output determines the next action. Use `settle:true` for tests or probes whose nonzero result is evidence rather than an exceptional stop; for a known long suite, set `pi.bash` `timeout` in seconds once instead of retrying a timed-out call. Filter or summarize noisy command output inside the program and return decisions, failures, and evidence—not raw logs or unused intermediate results.",
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
