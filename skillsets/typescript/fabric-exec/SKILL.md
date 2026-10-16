---
name: fabric-exec
description: >-
  Troubleshooting and advanced API reference for `fabric_exec` programs,
  the TypeScript kernel, dynamic providers, agents, and schema recovery. Routine `pi.*`
  coding calls are documented by ambient guidance; load this skill only after
  an argument-shape error or when an advanced surface needs exact contracts.
---

# fabric_exec — core reference

One program in the **TypeScript kernel**. Write TypeScript only in `code`. There is **no per-call kernel selector**, language autodetection, or fallback. Returned values and explicitly emitted `print()`/`console` output reach the model; intermediate values stay in the sandbox. `π` is payload data, not a tool.

QuickJS is isolated by default and receives static type checking; native Node/Bun is an explicit trusted-code escape hatch. Do not switch interpreters through shell commands to perform Fabric orchestration. Prefer one compact return value. Explicit log output is also included in the bounded tool result, so do not print raw intermediate payloads.

## `pi` core tools (full code mode only)
`pi.<tool>(arg)` — single arg: bare string (primary field) or options object, or a two-arg `(primary, options)` merge for the string-primary tools (`read`/`bash`/`powershell`/`ls`/`grep`/`find`): `pi.read('index.ts', { limit: 120 })` becomes `{ path: 'index.ts', limit: 120 }`, the positional string winning the primary field on conflict; a non-object second arg on those is still a type error. Positional tuple calls are accepted for `grep`/`find` (`pattern, path, limit`), `write` (`path, content`), and `edit` (`path, oldText, newText`).

| Tool | Form | Returns |
|------|------|---------|
| `read` | `path` \| `{path,offset?,limit?}` \| `(path, options?)` | `string` |
| `bash` | `command` \| `{command,timeout?,cwd?,settle?,background?,description?,monitor?}` \| `(command, options?)` | `{ok:true,output,details}`; rejects on a nonzero exit (`settle:true` returns `{ok:false,...}`; `background: true` detaches immediately with a still-running envelope) |
| `powershell` | Windows only; same forms and result contract as `bash` | `{ok:true,output,details}`; supports `settle:true` and `background: true` |
| `grep` | `pattern` \| `{pattern,path?,glob?,ignoreCase?,literal?,context?,limit?}` \| `(pattern, path?, limit?)` | `string` |
| `find` | `pattern` \| `{pattern,path?,limit?}` \| `(pattern, path?, limit?)` | `string` |
| `ls` | `path?` \| `{path?,limit?}` \| `(path, options?)` | `string` |
| `edit` | `{path,edits:[{oldText,newText,all?}],all?}` \| `{path,oldText,newText,all?}` \| `(path, oldText, newText)` | `{ok,output,details}` |
| `write` | `{path,content}` \| `(path, content)` | `{ok,output,details}` |

`pi.bash` and `pi.powershell` have no `stdin` option. When a command needs content input, write it to a file with `pi.write(path, content)`, then pass that path to the command or redirect the file into it; do not interpolate untrusted content into shell code.

For `pi.edit`, entry-level `all:true` applies that replacement to every non-overlapping occurrence; top-level `all:true` applies every entry that way. Omit it for unique anchors.

Shell tools reject on an ordinary nonzero exit; pass `settle:true` to get `{ok:false,output,details:null,exitCode,error}` instead of a rejection. `background: true` (alias `run_in_background`) returns immediately with `ok: true`, `details.taskId`, a pid, and a live output path while the process keeps running. Completion notifies the owning session; do not poll. Use `tools.call({ref:'tasks.list',args:{}})`, `tasks.get` or `tasks.stop` with `{id: taskId}` (tasks is not a sandbox global), or `pi.read` the bounded log. Nested shells that exceed `executor.shellHangMs` (default 2m) auto-spill the same way. Timeout, cancellation, approval, security, and spawn failures still reject. Other Pi core tool errors reject normally.

