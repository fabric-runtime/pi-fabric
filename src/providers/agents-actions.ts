import { FABRIC_ACTOR_HOST_EVENTS } from "../actors/types.js";
import {
  MAX_COMPACTION_INSTRUCTIONS_CHARS,
  MAX_PRESERVE_ITEM_CHARS,
  MAX_PRESERVE_ITEMS,
} from "../compaction/instructions.js";
import { FABRIC_LIFECYCLE_EVENTS } from "../lifecycle/types.js";
import type { FabricActionDescriptor } from "../protocol.js";

// RUNNER_ID_PATTERN (src/agents/runner-registry.ts) as source text; kept in sync by a test.
const RUNNER_ID_SOURCE = "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$";

const runProperties = {
  task: { type: "string", description: "A self-contained task for the child agent" },
  name: { type: "string" },
  runner: {
    type: "string",
    pattern: RUNNER_ID_SOURCE,
    maxLength: 64,
    description: "Execution harness: pi-durable (default), pi, claude, veda, or a runner registered through pi-fabric/runners. Defaults to agents.runner.",
  },
  kernel: {
    type: "string",
    enum: ["typescript", "python", "inherit"],
    description: "Fabric execution language. Omitted/inherit uses the caller executor.kernel; concrete choices require Pi with extensions enabled. Python uses the configured backend; CPython is native execution.",
  },
  transport: {
    type: "string",
    enum: ["auto", "process", "tmux", "screen", "localterm", "herdr"],
  },
  model: {
    type: "string",
    description:
      "Pi provider/id copied from agents.models({ runner: \"pi\" }), a configured models.aliases name, or a search term resolved to the closest authenticated model (recency from pi-model-sort breaks ties). Reuse returned keys; never infer version numbers from agent names. Exact keys win; near-miss IDs resolve to the closest visible model on the same provider. Handles report the canonical model. Claude runtime value or Veda backend model/alias are forwarded verbatim.",
  },
  persona: {
    type: "string",
    description: "Veda persona name for this run, such as frontend, reviewer, worker, or a custom persona.",
  },
  thinking: {
    type: "string",
    enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  },
  thinkingBounds: {
    type: "object",
    properties: {
      min: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
      max: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
    },
    additionalProperties: false,
    description: "Optional child thinking bounds; must lie inside this session's bounds (omitted ends inherit). Child Fabric sessions never widen them. thinking outside the effective bounds is clamped and reported as requestedThinking.",
  },
  tools: { type: "array", items: { type: "string" } },
  timeoutMs: {
    type: "number",
    description:
      "Optional longer wall-clock limit in milliseconds. Omit to use agents.timeoutMs (60 minutes by default); values below the configured default are ignored.",
  },
  extensions: { type: "boolean" },
  recursive: { type: "boolean" },
  cwd: {
    type: "string",
    description: "Filesystem execution directory for leaf or recursive Pi runs; relative paths resolve from the caller cwd. Does not change project/mesh ownership or grant target project trust.",
  },
  worktree: { type: "boolean" },
  worktreeSetup: {
    type: "string",
    maxLength: 8192,
    description: "Shell command run in a new worktree before the child starts; overrides agents.worktree.setup. Non-zero exit fails the run.",
  },
  seed: {
    type: "string",
    enum: ["task", "branch", "snippet"],
    description: "Child context (Pi only). task (default): the task alone. branch: a non-blocking fork of this conversation up to its last completed turn, then the task. snippet: the last seedMessages user/assistant texts prefixed to the task.",
  },
  seedMessages: { type: "integer", minimum: 1, maximum: 50, description: "snippet only; default 12" },
  readOnly: { type: "boolean", description: "Pi only: refuse write/edit (and shell unless shell: \"unconfined\") in the child" },
  writableRoots: {
    type: "array",
    items: { type: "string", maxLength: 4096 },
    maxItems: 32,
    description: "Pi only: confine write/edit to these directories (relative to the child cwd; default the cwd). Shell is refused unless shell: \"unconfined\".",
  },
  scope: {
    type: "object",
    properties: {
      grants: {
        type: "array",
        maxItems: 64,
        items: {
          type: "object",
          properties: {
            resource: { type: "string", minLength: 3, maxLength: 512 },
            actions: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", enum: ["read", "write", "execute"] } },
          },
          required: ["resource", "actions"],
          additionalProperties: false,
        },
      },
    },
    required: ["grants"],
    additionalProperties: false,
    description: "Narrow this session's host-issued scope for the child (each grant must be covered by a parent grant; resource <ns>:<path>, <ns>:<path>/*, <ns>:<path>/**, <ns>:*). Omit to inherit it; refused in an unscoped session.",
  },
  shell: {
    type: "string",
    enum: ["deny", "unconfined"],
    description: "With a write policy, bash is refused by default; unconfined allows it and is not a sandbox",
  },
  schema: { type: "object", description: "Optional JSON Schema for validated structured output" },
  systemPrompt: {
    type: "string",
    description: "Optional extra system prompt body for this child run. Fabric places it ahead of any component guidance. Pi and Claude runners append the result with --append-system-prompt, and Veda receives it as a <system_instructions> block in its prompt. Useful for reliability-focused prompt rules on models with weak behavioral defaults.",
  },
  persistSession: {
    type: "boolean",
    description: "Claude runner only: persist the Claude Code transcript for hook-based observability. Defaults to false.",
  },
};

