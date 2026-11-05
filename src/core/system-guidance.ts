import type { FabricKernel } from "../runtime/kernel.js";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

// jev-fabric verbs for any background task; durable tasks and interactive
// sessions exist only where jev-fabric can run (not Windows).
const SHELL_COMPOSITION_GUIDANCE =
  " tasks.read (byte offset/next, waitMs long-poll) and tasks.watch with {id, match} read or filter any background task without a monitor." +
  (process.platform === "win32" ? "" : " With jev-fabric (see tasks/sessions via tools.describe): pi.bash durable:true outlives Pi and reattaches on resume; sessions.open/write/read/stop drive interactive children (a Jev program's end with it).");

export const fabricExecutionKernelGuidance = (fullCodeMode: boolean, kernel: FabricKernel = "typescript", pythonRuntime: "cpython" | "monty" = "monty", profile: "additive" | "native" = "additive"): string =>
  [
    kernel === "python"
      ? `Configured fabric_exec kernel: Python (${pythonRuntime === "monty" ? "Monty sandboxed subset" : "CPython"}). Write Python only in \`code\`: top-level await/return, dicts, True/False/None, and asyncio.gather. There is no per-call language switch.`
      : profile === "native"
        ? "Configured fabric_exec kernel: TypeScript with native Pi codemode API. Write JavaScript async function bodies; top-level await and return work. Native source is not type-checked or repaired."
        : "Configured fabric_exec kernel: TypeScript. Write TypeScript only in `code`; top-level await and return are supported.",
    "The configured kernel is exclusive for Fabric orchestration, including when skills or earlier messages show another language. Do not invoke another interpreter through shell tools or native subprocesses merely to run Fabric orchestration in a different language. Project builds, tests, and explicitly requested interpreter work remain legitimate shell commands.",
    fullCodeMode
      ? "Pi Fabric full code mode: `fabric_exec` is the only way to call Pi core tools — use them as `pi.*` inside `code`."
      : "Pi Fabric is in orchestration-only mode. Pi core and registered extension tools stay on their native direct execution path; inside fabric_exec, `pi.*` and `extensions.*` are unavailable.",
    // Files the model has not opened (images in particular) must be read before
    // use; this line rides the turn-stable kernel guidance so provider prefix
    // caches stay warm.
    `Read files the user provides with the ${fullCodeMode ? "`pi.read`" : "`read`"} tool before relying on their contents, unless their contents are already included in the conversation. When an image or supplied vision-handoff description is present, use it without reading the path again. [Attached image: ...] labels identify source paths, not proof that image content is available. If image content is unavailable, say so; never infer it from the filename.`,
  ].join(" ");