Opt-in `monitor:{delivery:'wake',match:'literal',timeoutMs:300000,intervalMs:5000}` on `pi.bash`/`pi.powershell` also detaches. Delivery must explicitly be `ui` (never wakes the agent) or `wake` (coalesced line events may start an owning-agent turn). Watches expire, never auto-renew, and stop on Main interruption. Use scripts that emit meaningful changes only; no inference is used to poll. The default lifetime is 5m (maximum 30m), event interval 5s (1–60s), with at most eight monitors. See [background tasks](../../../docs/background-tasks.md).

Aliases are normalized to canonical fields before host validation. Command aliases include `cmd`/`shell`/`cmdline`/`script`/`commandLine`; pattern aliases include `query`/`regex`/`search` plus `q`/`expression`/`text` for grep and `name`/`filename`/`glob`/`include` for find. Path aliases include `file`, `file_path`, camel-case path variants, `dir`/`folder`/`directory`, and target-file variants. Edit text accepts `old`/`from`/`old_string`-style and `new`/`to`/`replacement`/`new_string`-style spellings, including inside `edits`; write content accepts `contents`/`body`/`text`/`data`/`fileContent`. `ic`/`caseInsensitive`→`ignoreCase`, `globPattern`→`glob`, `ctx`→`context`, `max`→`limit`, and `start`→`offset`.

Shell `timeout` is in seconds; `timeoutMs` is converted from milliseconds. Numeric strings in `limit`, `timeout`, `offset`, and `context` coerce to numbers. `null`/`undefined` is omitted only for known optional fields; required fields remain invalid so authoritative host validation still reports them. Canonical fields win when both canonical and alias spellings are present. Unknown keys still fail the excess-property type check.

`bash`/`powershell`/`edit`/`write` always resolve an envelope `{ ok, output, details }`, never a bare string, and the executor guards those envelopes: a string method or iteration applied to the envelope itself (`r.trim()`, `for (const line of r)`) throws a TypeError naming the fix (`.output`) instead of a context-free "not a function".

A captured extension that registers an exact core name may provide a compatible additive override. Fabric derives a bounded object overload from the current override schema and adds it to the familiar `pi.<name>` surface wherever execution is effectively full-code, including Schema enforce mode; built-in positional calls, bare strings, shorthand, aliases, and normalized result contracts remain Fabric-owned. Override-specific prompt metadata is appended under that same `pi.<name>` identity. Schema enforce still applies its host restrictions to protected mutations and external effects. Unsupported or over-budget schemas use a loose object overload and still pass through authoritative registry validation, so use the effective schema and retry from the validation error when needed.

## Read economy

Search before reading. Run `pi.grep`/`pi.find` first, then `pi.read({ path, offset, limit })` the matching range instead of unbounded whole-file reads:

```ts
// Locate the symbol, then read only the window around the hit.
const hits = await pi.grep({ pattern: "targetSymbol", path: "src", context: 2 });
const window = await pi.read({ path: "src/engine.ts", offset: 120, limit: 80 });
```

An unbounded `pi.read('/x')` returns at most 2000 lines or 50KB (whichever is hit first); truncated output ends with a `[Showing lines a-b of N. Use offset=n to continue.]` notice — continue with `offset` only when you truly need the full file. Reserve whole-file reads for small files you will use in full (configs, tests or files you are about to edit, sources under a few hundred lines). Batching several large whole-file reads into one program inflates the single tool result, and that enlarged result stays in every later turn's context.

Keep multiline or syntax-heavy payloads out of `code`: pass them through `payloads` and read the exact matching key from `π`. For example, `payloads: { content: text }` is read as `π.content`; do not invent a different reference such as `π.task`. Every `π.key` must exist in the same call's top-level `payloads` map. TypeScript still parses template-literal contents, including shell heredocs. The legacy `strings` argument is accepted as an alias.