const runSchema = {
  type: "object",
  properties: runProperties,
  required: ["task"],
  additionalProperties: false,
};

const residencySchema = {
  type: "string",
  enum: ["session", "durable"],
  description: "session stops with the current Pi host; durable transfers execution to Fabric's hidden resident host.",
};

const actorBindingScopeSchema = {
  type: "string",
  enum: ["session", "project"],
  description: "session (default) changes only this Pi session; project pins the shared actor default and requires ownership.",
};

const actorInvocationProperties = {
  id: { type: "string" },
  message: { type: "string" },
  data: {},
  model: {
    ...runProperties.model,
    description: "Optional model pinned only for this actor activation.",
  },
  thinking: runProperties.thinking,
};

const spawnSchema = {
  ...runSchema,
  properties: { ...runProperties, residency: residencySchema },
};

const handoffCompactionSchema = {
  anyOf: [
    { type: "boolean" },
    {
      type: "object",
      properties: {
        instructions: {
          type: "string",
          maxLength: MAX_COMPACTION_INSTRUCTIONS_CHARS,
          description: "Custom compaction instructions for the inherited trajectory",
        },
        preserve: {
          type: "array",
          items: { type: "string", maxLength: MAX_PRESERVE_ITEM_CHARS },
          maxItems: MAX_PRESERVE_ITEMS,
          description: "Explicit bounded facts the trajectory summary must preserve",
        },
      },
      additionalProperties: false,
    },
  ],
  description:
    "Compact the inherited trajectory with Fabric's deterministic compactor before the executor resumes it. `true` applies the default summary; an object customizes instructions and bounded preserve facts. Omitted keeps the full raw trajectory.",
};

const handoffSchema = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description: "Optional instructions for the executor in addition to the inherited trajectory",
    },
    name: runProperties.name,
    kernel: runProperties.kernel,
    transport: runProperties.transport,
    model: {
      ...runProperties.model,
      description: "Explicit Pi provider/id target that will continue the inherited trajectory",
    },
    thinking: runProperties.thinking,
    tools: runProperties.tools,
    timeoutMs: runProperties.timeoutMs,
    extensions: runProperties.extensions,
    recursive: runProperties.recursive,
    schema: runProperties.schema,
    compact: handoffCompactionSchema,
  },
  required: ["model"],
  additionalProperties: false,
};

const idSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
};

const lifecycleEventSchema = {
  type: "string",
  enum: [...FABRIC_LIFECYCLE_EVENTS],
};

