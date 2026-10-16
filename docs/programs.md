# Saved programs

A saved program is a `fabric_exec` program, or a Jev program, stored under a name and a content digest. A program saves a candidate with `programs.save`. Another program runs it with `programs.run`, nested in the caller's own execution. A person promotes or retires versions with `/fabric programs`, and a host runs one without the model through `/fabric run` or the `pi-fabric:program:run:v1` event.

Programs are a small primitive. They do not schedule themselves, they hold no authority of their own, and mesh events never run them implicitly.

## Store

Fabric keeps programs in the project state directory, `<project>/.pi/fabric/programs/` (`PI_FABRIC_PROJECT_ROOT` overrides the project root, so child agents share the parent's store).

- `<sha256>.json` holds one record.
- `index.json` maps each name to its digests and creation times.
- `.lock` serializes every write. A lock left by a crashed writer is reaped after 30 seconds.

```ts
{
  version: 1,
  digest,                          // sha256 over the content, see below
  name,                            // 1..64 characters of [a-z0-9._-], starting with [a-z0-9]
  kind: "fabric" | "jev",
  kernel?: "typescript" | "python", // fabric programs only
  code?,                           // fabric programs, up to 65,536 characters
  jevProgram?,                     // jev programs: { name, code, inputSchema, outputSchema, requires, limits? }
  description?,                    // up to 1,000 characters
  inputSchema?,                    // JSON Schema object, up to 16 KiB
  createdAt,                       // epoch ms
  status: "candidate" | "promoted" | "retired",
  trial?,                          // reserved for trial evidence
}
```

The digest is the SHA-256 of the canonical JSON (sorted keys) of `{ kind, kernel, code | jevProgram, inputSchema }`. The name, description, timestamps, and status stay outside the digest, so identical content always has one identity:

- Saving identical content under the same name returns the existing ref and keeps the first description.
- Saving identical content under a different name fails with the ref that already holds it.
- Before anything reads or runs a record, Fabric recomputes its digest. A record edited on disk fails closed with `does not match its content digest`.

The store holds at most 1,024 names and 256 versions per name.

## Refs

A ref names one version:

- `name` resolves to the newest promoted version, else the newest candidate. Retired versions never match a bare name.
- `name@<digest prefix>` takes at least 12 lowercase hex characters. An ambiguous prefix fails.
- A full 64-character digest names the record directly.

`programs.save` returns `name@<first 12 digest characters>`. Traces record the full `name@<digest>`.

## Actions

| Action | Risk | Result |
|---|---|---|
| `programs.save({ name, kind?, kernel?, code?, jevProgram?, description?, inputSchema? })` | write | `{ ref, digest }`, always a `candidate` |
| `programs.list({ name?, status? })` | read | summaries `{ ref, name, digest, kind, kernel?, description?, createdAt, status }` |
| `programs.get({ ref })` | read | the record plus its short `ref` |
| `programs.run({ ref, input?, requirePromoted? })` | execute | the program's return value |

`kind` defaults to `"fabric"` and `kernel` to the session kernel. A `jev` program takes `jevProgram` (the `program` object of [`jev.run`](jev.md)) and no `code` or `kernel`. `programs.list` and `programs.get` are speculation-eligible and stay available under Schema enforce. Enforce blocks `programs.save` and `programs.run`. Managed hosts do not offer the provider.

No action promotes or retires a program. Those transitions belong to the user.

## Nested runs

`programs.run` executes a `fabric` program inside the calling execution, through the same host bridge:

- **Capabilities.** The nested program sees the caller's committed capability view. It can call only what the caller can call, so a saved program never widens authority.
- **Approvals and budgets.** Each nested call passes the caller's approval controller and counts against the caller's agent budget. The caller's cancellation and deadline stop the nested program. `programs.run` extends the caller's deadline like other blocking orchestration calls.
- **Input.** `input` must be JSON-compatible and at most 64 KiB. When the record has an `inputSchema`, Fabric validates `input` (a missing input is checked as `null`) and refuses a mismatch before anything runs. The program reads it from the `input` global; treat `input` as a reserved name.
- **Kernel.** A `fabric` program runs in the current kernel. A program saved for the other kernel fails with a clear error.
- **Jev.** A `jev` program runs through `jev.run({ program: jevProgram, input })`, the existing Jev provider path, with that action's own approval and limits.
- **Status.** A retired version never runs. `requirePromoted: true` refuses anything except a promoted version.
- **Bounds.** One outer execution runs at most 16 nested programs, which also bounds recursion.

Nested logs join the caller's logs with a `[name@digest]` prefix. The trace records one `fabric.program.run` operation with `args: { program: "name@<digest>" }` before the program's own operations, in the caller's sequence space.

```ts
const saved = await programs.save({
  name: "changed-tests",
  description: "Run the tests for files changed since a base ref",
  inputSchema: { type: "object", required: ["base"], properties: { base: { type: "string" } } },
  code: `
    const diff = await pi.bash({ command: "git diff --name-only " + input.base, settle: true });
    return { files: diff.output.split("\\n").filter(Boolean) };
  `,
});
return await programs.run({ ref: saved.ref, input: { base: "main" } });
```

## Host runs

A host run executes a program without a model turn. It uses the session's root capability view and the same approval policy as a model call. Fabric runs a one-call program that invokes `programs.run`, so every check above applies, and the trace records `fabric.program.run` with `invokedBy: "host"`. The result appears in the transcript as a `pi-fabric-program-run` custom message whose details hold `{ version: 1, invokedBy: "host", program, success, error?, trace }`. The message never starts a turn.

Slash commands:

- `/fabric programs` lists every version with its status.
- `/fabric programs promote <ref>` promotes a version. A bare name selects the newest version, including a retired one.
- `/fabric programs retire <ref>` retires a version.
- `/fabric run <ref> [json input]` runs a program, for example `/fabric run changed-tests {"base": "main"}`.

Daemons and embedders in the same Pi process emit the program run event:

```ts
import { FABRIC_PROGRAM_RUN_EVENT, type FabricProgramRunReplyV1 } from "pi-fabric/protocol";

pi.events.emit(FABRIC_PROGRAM_RUN_EVENT, {
  ref: "changed-tests",
  input: { base: "main" },
  requirePromoted: true,          // optional: refuse candidates
  signal: controller.signal,      // optional: cancels the run
  reply: (result: FabricProgramRunReplyV1) => {
    // { ok: true, program, value, logs } | { ok: false, error, program? }
  },
});
```

The reply arrives exactly once. A payload without a `reply` function makes the listener throw synchronously; Pi's event bus catches and logs that throw, and other listeners still run. A `reply` property whose getter throws cannot be answered: Fabric neither replies nor throws. Other invalid fields, a missing session, an unknown ref, and a failed run all reply `{ ok: false, error }`. The event runs in the live session that Fabric saw at `session_start`.

Fabric reads `reply` and the named fields (`ref`, `input`, `requirePromoted`, `signal`) once, when the event arrives, and ignores every other field. Fabric keeps a JSON copy of `input`, not the caller's object, and makes it last, so a `toJSON` or getter inside `input` cannot change the other fields. A caller that deletes or changes the request or its `input` afterwards changes nothing, and the reply still arrives on the original `reply`. A named field whose getter throws never escapes the listener. Fabric replies once `{ ok: false, error: "Invalid program run request: <field> could not be read" }`, and nothing runs. The refusal comes at the place that field's check would have come: `ref`, then `requirePromoted`, then `signal`, then the session, then `input`. An earlier check that fails keeps its own error. A getter that throws is read once and is not read again.

## Mesh-triggered runs

Fabric never runs a program because a mesh event arrived. To run one on a schedule or on ingress, give the event `data.fabricProgram = { ref, input? }` and subscribe a durable actor to its topic. The actor's own program calls `programs.run` with that ref, so the run carries the actor's capabilities and approvals:

```ts
await mesh.publish({
  topic: "jobs.nightly",
  kind: "tick",
  afterMs: 3_600_000,
  key: "nightly",
  data: { fabricProgram: { ref: "changed-tests", input: { base: "main" } } },
});
```

The subscribed actor reads `data.fabricProgram` from its delivered event and calls `await programs.run({ ref: data.fabricProgram.ref, input: data.fabricProgram.input, requirePromoted: true })`. External grant events are untrusted input: the actor should accept only refs from its own allowlist and keep `requirePromoted: true`. See [scheduled events](agents.md#scheduled-events) and [external grants](agents.md#external-grants), and `/skill:fabric-graph` for resumable multi-step graphs built from the same pieces.

## Trust boundary

Promotion is a review marker written by the user's commands, and `requirePromoted` lets callers rely on it. The store sits in the project directory: a program that can write files there through `pi.write` or a shell can also edit `status`. Content edits still fail the digest check. Treat promotion as a policy convention for cooperating programs, and keep unconfined shell access away from programs you do not trust.