## First-class provider calls
Use direct proxies when the action is known. Parallelize only independent calls: provider effect footprints record conflicts for overlapping or unknown non-commutative resources, and Fabric does not silently reorder them. No-argument actions such as `schema.status()`, `state.get()`, and `compact.status()` take no options object. Provider calls still cross the same registry validation, approval, audit, timeout, and cancellation path as generic calls.

### Stable provider return shapes

All calls return promises. Fields ending in `?` are optional; `unknown` marks provider data whose nested schema is not stable at this surface.

| Call | Resolves to |
|------|-------------|
| `memory.recall(args?)` | `{total,hits:MemoryRecallHit[],next:{ref:"memory.recall",args}|null,coverage:MemoryCoverage,error?}` |
| `memory.expand(args)` | `{session?,sourceHash?,branches?,lineageFingerprint?,entryCount?,entries:ExpandedSessionEntry[],next?:{ref:"memory.expand",args}|null,error?}` |
| `memory.walk(args, visitor)` (TypeScript guest only) | `{visited,stopped,error?}`; guest-local paging and full-entry reassembly over `memory.expand` |
| `memory.sessions(args?)` | `{scope?,branches?,sessions?:SessionInfo[],error?}`; slice `result.sessions ?? []`, not the wrapper |
| `state.transition(args)` | `{event:FabricMeshEvent,head:unknown}` |
| `state.get()` | `{head,goal,complexity,certification,recentLabels:string[]}` |
| `state.history(args?)` | `{transitions:unknown[],labels:string[],certifications:unknown[]}` |
| `state.complexity(args?)` | `{files:ComplexityFile[],netDelta:number}` |
| `state.verify(args?)` | `{certified,violated,certificationStatus,results,failures,certificate?,reportingError?,evidenceDigest,resultDigest,binding?,observed?,requestedBy}`; `args.binding` (`{commit?,specDigest?,...}`) binds the certificate, and a commit that differs from git HEAD fails closed |
| `state.goal(args)` | mesh state entry `{key,value,version,updatedAt,updatedBy}` |
| `state.checkGoal(args?)` | `{passed:boolean,output:string,exitCode:number\|null,error?}` |
| `schema.status()` | `{mode,certificateTtlMs,maxFiles,maxBytes,trustedCommands,generation,lastOutcome,hypotheses}` |
| `schema.hypothesize(args)` | `{hypothesisId,status,state,fingerprint,generation}` |
| `schema.verify(args)` | `{verified,hypothesisId,certificate?,issuedAt?,expiresAt?,reason?,results}` |
| `schema.commit(args)` | `{outcome,transactionId,generation?,paths?,postconditions?,complexityReductionCertified?,stateTransition?,error?,rollbackError?}` |
| `schema.abort(args)` | `{aborted:true,hypothesisId}` |
| `components.list()` | `{definitions,components,configuration:{sources,warnings,sessionOverrides,removalPolicy,error?}}`; ignored trust layers and live-reconcile failures are explicit |
| `components.describe({component})` | Definition metadata, optional `configSchema`, and instances; works before activation |
| `components.plan({scope?,entries?,remove?,reset?})` | `{revision,request,changes,warnings,sources}`; validates without activation or writes |
| `components.apply({...plan.request,expectedRevision:plan.revision})` | Applies immediately; session scope by default, persistence only with explicit global/project scope; unrestricted host callers only |
| `components.reconcile()` | Re-reads trusted component config without host reload; session overrides remain |
| `components.status({id})` | `FabricComponentInfo` with state, requirements, provisions, targetDigest?, error?, cleanupErrors? |
| `components.graph()` | `{components:FabricComponentInfo[],edges:Array<{from,to,ref}>,cycles:string[][]}` |
| `components.reload({id?}?)` | `{components:FabricComponentInfo[]}`; rolls back activation failure when cleanup succeeds |
| `compact.request(args?)` | `{requested:true,intent:{reason?,instructions?,preserve?,requestedBy,requestedAt}}` |
| `compact.status()` | `{pending?:CompactIntent,last?:{at,requestedBy,status,summary?,tokensBefore?,estimatedTokensAfter?,error?},lastAuto?:{at,trigger,committed},owner,outputReserveTokens}` |
| `compact.pressure()` | `{tokens,contextWindow,fraction,headroomTokens,band:"ok"\|"warn"\|"urgent"\|"unknown",outputReserveTokens,thresholdFraction?,thresholdTokens?,owner}`; read-only |
| `compact.carry({items?,add?,remove?,clear?}?)` | `{items}`; no args reads; persistent focus rendered in every Fabric summary until cleared (≤16 items) |
| `compact.cancel()` | `{cancelled:true}` |
| `cache.status({target?}?)` | Local session cache observations, live leases, capability/cleanup diagnostics; observations do not prove residency |
| `cache.hold({target?,durationMs,maxRefreshes?,maxCostUsd?})` | `{status:"held",id,scope,sessionId,model,expiresAt}` or an unsupported/unavailable result with a reason; paid native opt-in, no fallback; cost/count bounds currently unsupported |
| `cache.release({id})` | `{released,cleanupError}`; session-owned holds only; expiry/cleanup is not a refund |
| `thinking.status()` | `{level,available,bounds:{min,max},baseline,override?:{level,scope,remainingTurns?,reason?,setAt}}` |
| `thinking.set({level,scope?,turns?,reason?})` | status plus `clamped:true,requested` when clamped; `scope` `"turn"` (default, reverts at agent_end) / `"turns"` (needs `turns` 1–20) / `"session"` |
| `thinking.reset()` | status after restoring the baseline level |
| `decisions.raise({title,kind?,body?,options?,input?,holder?,timeoutMs?\|deadline?,onExpire?,defaultOptionId?,escalation?})` | `{id}`; durable pending approval/question/escalation in the mesh; `holder` `"user"` (default, humans only) / `"root"` / `"supervisor:<id>"`; `onExpire:"escalate"` with `escalation:{chain?,hopTimeoutMs?,onFinal?}` moves it up the chain (default supervisor→root→user) per expired hop |
| `decisions.wait({id,timeoutMs?})` | the record once answered/expired/cancelled (still `open` on timeout): `{status,answer?:{optionId?,text?,answeredBy,via,at},...}`; the program deadline pauses while it waits, so pass `timeoutMs` (or raise with a deadline) to bound it |
| `decisions.list({status?,holder?,limit?}?)` | records newest first; read-only |
| `decisions.answer({id,optionId?,text?})` / `decisions.escalate({id,reason?})` / `decisions.cancel({id})` | the updated record; refused for `"user"` holders, other participants' holds, and decisions raised in the same call; `escalate` hands it to the next chain holder now |
| `programs.save({name,code?,kind?,kernel?,jevProgram?,description?,inputSchema?})` | `{ref:"name@digest12",digest}`; always a candidate; identical content returns the same ref |
| `programs.list({name?,status?}?)` / `programs.get({ref})` | summaries `{ref,name,digest,kind,kernel?,status,createdAt,...}` / the full record; read-only |
| `programs.run({ref,input?,requirePromoted?})` | the program's return value; runs nested with this program's capabilities and approvals; `input` is its `input` global |
| `jev.evaluate(args)` | `{model,answers,usage:{input_tokens,output_tokens}}`; typed Choice/Noul/Score answers, not generated text |
| `jev.run({program,input})` | terminal `FabricJevRun`: `{id,state,result?,error?,evaluations,toolCalls,usage,events,nextSequence,logs,...}` |
| `jev.spawn({program,input,observe?})` | `FabricJevRun` initially `running`; session-owned, not restart-durable |
| `jev.status(args?)` | without id: `{credentials:{configured,source,verified},model,runs}`; `{id,after?}`: run envelope with bounded events after sequence |
| `jev.wait({id})` | terminal run envelope; cancelling the wait does not stop the run |
| `jev.join({id})` | alias for `jev.wait`, with the same arguments, result, and cancellation behavior |
| `jev.advise({id,eventId,message})` | `{delivered,reason?}`; current observed event only; explicit delivery, agent approvals, freshness and feedback gates apply |
| `jev.stop({id})` | terminal run envelope after cancellation/cleanup; no rollback of already-issued effects |

