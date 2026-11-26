# Native Pi codemode compatibility

Fabric supports two script API profiles in the TypeScript kernel. Both run in the configured QuickJS or trusted Node/Bun executor, through the same registry, approvals, Schema authorizers, host scopes, capability views, middleware, audits and cancellation. Neither nests Pi's `codemode` tool or enables another top-level execution path.

## Profiles

`executor.codemodeProfile` defaults to `"additive"`. Set it to `"native"` in `~/.pi/agent/fabric.json` or a trusted project's `.pi/fabric.json`, or use `/fabric settings` → **Executor** → **Codemode API (TS)**:

```json
{ "executor": { "codemodeProfile": "native" } }
```

| Surface | Additive (default) | Native (opt-in) |
| --- | --- | --- |
| `tools.<name>(args)` | Existing Fabric discovery members win; other registered names call native tools | Native tool calls, including tools named `search`, `list`, `call`, or `models` |
| `nativeTools.<name>(args)` | Unambiguous native tool view | Same native view as `tools` |
| `fabric.tools` | Existing Fabric discovery/generic API | Existing Fabric discovery/generic API |
| `pi.*`, `mcp.*`, `extensions.*` | Existing Fabric semantics | Existing Fabric semantics |
| `searchTools`, `describeTool`, `describeNamespace`, `ALL_TOOLS` | Existing Fabric-qualified compatibility discovery | Native callable identifiers and native discovery shapes |
| `nativeDiscovery` | Native discovery without changing existing globals | Same native discovery |
| Source | Checked/repaired TypeScript | Unmodified JavaScript async function body, without TypeScript checking or repair |
| `store` / `load` | Fabric's branch-local snapshot entries | Pi's branch-local `codemode-store` delta entries |

Top-level `await` and `return` work in both profiles. The native profile is for unchanged Pi script examples. It does not change the `fabric_exec` JSON input format, outer result rendering, resource limits or security policy. Python ignores this setting; its kernel and API remain unchanged.

### Tool names and results

```ts
// Works in both profiles:
const result = await tools.bash({ command: "git status --short" });
return result.output;
```

Native calls use Pi identifiers: `tools.read`, `tools.write`, `tools.mcp__server__tool`, and sanitized registered extension names. Real Pi registration names (including hashed MCP identifiers) are authoritative. `nativeDiscovery.ALL_TOOLS` enumerates the visible names. Sanitization collisions fail explicitly; they never select an arbitrary tool. Recursive `codemode` / `fabric_exec` calls are excluded.

Native results are projected from the final middleware-filtered tool result:

- A tool with an output schema returns its `structuredContent`, including schema-backed error results. Native `bash` returns `{output, truncated, full_output_path?, exit_code, wall_time_seconds}`; a nonzero process exit is a result, not an exception.
- MCP returns its `CallToolResult`, retaining `content`, `structuredContent`, `isError` and metadata. Check `isError`; `Promise.allSettled` alone does not detect these tool errors.
- Tools without structured output return text. Native image reads return Pi's image block; call `image(block)` to display it.
- Blocked, invalid or unstructured failed calls reject. Content-only middleware redaction never restores the original structured payload.

These are **not aliases of the normalized Fabric results**. `pi.bash` still rejects nonzero exits unless `settle:true`, `pi.edit/write` still return Fabric envelopes, `extensions.*` still returns its captured envelope, and `mcp.*` still normalizes results and throws on MCP errors. Native foreground shell calls do not auto-detach at `executor.shellHangMs`; explicit Fabric background operations retain their existing contract. A detached native shell call (`background: true`, `monitor` or `durable: true`) returns the object `{output, taskId}`, not text, so a program can pass `taskId` to `tasks.wait` or `tasks.get`. When an extension overrides a core tool such as `read`, `nativeTools.read` calls the one definition Pi runs; it is not reported as ambiguous. `pi.read` stays a string: the override's plain text when it supplies one, or its display rows with `anchors: true`.

### Discovery and collisions

```ts
// Safe under either profile, even with a native tool named "search":
const native = await nativeDiscovery.searchTools("issues", { limit: 5 });
const fabric = await globalThis.fabric.tools.search({ query: "issues" });
return { native, fabric };
```

Native `searchTools` returns `{name,description}[]`, with callable identifiers and advisory declarations. `describeTool(name)` returns a declaration/description **string** or `undefined`. `describeNamespace(name)` returns `{name,description?,instructions?,tools:string[]}` or `undefined`. `ALL_TOOLS` uses those same native identifiers. Search first prefers exact trimmed callable names, raw names, Fabric refs and final `__` name segments within the requested namespace, then uses BM25. Declarations are bounded by rendered size, with field descriptions retained while they fit. Description shortening/removal precedes structural truncation; enum/union/intersection/tuple, depth and size cuts carry visible markers. Member lists are cut only when the rendered-size budget is exhausted. `fabric.tools.describe({ref})` retrieves the unmodified raw `inputSchema`; `describeTool` remains a declaration string. Dispatch schemas remain authoritative. Actual namespace instructions are exposed only for visible tools.

The additive globals retain their existing shapes: Fabric-qualified refs, object-valued `describeTool`, and object-valued namespace tool entries. Use `nativeDiscovery` for native shapes in additive mode. In native mode use `fabric.tools.search/describe/list/call` for Fabric discovery. A single property cannot simultaneously be Fabric's `tools.search` and a registered tool named `search`.