export const AGENTS_ACTION_DESCRIPTORS: FabricActionDescriptor[] = [
  {
    name: "run",
    description: "Run a child agent through Pi or Claude Code and wait for its final result",
    inputSchema: runSchema,
    risk: "agent",
  },
  {
    name: "handoff",
    description:
      "Schedule a Pi trajectory handoff after the current outer fabric_exec result, then wait for implementation at that boundary",
    inputSchema: handoffSchema,
    risk: "agent",
  },
  {
    name: "spawn",
    description:
      "Start a child agent through Pi or Claude Code and return a handle immediately. For independent launches, await Promise.allSettled and inspect every result so one rejection does not abort pending sibling calls at program exit. Unread detached results are batched at the next safe turn boundary (or wake idle Main) when agents.notifyOnComplete is enabled. wait/join and terminal status acknowledge results and retract pending notifications. Use wait when this program needs the result; do not poll status in a loop.",
    inputSchema: spawnSchema,
    risk: "agent",
  },
  {
    name: "wait",
    description: "Wait for a previously spawned child agent and acknowledge its result, suppressing a duplicate completion notification",
    effect: { kind: "emission", ordering: "commutative", resources: ["agents.completions"] },
    inputSchema: idSchema,
    risk: "read",
  },
  {
    name: "join",
    description: "Alias for agents.wait: wait for a previously spawned child agent with the same progress and completion-notification behavior",
    effect: { kind: "emission", ordering: "commutative", resources: ["agents.completions"] },
    inputSchema: idSchema,
    risk: "read",
  },
  {
    name: "status",
    description: "Get the latest status of any known project participant. A terminal child-agent result acknowledges its pending completion notification; running status does not.",
    effect: { kind: "emission", ordering: "commutative", resources: ["agents.completions"] },
    inputSchema: idSchema,
    risk: "read",
  },
  {
    name: "list",
    description: "List agent participants locally, across the current lineage, or across the project",
    inputSchema: {
      type: "object",
      properties: { scope: { type: "string", enum: ["local", "lineage", "project"] } },
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "members",
    description: "List the unified project topology of roots, agents, and actors",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["local", "lineage", "project"] },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["root", "agent", "actor"] },
        },
        includeStale: { type: "boolean" },
      },
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "self",
    description: "Return this caller's intrinsic participant identity in the unified topology",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  {
    name: "main",
    description:
      "Return the root user-facing Main Pi agent target. The stable alias main is also accepted by agents.steer and agents.followUp.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  {
    name: "sessions",
    description: "List all live root Pi session agents in the project, including the current lineage root and peers, with symmetric participant identities.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  {
    name: "peers",
    description: "List other live root Pi sessions sharing this project mesh. The dashboard-owning session remains Main; these targets are named peers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  {
    name: "subscribe",
    description:
      "Create a durable source-qualified participant lifecycle subscription. Events are delivered to Main by default or to another participant through steer/follow-up routing.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Exact source participant id; main means this lineage root" },
        events: { type: "array", minItems: 1, items: lifecycleEventSchema },
        to: { type: "string", description: "Target participant id; defaults to main" },
        delivery: { type: "string", enum: ["steer", "followUp"] },
        triggerTurn: { type: "boolean" },
        once: { type: "boolean" },
      },
      required: ["from", "events", "delivery", "triggerTurn"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "subscriptions",
    description: "List durable participant lifecycle subscriptions, optionally filtered by source or target",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "unsubscribe",
    description: "Remove a participant lifecycle subscription",
    inputSchema: idSchema,
    risk: "agent",
  },
  {
    name: "models",
    description:
      "List models exposed by the selected runner. Claude models are enumerated from the installed Claude Code runtime, not hard-coded.",
    inputSchema: {
      type: "object",
      properties: {
        runner: { type: "string", pattern: RUNNER_ID_SOURCE, maxLength: 64 },
        refresh: { type: "boolean" },
      },
      additionalProperties: false,
    },
    risk: "execute",
  },
  {
    name: "switchModel",
    description:
      "Switch Main's live Pi session model in place. The model selector accepts an exact provider/id, a configured models.aliases name (alias chains try each target in order until one is authenticated), an exact model id, or a search term; inexact terms resolve to the closest match, preferring recently used models (via pi-model-sort usage, when present).",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: "provider/id, alias name, or search term",
        },
        provider: { type: "string" },
      },
      required: ["model"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "stop",
    description: "Stop a local or remotely owned agent or actor that advertises the stop capability",
    inputSchema: idSchema,
    risk: "agent",
  },
  {
    name: "cleanup",
    description: "Remove a completed agent's run files and optional Git worktree",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        deleteBranch: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "write",
  },
  {
    name: "create",
    description:
      'Create a persistent actor with independently selected session or project storage. Use scope "global" to save a reusable project-independent template instead of a live actor.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        instructions: { type: "string" },
        events: {
          type: "array",
          items: {
            type: "string",
            enum: [...FABRIC_ACTOR_HOST_EVENTS],
          },
        },
        topics: { type: "array", items: { type: "string" } },
        delivery: {
          type: "string",
          enum: ["mailbox", "steer", "followUp", "nextTurn"],
        },
        responseMode: { type: "string", enum: ["text", "directive"] },
        triggerTurn: { type: "boolean" },
        coalesce: { type: "boolean" },
        residency: residencySchema,
        runner: runProperties.runner,
        kernel: runProperties.kernel,
        model: runProperties.model,
        thinking: runProperties.thinking,
        tools: runProperties.tools,
        transport: runProperties.transport,
        timeoutMs: runProperties.timeoutMs,
        extensions: runProperties.extensions,
        requires: {
          type: "array",
          maxItems: 128,
          description: "Exact Fabric provider.action refs committed before every actor run. Object entries may be optional.",
          items: {
            oneOf: [
              { type: "string", minLength: 3, maxLength: 256 },
              {
                type: "object",
                properties: {
                  ref: { type: "string", minLength: 3, maxLength: 256 },
                  optional: { type: "boolean" },
                },
                required: ["ref"],
                additionalProperties: false,
              },
            ],
          },
        },
        validWhile: {
          type: "object",
          properties: { version: { const: 1 }, source: { type: "string" } },
          required: ["version", "source"],
          additionalProperties: false,
        },
        scope: {
          type: "string",
          enum: ["session", "project", "global"],
          description: "session isolates the actor to the root Pi session; project shares it across sessions; global creates a non-live template.",
        },
      },
      required: ["name", "instructions"],
      oneOf: [
        {
          properties: {
            delivery: { const: "mailbox" },
            triggerTurn: { const: false },
          },
        },
        {
          properties: {
            delivery: { const: "nextTurn" },
            triggerTurn: { const: false },
          },
          required: ["delivery"],
        },
        {
          properties: { delivery: { enum: ["steer", "followUp"] } },
          required: ["delivery", "triggerTurn"],
        },
      ],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "ask",
    description: "Send a message to a persistent actor through its live owner and wait for its next response. Optional model/thinking values apply only to this activation.",
    inputSchema: {
      type: "object",
      properties: actorInvocationProperties,
      required: ["id", "message"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "tell",
    description: "Queue a message through a persistent actor's live owner without waiting. Optional model/thinking values apply only to this activation.",
    inputSchema: {
      type: "object",
      properties: actorInvocationProperties,
      required: ["id", "message"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "steer",
    description:
      "Steer Main, a running one-shot agent between turns, or a persistent actor through its mailbox. The stable id alias main targets the root user-facing Pi session. Non-local targets route over the project mesh.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, message: { type: "string" }, data: {} },
      required: ["id", "message"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "followUp",
    description:
      "Queue a follow-up for Main or a running one-shot agent, or enqueue a persistent actor mailbox message. The stable id alias main targets the root user-facing Pi session. Non-local targets route over the project mesh.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, message: { type: "string" }, data: {} },
      required: ["id", "message"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "setSteeringMode",
    description:
      "Set how queued steer messages are delivered to a running one-shot agent: all at once after the current turn, or one per turn (default). Local agent only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        mode: { type: "string", enum: ["all", "one-at-a-time"] },
      },
      required: ["id", "mode"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "setFollowUpMode",
    description:
      "Set how queued follow-up messages are delivered to a one-shot agent: all when it finishes, or one per completion (default). Local agent only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        mode: { type: "string", enum: ["all", "one-at-a-time"] },
      },
      required: ["id", "mode"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "compact",
    description:
      "Request an advisory compaction of a running Pi-runner child agent's context at its next safe boundary (between its own turns), preserving the child's accumulated context. Rejected for Claude-runner children. The child pi core applies the compaction; Fabric only forwards the intent.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        instructions: {
          type: "string",
          description: "Optional custom compaction instructions forwarded to the child pi",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "actorStatus",
    description: "Read one persistent actor's status",
    inputSchema: idSchema,
    risk: "read",
  },
  {
    name: "actors",
    description:
      'List persistent actors. Default scope "project" lists live actors in this Fabric session; scope "global" lists project-independent templates in the global registry.',
    inputSchema: {
      type: "object",
      properties: { scope: { type: "string", enum: ["project", "global"] } },
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "messages",
    description: "Read a persistent actor's bounded inbox and outbox history",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, limit: { type: "number", minimum: 1 } },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "setModel",
    description:
      "Change or clear a persistent actor model binding. Session scope is the default; project scope explicitly pins the shared definition default.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        model: { type: "string" },
        scope: actorBindingScopeSchema,
      },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "setThinking",
    description:
      "Change or clear a persistent actor reasoning-effort binding. Session scope is the default; project scope explicitly pins the shared definition default.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        thinking: runProperties.thinking,
        scope: actorBindingScopeSchema,
      },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "setTools",
    description:
      "Replace a persistent actor's tool allowlist. Takes effect on its next queued message; an empty list disables optional tools.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        tools: runProperties.tools,
        scope: { type: "string", enum: ["project", "global"] },
      },
      required: ["id", "tools"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "setEvents",
    description: "Replace a persistent actor's session-bound Pi and synthetic tool_error event subscriptions",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        events: {
          type: "array",
          items: {
            type: "string",
            enum: [...FABRIC_ACTOR_HOST_EVENTS],
          },
        },
      },
      required: ["id", "events"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "setDeliveryPolicy",
    description:
      "Replace a project actor or global template delivery policy. steer/followUp require an explicit triggerTurn choice; mailbox/nextTurn require false.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        delivery: {
          type: "string",
          enum: ["mailbox", "steer", "followUp", "nextTurn"],
        },
        triggerTurn: { type: "boolean" },
        scope: { type: "string", enum: ["project", "global"] },
      },
      required: ["id", "delivery", "triggerTurn"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "clearMessages",
    description: "Clear a persistent actor's recorded message history",
    inputSchema: idSchema,
    risk: "write",
  },
  {
    name: "remove",
    description:
      'Stop and remove a persistent actor. Default scope "project" removes a live project actor; scope "global" removes a project-independent template from the global registry.',
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        scope: { type: "string", enum: ["project", "global"] },
      },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "setInstructions",
    description:
      'Replace an actor\'s default instruction (its persona / system-prompt body). Default scope "project" edits a live project actor; scope "global" edits a project-independent template. Takes effect on the actor\'s next queued message.',
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        instructions: { type: "string" },
        scope: { type: "string", enum: ["project", "global"] },
      },
      required: ["id", "instructions"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "import",
    description:
      "Import a project-independent template from the global registry into the current project as a fresh live actor with no inherited history (no messages, session, or run logs). Identify the template by id or name; optionally rename the imported actor with \"as\" to avoid colliding with a live actor.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Template id or name (one of id/name required)" },
        name: { type: "string", description: "Template name (one of id/name required)" },
        as: { type: "string", description: "Optional new name for the imported live actor" },
      },
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "export",
    description:
      "Export a live project actor's definition to the global registry as a project-independent template, without any history (no messages, session, or run logs). Throws on a name collision unless overwrite is true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        overwrite: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "write",
  },
  {
    name: "log",
    description:
      "Read an actor or agent run's LLM/agent log: the actor's session transcript (session.jsonl) and/or a retained run's event stream (events.jsonl: tool calls, model responses, usage). Actors retain their last runs so logs survive after success.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Actor ID/name or agent run ID" },
        type: {
          type: "string",
          enum: ["session", "run", "all"],
          description:
            "session = actor session transcript (default for actors); run = last retained run's events; all = both",
        },
        lines: { type: "number", minimum: 1, description: "Page line limit (default 200)" },
        before: {
          type: "number",
          minimum: 0,
          description: "Exclusive line cursor returned by a previous page to load older entries",
        },
        runId: { type: "string", description: "Specific retained run (default: actor's last run)" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "read",
  },
];