`decisions.*` waits on a human or holder without blocking a UI; a person answers with `/fabric decisions` or `pi-fabric decisions answer`. Never try to answer your own approval. See [durable decisions](../../../docs/decisions.md).

`programs.*` stores reusable programs by content digest; a ref is `name` (latest promoted, else latest candidate), `name@<digest prefix ≥12>`, or a full digest. Only the user promotes or retires (`/fabric programs`). See [saved programs](../../../docs/programs.md).

`thinking.set` changes Main's reasoning effort for a bounded scope, clamped into `thinking.bounds` and the model's levels; it never fights a level the user changed meanwhile. See [thinking control](../../../docs/thinking.md).

`cache` targets the local Pi session (`self`); `main` is accepted only in root runtimes. Holds require a compatible native scoped-warming API, are bounded to 1–1800 seconds, and never change native settings. Current stock SDKs return unsupported. Never simulate warming with prompts. See [prompt-cache contracts](../../../docs/prompt-cache.md).

`memory.recall` multi-term literal queries default to ranked `queryMatch: "any"` so wording differences do not hide evidence; use `"all"` to require every canonical term in one indexed entry, and `queryMode: "phrase"` when adjacency matters. Results are hard-bounded either way. Structural filters (`ref`, `provider`, `action`, `outcome`) use exact persisted trace fields. Use `tools.catalog()`/`tools.search()` only to choose a current action head—catalog descriptions are navigation metadata and never become session evidence.

