# Execution kernels

`fabric_exec` runs one program in the **configured kernel**. `executor.kernel` is `"typescript"` by default; select `"python"` for sandboxed Python through **Monty**. CPython requires explicit native escape-hatch selection. The choice is exclusive: there is **no per-call kernel selector**, language autodetection, or fallback to the other language. Change configuration to switch languages, not the tool arguments.

## Select Python

Monty is the default Python backend; a system Python installation is not required. Add this to `~/.pi/agent/fabric.json` for global defaults, or `<project>/.pi/fabric.json` for a trusted project's override:

```json
{
  "executor": {
    "kernel": "python"
  }
}
```

Project settings override global settings; untrusted project config is not loaded. `executor.pythonRuntime` defaults to `"monty"`; no extra enabled flag is needed. Fabric installs the optional, pinned `@pydantic/monty` native package on supported platforms and loads it lazily only for Monty execution. Missing/incompatible native dependencies fail with an installation hint, **never** a CPython fallback. Monty runs a Python subset, not a CPython installation; see [subset limitations](#monty-subset-limitations).

Alternatively, open `/fabric settings` → **Executor**, select **Kernel** → `python`, and keep **Runtime (Python)** → `monty`. **Runtime (TS)** controls only the TypeScript backend (`quickjs`, `node-process`, or `bun-process`); Python ignores that setting. Set **Kernel** back to `typescript` to restore TypeScript programs.

Process runtimes can import native modules from guest code: Node guests use `await import("pkg")` (resolved from the session cwd; `--experimental-vm-modules` is set at spawn), while Bun's vm lacks the dynamic-import callback, so Bun guests call `await __fabricImport("pkg")`, which bridges the child's real ESM context (bun auto-install applies).

### The Bun namespace in Bun guests

When **Runtime (TS)** is `bun-process`, guest programs receive the child's real Bun module namespace as the `__bun` global, with no import needed:

```ts
const config = await __bun.file("/tmp/config.json").json();
const files = [...new __bun.Glob("**/*.ts").scanSync({ cwd: "src" })];
```

`__bun` is `undefined` under `node-process` and `quickjs`; the child resolves the Bun specifier only when it runs under Bun. Namespace objects come from the child's module realm, so prefer structural checks over `instanceof` across the sandbox boundary.

See [configuration](configuration.md) for save scopes, timeout ceilings, result formatting, and the full reference.

### Explicit CPython escape hatch

For full native Python and installed packages, install **CPython 3.10+** and opt in:

```json
{
  "executor": {
    "kernel": "python",
    "pythonRuntime": "cpython",
    "cpython": { "binary": "python3" }
  }
}
```

`executor.cpython.binary` is an executable name on `PATH` or a path, not shell arguments. An absolute path selects a particular interpreter. Setting only the binary does not select Python or disable Monty. CPython is trusted native code outside schema enforce, just as Node/Bun are TypeScript escape hatches. Host approvals do not cover direct native OS operations. Under enforce, CPython requires the additional OS isolation described below.

## Kernel-specific skills and guidance

Every bundled skill keeps the same public name in both kernels: `/skill:fabric-exec`, `/skill:fabric-workflow`, `/skill:fabric-council`, and the other advanced workflows. Fabric ships two complete physical trees under `skillsets/typescript/` and `skillsets/python/`. Each includes its own `fabric-exec/references/agents.md`, `mcp.md`, `mesh.md`, and ambient actor setup. Python programs use host actions, ordinary loops and `asyncio.gather`, not guest TypeScript callback helpers.

The package manifest explicitly exposes no static skills (`pi.skills: []`). At `resources_discover`, after configuration bootstrap, Fabric contributes only the configured kernel's tree. Pi's native catalog, slash-command expansion, skill `filePath`/`baseDir`, and Fabric's `<skill-dir>` pointers all refer to that physical tree. Do not add the parent `skillsets/` directory to Pi settings: loading both variants causes same-name collisions. Direct extension-loaded children use the same discovery path and inherit the parent's resolved kernel.

Pi discovery is additive; it cannot replace one contributed tree with another in place. Kernel settings are saved immediately but the running execution kernel remains pinned to its loaded skill tree until a Pi resource reload. Closing `/fabric settings` after changing the effective kernel triggers that reload. `/fabric reload` also escalates to a full Pi reload if disk configuration requests a different kernel. After editing configuration manually, use `/reload` to apply it directly. A reload tears down and rebuilds extensions as well as resources; return from the old command context immediately. Python backend changes within the same kernel do not require a different skill tree.

This replaces the earlier `fabric-exec-python` name and `metadata.fabric-kernel` context filter. Use `/skill:fabric-exec` in both languages. Third-party skills retain Pi's normal discovery and invocation behavior; Fabric no longer strips their expanded instructions. Authors can use their own extension discovery to contribute a single language-specific directory, with canonical names and relative references. Remove legacy explicit skill paths from Pi settings when upgrading.

This is resource selection, not a filesystem authorization boundary. Both trees remain installed and ordinary tools can read either. Reload does not erase old skill expansions, tool results, or summaries from session history. Start a fresh session if you need a clean language context; do not mutate a shared symlink to switch languages because concurrent sessions may use different kernels.

The selected kernel remains authoritative when older context shows another language. Do not use shell interpreters or native subprocesses merely to move Fabric orchestration into the other language. Legitimate project builds, tests, and explicitly requested interpreter work remain allowed.

## Agent kernel inheritance

An agent request may select a **child's** language with `kernel: "typescript" | "python" | "inherit"` on `agents.run`, `agents.spawn`, `agents.create`, or `agents.handoff`. Omitted/`inherit` uses the caller's configured kernel. This is not a per-call selector on `fabric_exec`: its current program must still use the current kernel's syntax. Skills can choose the language that best fits their model and task; workflow, council, and RLM requests forward the option. See [agents](agents.md#choose-the-childs-language) for cross-language examples.

Concrete agent kernels require Pi with Fabric extensions enabled. Claude, Veda, and `extensions: false` reject them before launch; omitted/`inherit` remains valid but does not assign those runners a Fabric kernel. Actors keep the resolved language and Python backend for their persistent session; `ask`/`tell` cannot switch them. Inactive global templates resolve inheritance when imported, not when saved.

Workers receive a resolved `--kernel` and configured `--python-runtime`, then pass `PI_FABRIC_KERNEL` and `PI_FABRIC_PYTHON_RUNTIME` to their child process. `loadFabricConfig` applies these validated inherited overrides **after** global/trusted-project disk merge. Recursive and alternate-cwd children therefore keep the caller's language and backend policy; durable and trajectory handoffs snapshot policy before transfer. Disk settings and scope-specific settings views are not rewritten. The Python backend is configuration policy, not a public per-agent argument.

Only exact `typescript`/`python` environment kernel values and `cpython`/`monty` backend values are valid. Any present invalid override, including empty strings, casing variants, and `inherit`, makes configuration loading fail; there is no automatic native-execution fallback. Unset overrides use normal disk/default resolution. For backward compatibility, old standalone worker argv without these flags defaults to TypeScript/Monty and ignores ambient selectors. Non-Fabric workers clear both selectors from their child environment. Malformed disk `pythonRuntime` values normalize to the sandboxed `monty` default; inherited environment overrides are deliberately stricter.

## Write a Python program

The `code` argument is a **Python async function body**. Write ordinary Python statements, with top-level `await` and `return`; do not add a surrounding `async def` or invoke an event loop yourself. Every invocation starts fresh, so guest variables do not persist. Return a JSON-compatible value to the model; `print()` is for activity logs.

Python example (the contents of `fabric_exec.code`):

```python
import asyncio

manifest, sources = await asyncio.gather(
    pi.read("package.json"),
    pi.find({"pattern": "**/*.py", "path": "src"}),
)
return {
    "manifest": manifest,
    "sourceCount": len(sources.splitlines()),
    "checked": True,
    "error": None,
}
```

Use `asyncio.gather` only for independent calls; use sequential `await` when later work depends on an earlier result. Search before reading and return compact evidence; omit unused intermediate tool output.

### Core tools and native results

Host calls are async. `pi.read` accepts a path, a dictionary, or keyword arguments:

```python
text = await pi.read("README.md")
window = await pi.read({"path": "src/config.ts", "offset": 1, "limit": 40})
other_window = await pi.read(path="src/config.ts", offset=41, limit=40)
return {"readmeLines": len(text.splitlines()), "window": window, "next": other_window}
```

`pi.read`, `pi.grep`, `pi.find`, and `pi.ls` return strings. `pi.read` returns plain file text even when an extension such as pi-hashline-edit-pro overrides `read` with anchored rows; pass `anchors: true` (`anchors=True` in Python) to get the override's `anchor│content` rows for its edit tools. `pi.bash`, `pi.powershell` (Windows only), `pi.edit`, and `pi.write` return **native Python dictionaries**, not objects with attribute access:

```python
r = await pi.bash({"command": "git status --short", "settle": True})
return {"ok": r["ok"], "output": r["output"]}
```

Use `r['output']`, not `r.output`. Prefer canonical schema field names. Python and TypeScript share core object repairs: `cmd` → `command`, `file_path` → `path`, edit `old_string`/`new_string` → `oldText`/`newText`, write `text` → `content`, numeric-string coercion, shell `timeoutMs` conversion, and removal of null optional fields. Canonical values win conflicts; declared override properties stay canonical even when named like an alias. These repairs apply to direct calls and `tools.call`. Unknown fields still reject, including nested edits; `all` and `settle` must be booleans. Source-text repair remains language-specific: Python is never passed through the TypeScript rewriter. Shell calls raise on ordinary nonzero exits unless `settle=True`; timeout, cancellation, approval, and security failures still raise. Python uses `True`, `False`, and `None`, not JavaScript's `true`, `false`, and `null`. Do not paste TypeScript object literals, `const`, or `Promise.all` into a Python program.

### Named payloads

Keep multiline content outside `code` in the tool's top-level `payloads` map. For a call with `payloads: {"content": "..."}`, access that exact key through `π.content` or `payloads['content']`:

```python
text = π.content
r = await pi.write({"path": "notes.txt", "content": payloads["content"]})
return {"output": r["output"], "chars": len(text)}
```

`π` and `payloads` are data, not tools. Only use keys supplied in the same call. Mutating core tools remain subject to approvals and schema enforcement; this write example is not a bypass for schema transactions.

### Shared host bridge, not TypeScript syntax

Python uses the same host action namespaces: `tools`, `mcp`, `memory`, `state`, `schema`, `compact`, `agents`, and `mesh`. A provider another extension registers is a global named after it, for example `await context.task_add(title="x")`; see [program globals](providers.md#program-globals-and-types). Full code mode also exposes `pi` and `extensions`; schema enforce uses the full-code bridge. Known actions use direct async calls, while computed refs use `tools.call`:

```python
hits = await tools.search({"query": "deployment status", "limit": 3})
if not hits:
    return None
return await tools.describe({"ref": hits[0]["ref"]})
```

For example, `await schema.status()` takes no arguments; `await tools.call({"ref": ref, "args": args})` invokes a computed ref. MCP names remain sanitized as `mcp.<server>.<tool>`. Arguments and results cross the bridge as JSON-compatible data and become Python dictionaries, lists, and scalar values.

Host actions retain the same registry/schema validation, approvals, audit, timeout, and cancellation paths. Python programs do **not** receive the static TypeScript check; Python syntax/runtime errors and authoritative host validation report failures instead. Use `await tools.describe({"ref": ref})` to inspect an action's actual schema before calling it.

Guest-local callback APIs are not automatically available just because host providers share namespaces. In particular, do not assume TypeScript's `memory.walk(args, visitor)`, callback-based workflow helpers, or `agents.handoff({when: ...})` predicates work in Python. Use host actions such as `memory.expand` with explicit Python loops and `asyncio.gather` instead; follow returned paging refs through `tools.call`. Existing TypeScript workflow/skill examples are TypeScript-only unless explicitly documented for Python.

## Repair, diagnostics, and compiler boundaries

Python syntax/runtime errors report user source lines and bounded recovery hints without bridge/bootstrap frames. Common dictionary-access mistakes, JavaScript globals, invalid schemas, and unsupported imports include Python-specific next steps. Hints do not retry effects, rewrite source, or enable native execution. Monty preflights direct identifiers and unescaped literal payload keys, including f-string replacement fields; lexical nesting beyond 64 levels fails closed. Dynamic or escaped-key lookups remain runtime checks and can fail after earlier effects. Only a reported pre-execution rejection guarantees no prior host calls.

The [repair and entropy compilers](entropy.md#kernel-boundary) operate on canonical host-call schemas, audits, and valid trace records, not Python source or traceback prose. Their catalog binding, validation, approvals, and quarantine rules remain active for both Python backends. Compiled overlays can restrict enums; they cannot remove required fields or weaken declared types.

[sPTC](speculation.md) supports TypeScript/QuickJS, Python/Monty, and Python/CPython under schema enforce (OS sandbox required). Native CPython and native TypeScript skip speculative dispatch because ambient mutations bypass registry epochs; normal host calls still work. Python uses a separate incremental Python grammar scanner with literal/keyword/positional argument normalization and conservative namespace shadowing checks. Kernel/backend/policy changes clear and replace speculative state.

## Monty subset limitations

[Monty](https://github.com/pydantic/monty) is a sandboxed Python interpreter, **not CPython**, and is not a drop-in implementation of its standard library or installed packages. Only supported Python syntax/modules are available. `asyncio.gather` is tested; do not assume arbitrary `asyncio`, filesystem, networking, environment, subprocess, import, or third-party APIs exist. Use host actions for effects.

- Supply **acyclic JSON-compatible arguments**. The upstream native API may replace recursive host-argument containers with repr strings before Fabric sees them; cyclic arguments are unsupported. Final return values are additionally checked in the guest, so cyclic results fail without silently changing shape.
- Use string dictionary keys, finite numbers, and safe integers. Convert bytes/sets/custom objects explicitly; results and bridge data are bounded.
- Monty currently blocks direct capability attributes starting with `_`. For names such as `mcp._123._tool`, use `await tools.call(ref="mcp._123._tool", args={...})` with the exact discovered ref instead.
- `π` is an explicit-attribute payload object; `payloads` is a native dictionary with the same supplied keys, not the same object identity. Prefer `payloads["key"]` for keys that are not public Python identifiers.
- Every call uses a fresh native Monty worker with VM resource limits and a host watchdog. No CPython worker, system Python, or WASM fallback is used.

## Isolation and resource limits

| Kernel / backend | Security boundary |
| --- | --- |
| TypeScript / QuickJS (default) | Isolated WASM guest with host-mediated capabilities. |
| TypeScript / Node or Bun process | Trusted native code; no security sandbox. |
| Python / Monty (default), all schema modes | Sandboxed Python subset, VM allocation limits, host-mediated capabilities only. |
| Python / CPython, schema off or audit | Trusted native code with the local user's full OS privileges; no security sandbox. |
| Python / CPython, schema enforce | Required OS isolation: macOS `sandbox-exec` or Linux `bwrap` (bubblewrap), plus the same host schema gate. |

Selecting Python uses the Monty sandbox by default. Selecting **CPython** is an explicit opt-in to native execution. Outside schema enforce, generated CPython code can use native OS access; host approvals and audit cover bridge calls, not arbitrary Python file/network/subprocess operations. Only run code and projects you trust with your user account's authority.

**Schema enforce preserves the configured kernel.** TypeScript uses QuickJS even if a native TS backend was configured. Python stays Python: Monty remains sandboxed; explicit CPython additionally requires OS isolation. If the required isolation mechanism is unavailable or cannot launch, execution **fails closed**; it does not run unrestricted or silently fall back to TypeScript. Protected-workspace changes still use `schema.hypothesize` → `schema.verify` → `schema.commit` through the host bridge. Schema mode changes take effect in the next session.

On Linux, bubblewrap also requires usable unprivileged user namespaces. The bundled seccomp network filter supports x86-64 and ARM64; unsupported architectures fail closed without omitting that protection.

`executor.memoryLimitBytes` enforces Monty VM allocation limits; host-result and output bounds apply separately. A hard process watchdog interrupts CPU loops and pending host calls on timeout/cancellation, while host-call floors can raise the configured deadline.

For explicit CPython, `executor.memoryLimitBytes` bounds the process address space through `RLIMIT_AS` where the OS supports it. The current runtime applies it on Linux; macOS does not provide a dependable CPython address-space limit, so it is not enforced there. This is not a portable hard resident-memory cap: OS support varies, interpreter/library mappings count toward address space, and native allocations can fail before your data reaches the configured size. The configuration ceiling is detected physical memory, not QuickJS's WASM32 ceiling. Choose a limit large enough for the interpreter and workload without exhausting the machine.

Timeout, cancellation, process termination, and resource limits constrain execution; **process limits are not a security sandbox**. They do not replace enforce-mode OS isolation. See [configuration](configuration.md#executor-timeouts-and-ceilings) for shared deadline policy.