Fabric's catalog page remains bounded to 1000 actions. Host-registered callable tools beyond that page are resolved individually, so native registrations remain discoverable. For larger Fabric-owned provider catalogs, use provider-specific discovery and exact Fabric refs.

## Models

`models === fabric.tools.models` in both profiles; in additive mode `models === tools.models` too. Calling `fabric.tools.models()` returns Fabric's legacy authenticated chat catalog. The model namespace exposes:

- `getModelsOfType(type, provider?)`
- `getAvailableOfType(type, provider?)`
- `getModelOfType(type, provider, id)`
- `classify({provider, id}, {state, questions, images?})`
- `generateImages({provider, id}, {input})`

Types are `chat`, `classifier`, and `image`; chat execution is not exposed. Classifiers accept native `choice`, `score`, and `bool` questions; bool answers contain `probability`. Full catalog entries work as selectors. Registry lookups resolve the authoritative model; guest configuration, headers and credentials are never used. Authentication and cancellation use public host registry APIs. At most four classifier/image calls run concurrently per invocation, including mixed calls; waiting calls cancel with the script.

Classifier `images` uses Pi's inline `{type:"image", data:"<base64>", mimeType:"image/png"}` blocks, passed unchanged to `modelRegistry.classify`. Fabric does not read paths, fetch image URLs, or supply provider adapters. For example, when the host (or pi-better-openai's compatibility provider) registers OpenAI Decisions, select `openai/gpt-6-luna` with `models.getAvailableOfType("classifier", "openai")`, then call `models.classify` with text state and optional images. OpenAI Decisions requires an API key, not ChatGPT/Codex OAuth; the provider enforces its own modality and request limits. No Jev or chat fallback is chosen.

These remain registered `native.*` actions. Scoped hosts require `native:models` read/execute or `native:store` read/write grants as appropriate; pinned views must include the required actions. Native `stopReason` and `errorMessage` are retained, and reported usage is included even on provider errors. Direct `jev.evaluate` accounting is unchanged. Classifier strings are capped at 262144 characters, question/criteria/input collections at 1000, and serialized model requests/responses at 16777216 characters. Provider limits may be lower. Missing registry APIs produce explicit compatibility errors.

## Branch-local script store

`store(key,value)` / `load(key)` are synchronous JSON helpers. `store(key,undefined)` deletes. Loads return detached values. One serialized value is limited to **262144 characters**, all values to **1048576**. This is not mesh state.

Additive mode reads/writes `fabric-codemode-store` snapshots. Native mode explicitly opts into Pi's `codemode-store` `{set,delete}` entries on the selected branch. The two stores are not silently merged. Switching profiles switches which store is visible. Native scripts and native Pi codemode can exchange state through these delta entries.

Initialization and staging pass through authorized `native.load` and `native.store`. Failed, aborted and timed-out scripts do not commit; additive type errors do not commit either. Malformed historical entries are ignored. Commit checks the captured session, leaf and runtime generation. Any intervening navigation or concurrent leaf change rejects the transaction; retry a stale writer explicitly. This conservative protection is stronger than bare Pi's store behavior. Standalone execution services must mount `nativeCodemode.setPersistence((type,data) => pi.appendEntry(type,data))` for state helpers.

## Output and options

- `text(value)` emits strings directly, other values as JSON.
- `image(value)` accepts PNG/JPEG/GIF/WebP blocks, local base64 data URLs and `{image_url:string|{url}}`. It never fetches remote URLs. Explicit images are emitted as multimodal content and saved to host-owned temporary files; output reports their paths. A remote execution environment does not necessarily share that filesystem.
- `exit()` succeeds with prior output and staged state. As a thrown control signal it can be intercepted by a guest catch block.
- `console.log/info/warn/error/debug` and `print` remain available.

Partial output and explicit images survive errors and deadlines. Pending host calls cancel when the script ends; detached tasks retain their ownership contract. Explicit output is capped at 100000 emissions and 16777216 characters, in addition to Fabric output limits.

`maxOutputTokens` / `max_output_tokens` estimate four characters per token and are capped by `executor.maxOutputChars`. `timeout_ms` is a hard positive-integer deadline capped by `executor.maxTimeoutMs`; it can lower the configured deadline and cannot be extended or paused. `timeoutMs` retains its raises-only behavior. The hard deadline wins when both are supplied. A leading `// @options: {"max_output_tokens":2000,"timeout_ms":60000}` works; unsupported, invalid or conflicting options fail explicitly.

## sPTC

Both profiles support speculative PTC on eligible isolated runtimes. Literal `tools.read(...)` and `nativeTools.read(...)` map to the same canonical `pi.read` authorization identity, but the native result projection is part of the speculative binding token. A native result can never answer a Fabric-view call or vice versa. Known Pi MCP aliases resolve through registration metadata, not guessed name splitting; unresolved aliases conservatively skip warming and execute normally.

Native reads retain all existing live approval/Schema gates, descriptor checks, mutation epochs, file freshness, cancellation, take-once consumption and side-channel replay. Alias use or mutation taints a native facade for the stream. Changing profiles through configuration resets stream/cache state. Node/Bun remain non-speculative, and Python speculation is unchanged. See [speculation](speculation.md).