Recall returns one bounded flat hit stream. Every hit has the same copy-ready `{ref,args}` field: `await tools.call(hit.follow)` expands an entry or resolves a cold session. Continue any result with `await tools.call(result.next)` when `next !== null`; `total` is the retained pre-page hit count. Do not locate or parse Pi session JSONL yourself: follow calls, integrity bindings, and continuations are the supported retrieval API.

`memory.expand(args)` requires `session` plus a selector: `indices`, `entryIds`, `operationAddresses`, or `entryRange:{first,last}`. Optional `before`/`after` add adjacent entries. It returns normalized records in `entries`, with one uniform `tool` field and Pi `parentId` links. Long entries use lossless `textRange` chunks. For arbitrary filter/map/reduce/join/traversal work in TypeScript, use guest-local `memory.walk(args, async (entry, index) => { ... })`: it follows every expansion page, reassembles complete entries, awaits nested tool calls, and stops early when the visitor returns `false`. `memory.sessions` accepts an optional `limit`.

Stable-provider arguments normalize near-miss spellings the way `pi.*` does: known aliases and casing/singular variants repair to the canonical key, numeric strings coerce for numeric fields, and scope spellings such as `cwd` repair to `project`. Unknown keys are never silently ignored—they fail validation with the offending property path named (e.g. `/befroe: must NOT have additional properties`).

`SessionInfo` is `{id,file,cwd,mtime,entryCount,tier:"hot"|"cold",branches,lineageFingerprint}`. Memory failures are returned in `error: {code,message,...}`; ambiguous-session failures may return only `{error}`. Check `error` before relying on optional success fields.

### Dynamic provider return shapes