export const defaultFabricExecutionGuidance = (fullCodeMode: boolean, kernel: FabricKernel = "typescript", pythonRuntime: "cpython" | "monty" = "monty", profile: "additive" | "native" = "additive"): string =>
  kernel === "typescript" && profile === "native"
    ? "Native Pi codemode profile: tools.<name>(args) and nativeTools.<name>(args) use native results, including schema-backed error envelopes. searchTools/ALL_TOOLS return callable identifiers; describeTool returns a declaration string. image() emits images and saves host-side temporary artifacts. store/load share Pi codemode-store entries on this branch. Fabric discovery remains fabric.tools; pi.*, mcp.* and extensions.* keep Fabric result semantics. Policies and limits are unchanged. " + defaultFabricExecutionGuidance(fullCodeMode, kernel, pythonRuntime).replaceAll("tools.", "fabric.tools.").replaceAll("`tools`", "`fabric.tools`")
    : kernel === "python"
    ? (pythonRuntime === "monty"
      ? "Python backend: Monty sandboxed subset, not CPython. Native filesystem/network/environment access and arbitrary imports are unavailable; use host tools for effects. Supply acyclic JSON host arguments; recursive containers are unsupported. Underscore-prefixed direct capability attributes are unavailable: use tools.call with the exact discovered ref instead. π is an attribute object; payloads is a dict, not the same identity. "
      : "Python backend: CPython; native standard-library imports are available. ") + "Python fabric_exec: write an async function body with `await` and `return`; each invocation starts fresh. Use imports supported by the configured backend, such as `import asyncio`. Host methods accept one dict or keyword arguments: `await tools.search(query=\"example\")`, `await tools.call(ref=\"provider.action\", args={\"key\": \"value\"})`; discover with tools.search instead of enumerating: tools.list is a capped page (default 100, hard cap 1000) with no truncation marker, so a short result never proves an action is absent (tools.list(envelope=True) reports totals). Known actions use mcp.<server>.<tool>, memory.*, state.*, schema.*, compact.*, components.*, agents.*, or mesh.*. Responses are native Python dicts/lists, not attribute objects. Use `asyncio.gather` for independent calls. `π.key` and `payloads[\"key\"]` contain only the exact top-level payload keys. Return JSON-compatible data (convert sets, bytes, paths, and datetimes explicitly); print output is bounded. JavaScript callback helpers (workflow, memory.walk, and predicate callbacks) are not Python APIs; page with ordinary await/loops instead. Provider argument validation and approvals remain host-enforced. Schema enforce retains host gates and requires the selected runtime’s isolation; no unrestricted fallback." + (fullCodeMode ? " `await pi.read(\"/x\")`, `await pi.grep(pattern=\"TODO\", path=\"src\")`, `await pi.find(pattern=\"*.py\", path=\"src\")`, and `await pi.ls(\"src\")` return strings. `await pi.bash(command=\"ls\")`, `await pi.edit(path=\"/x\", oldText=\"a\", newText=\"b\")`, and `await pi.write(path=\"/y\", content=π.body)` return dicts; read `r[\"output\"]`. Shell nonzero exits raise; `settle=True` returns a failure dict instead. Cancellation, timeout, approval and security errors still raise. A nested shell that exceeds executor.shellHangMs still resolves ok with a still-running notice, pid, and live output path; background=True detaches immediately. Detached results include details.taskId; completion notifies this session. Use tools.call(ref='tasks.list', args={}), tasks.get or tasks.stop with {'id': taskId}; pi.read can read the bounded log. Bounded controllers can await tasks.wait or tasks.watch (monitor batches, after cursor) without polling; timeout/cancellation affects only the observation. Opt-in monitor={'delivery':'wake','match':'literal','timeoutMs':300000,'intervalMs':5000} (choose delivery 'ui' or 'wake') also detaches: UI-only never wakes the agent, wake sends coalesced line events. Monitors expire and are not automatically renewed." + SHELL_COMPOSITION_GUIDANCE + " Captured tools are `await extensions.<name>(...)`." : " Pi core and extensions are unavailable inside fabric_exec in orchestration-only mode.")
    : fullCodeMode
    ? "Examples and returns: `pi.read('/x')`, `pi.grep('TODO','src')` / `pi.grep({pattern:'TODO', path:'src', ignoreCase:true, context:2})`, `pi.find({pattern:'*.ts', path:'src', limit:20})`, and `pi.ls('src')` return strings; `pi.bash({cmd:'ls'})` (or `pi.powershell` on Windows), `pi.edit({path:'/x', old:'a', new:'b'})`, and `pi.write({path:'/y', text:'z'})` return `{ok, output, details}` (read `.output`); failed core calls reject, including shell tools on an ordinary nonzero exit; pass `settle: true` to `pi.bash` or `pi.powershell` to get `{ ok: false, exitCode, output, error }` instead. Timeout, cancellation, approval, and security failures still reject. A nested shell that exceeds `executor.shellHangMs` still resolves `ok: true` with a still-running notice, pid, and live output path; `background: true` detaches immediately. Detached results include `details.taskId`; completion notifies this session, without polling. Use `tools.call({ref:'tasks.list',args:{}})` or `tasks.get`/`tasks.stop` with `{id: taskId}`; `pi.read` can read the bounded log. Bounded controllers can await `tasks.wait` or `tasks.watch` (monitor batches, `after` cursor) without polling; timeout/cancellation affects only the observation. Opt-in `monitor:{delivery:'ui'|'wake',match:'literal',timeoutMs:300000,intervalMs:5000}` also detaches: UI-only never wakes the agent, wake sends coalesced line events. Monitors expire and are not automatically renewed." + SHELL_COMPOSITION_GUIDANCE + "\n`tools` exposes discovery/generic calls (`providers`/`catalog`/`list`/`search`/`describe`/`call`) plus the native `models` namespace. `models === tools.models`; `tools.models()` retains legacy model listing. Use `await models.getAvailableOfType('classifier')` (or `'image'`), then `models.classify(model,{state,questions})` or `models.generateImages(model,{input})`. Check native `stopReason`/`errorMessage`; classifier yes/no questions use `type:'bool'` and return `probability`. Call known MCP tools as `mcp.<sanitized_server>.<sanitized_tool>(args)`, captured tools as `extensions.<tool>(args)`, and stable providers as `memory.*`, `state.*`, `schema.*`, or `compact.*`. Use `tools.call({ref,args})` for computed refs. `pi` is the core tools; `π.<key>` reads named `strings` (not a tool)."
    : "Call known actions through `mcp.<sanitized_server>.<sanitized_tool>(args)`, `memory.*`, `state.*`, `schema.*`, `components.*`, `compact.*`, `agents.*`, or `mesh.*`; use `tools.catalog`/`search`/`describe`/`list` for discovery and `tools.call({ref,args})` for computed refs. Other surfaces are opt-in via user-loaded skills.";