- `mcp.<sanitized_server>.<sanitized_tool>(args)` resolves to the server-defined result, commonly `{text:string,content:unknown[],structuredContent:unknown}`; for example `mcp.fal_ai.get_model_schema({ endpoint_id: "openai/gpt-image-2" })`. `<skill-dir>/references/mcp.md` is a branch pointer for MCP naming and management only when the task needs MCP.
- `extensions.<tool>(args)` in full code mode resolves to `{content:Array<{type,text?,...}>,text:string,details?,isError:boolean,terminate?,source:{path,source,scope,origin,baseDir?}}`.
- Captured Fovea tools therefore use refs such as `extensions.fovea_focus`. Discover dynamically with `await tools.search({ query: "fovea_focus" })` (the string shorthand `tools.search("fovea_focus")` is also accepted), then pass the returned `action.ref` to `tools.call({ ref, args })`; never invent a bare or `fovea.*` ref.

The guest TypeScript declarations contain the complete argument and return contracts. For a discovered or dynamic action, use `tools.describe({ref})`; inspect `outputSchema` when supplied, otherwise treat the result as `unknown`.

## `tools` — discovery & generic calls
Refs are namespaced (`pi.grep`, `extensions.<tool>`, `mcp.<server>.<tool>`, `schema.<action>`, `components.<action>`); bare names are rejected. `tools.providers()`→`[{name,description}]` · `tools.catalog({provider?,limit?})`→current provider/action head tree (navigation metadata, not session evidence) · `tools.search({query,limit?,searchMode?})`→`FabricAction[]` or, with `searchMode:"semantic"` (opt-in in /fabric settings → MCP), `{kind:"pi-fabric.action-search",actions,backend}` · `tools.describe({ref})`→full `FabricAction` (read `inputSchema` first) · `tools.call({ref,args?})` · `tools.list({provider?,namespace?,query?,limit?})` · `tools.models()`→Pi `[{provider,id,name,key}]`; `agents.models({runner:"claude"})`→Claude Code runtime models with canonical `claude/<value>` keys. Use `tools.call()` for refs discovered or computed at runtime, or names that cannot use property access—not as the default for known actions. In the default additive profile, nonconflicting `tools.<name>` members and `nativeTools.<name>` call native Pi tools. Native results differ from Fabric: schema-backed structured output (including structured errors), native bash `exit_code` without nonzero rejection, text for unstructured tools. `pi.*`, `mcp.*`, and `extensions.*` keep the contracts above. `fabric.tools` always provides Fabric discovery. With `executor.codemodeProfile: "native"`, `tools` is exclusively native, including colliding names; write JavaScript async function bodies without TypeScript-only syntax. Native globals return callable identifiers (`ALL_TOOLS`, `searchTools`), strings (`describeTool`), and namespace tool-name arrays. In additive mode those globals keep Fabric shapes; use `nativeDiscovery` for native discovery in either profile. Native mode opts into Pi's `codemode-store` entries; additive mode keeps Fabric's separate store. See [codemode compatibility](../../../docs/codemode-parity.md).

## Error recovery: read, describe, retry
Read the line-numbered error → `await tools.describe({ref})` for the schema → match `inputSchema`, rerun (don't guess). Common mistakes: bare ref (`grep`→`pi.grep`); a non-object second arg on `read`/`bash`/`powershell`/`ls` (`(primary, optionsObject)` already merges on the string-primary tools; positional tuples exist only for `grep`/`find`/`write`/`edit`).

## Jev judgments and persistent programs

`jev.evaluate` supplies typed semantic judgments. `jev.run`/`jev.spawn` execute one TypeScript artifact with schemas, limits, and exact `requires`; local state persists across loop iterations without a reasoning-model turn per tick. Credentials stay host-side: `/login jev`/`TYPESAFE_API_KEY` for direct aliases, the existing openrouter credential for `typesafe/…` ids, the existing `vercel-ai-gateway` credential for `typesafe-ai/…` ids, `/login subq`/`SUBQ_API_KEY` for `subq-…` ids, or a trusted credential command; `jev.status()` never retrieves a key. Jev is unavailable in Schema enforce and managed hosts.

For guided authoring, recommend `/skill:fabric-jev`. This advanced skill is user-invoked; never load it autonomously. Only after direct invocation, `<skill-dir>/../fabric-jev/SKILL.md` is its workflow pointer. `<skill-dir>/../../../docs/jev.md` is a branch pointer for exact API, budget, auth, and Browser Harness details when those surfaces are needed. Confidence is not permission to act; state is sent to TypeSafe and consumes credits.

## Orchestration surfaces (opt-in)

`wait` is canonical for agents and Jev. `agents.join({id})` aliases `agents.wait({id})`; `jev.join({id})` aliases `jev.wait({id})`. Both agent spellings use the same progress and detached-completion notification behavior.
Advanced workflow skills are user-invoked; never load them autonomously. When the user has explicitly invoked an agent or mesh workflow, `<skill-dir>/references/agents.md` and `<skill-dir>/references/mesh.md` are branch pointers for low-level API detail.

`agents.self()` and `agents.members({scope?,kinds?})` expose one leased directory of intrinsic roots, agents, and actors. `agents.main()` and `agents.peers()` are compatibility views of root participants. **Peer is a reserved Fabric term for another root Pi session, not a child agent.** When the user says “peer,” query `agents.peers()` first; do not infer peer state from `agents.list()` or from `agents.members({ kinds: ["agent"] })`. `agents.list()` defaults to local child agents; use `scope: "lineage" | "project"` for federated agent discovery. Cross-process `steer`, `followUp`, and `stop` resolve `ownerHostId` and return only after the owner acknowledges. `agents.subscribe()` creates a durable source-qualified Pi/run lifecycle route; use it instead of model-authored status polling when another participant boundary should notify Main or an agent. Detached `agents.spawn()` already sends Main a terminal follow-up by default unless the caller later waits. Set `residency: "durable"` on `agents.spawn()` or `agents.create()` only when the participant must outlive the current Pi host; Fabric lazily transfers it to the hidden resident host in a trusted mesh-enabled project.

For an explicit implementation handoff, `agents.handoff({ model, task?, when? })` schedules a visible Pi child at the completed outer `fabric_exec` boundary; later calls in the same program still run, and Main blocks only after the finalized native outer result is ready. `when` is a guest-only pure synchronous predicate over immutable earlier successful-call facts from any resolved Fabric provider and is stripped before the host call. `/fabric prewalk [task]` defaults to in-place Main model switching plus a hidden same-session continuation; child trajectory mode is an opt-in setting. See `<skill-dir>/references/agents.md`.

Persistent actors may declare `requires: ["provider.action", { ref: "provider.optional", optional: true }]`. Each run records and verifies a closed-world descriptor commitment; missing required refs fail the activation instead of widening authority.

Agent requests and persistent actors accept `runner: "pi-durable" | "pi" | "claude"`. `pi-durable` is the default isolated Pi host; explicit `pi` selects the legacy CLI. Both support `recursive: true`, `rlm.query()`, and actors that call Fabric or mesh APIs. Durable checkpoints do not restore arbitrary in-flight `fabric_exec` continuations. Claude invokes the official `claude -p` harness; it supports mapped Claude Code tools and host-managed persistent actors, but not recursive/direct Fabric APIs. Use `agents.models({ runner: "claude" })` for runtime-enumerated `claude/<value>` model keys.

For Pi model selection, copy `key` from `agents.models({ runner: "pi" })`, reuse a successful handle's `model`, or use a configured alias. Never infer a model's version from an agent name or another model's version. Exact provider/model matches win; near-miss IDs resolve to the closest available model on that same provider. Check the returned handle's canonical `model`. Unknown providers and unrelated names still fail. For independent launches, await `Promise.allSettled` and inspect every result: an uncaught `Promise.all` rejection ends the program and can abort still-pending siblings. Preserve successful handles when retrying failures.

Omit `timeoutMs` for agents and actors unless requesting longer than the configured `agents.timeoutMs` (24 hours by default, the policy ceiling). Per-call values below the configured default are ignored.