// Shape of CapturedToolCatalog entries this renderer needs (kept structural to avoid a runtime dependency on the capture layer from a guidance module).
export interface ExtensionRosterToolSource {
  name: string;
  sourceInfo?: { source?: string; path?: string };
}

// Namespace labels come from the extension package's own identity: the
// package.json `name` nearest the tool's source file, mirroring how pi names
// npm-installed packages. Raw `source` strings are configured specifiers that
// are often full relative paths, so they are only used when no manifest exists.
const manifestNameCache = new Map<string, string | undefined>();

const packageNameFromManifest = (startPath: string | undefined): string | undefined => {
  if (!startPath) return undefined;
  let directory = path.dirname(path.resolve(startPath));
  // Every folder the walk passes through resolves to the same answer, so the
  // result is cached for all of them. Caching undefined for a folder below the
  // manifest would make a later lookup that starts there miss the name.
  const visited: string[] = [];
  const settle = (name: string | undefined): string | undefined => {
    for (const folder of visited) manifestNameCache.set(folder, name);
    return name;
  };
  while (true) {
    if (manifestNameCache.has(directory)) return settle(manifestNameCache.get(directory));
    visited.push(directory);
    const manifestPath = path.join(directory, "package.json");
    let name: string | undefined;
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
        if (typeof manifest.name === "string" && manifest.name.trim()) name = manifest.name.trim();
      } catch {
        // Unreadable or invalid manifest; keep walking upward.
      }
    }
    if (name) return settle(name);
    const parent = path.dirname(directory);
    if (parent === directory) return settle(undefined);
    directory = parent;
  }
};

// In full code mode the model sees only fabric_exec in its tool list, so
// registered extension tools are invisible unless named up front (#69). The
// roster stays names-only: descriptions and schemas are on demand through the
// tools.list/search/describe discovery surface, so the standing prompt cost is
// a bare name index. Core overrides are excluded: they surface as pi.* via
// coreOverridePromptGuidance.
export const extensionToolRosterGuidance = (
  tools: ReadonlyArray<ExtensionRosterToolSource>,
  coreToolNames: ReadonlySet<string>,
  nativeProfile = false,
): string | undefined => {
  const extensionTools = tools.filter((tool) => !coreToolNames.has(tool.name));
  if (extensionTools.length === 0) return undefined;
  const namespaceLabel = (tool: ExtensionRosterToolSource): string => {
    const source = tool.sourceInfo?.source?.trim();
    if (source?.startsWith("npm:")) return source.slice("npm:".length) || source;
    const manifestName =
      packageNameFromManifest(tool.sourceInfo?.path) ??
      packageNameFromManifest(source && /[\\/]/.test(source) ? source : undefined);
    if (manifestName) return manifestName;
    if (source && !/[\\/]/.test(source)) return source;
    const parts = (tool.sourceInfo?.path ?? source ?? "").split(/[\\/]/).filter(Boolean);
    const base = parts.at(-1)?.trim() ?? "";
    // Entry files like index.js name the package directory, not the source.
    if (/^index\./i.test(base)) return parts.at(-2)?.trim() || base;
    return base || "extensions";
  };
  const groups = new Map<string, string[]>();
  for (const tool of [...extensionTools].sort((left, right) => left.name.localeCompare(right.name))) {
    const label = namespaceLabel(tool);
    const names = groups.get(label);
    if (names) names.push(tool.name);
    else groups.set(label, [tool.name]);
  }
  return [
    `Registered extension tools are callable inside fabric_exec as \`extensions.<name>(args)\`; run \`${nativeProfile ? "fabric.tools" : "tools"}.list\` for full descriptions and schemas before re-implementing an effect with pi.bash.`,
    ...[...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, names]) => "- " + label + ": " + names.join(", ")),
  ].join("\n");
};

export const fabricSchemaGuidance = (mode: "off" | "audit" | "enforce"): string | undefined => {
  if (mode === "enforce") {
    return "Schema enforce mode is fixed for this session. Reads remain available, but protected-workspace changes must use schema.hypothesize → schema.verify → schema.commit in the same fabric_exec invocation. Direct pi.edit/write/bash/powershell, agents, state/mesh writes, compaction requests, MCP, extensions, and external providers are blocked by the host gate.";
  }
  if (mode === "audit") {
    return "Schema audit mode reports actions that enforce mode would block, but preserves their current behavior.";
  }
  return undefined;
};
