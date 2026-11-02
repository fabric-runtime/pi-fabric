// Shared host for the createFabricExtension tests: a bare pi-durable Harness the way a
// host such as Revere's agent host runs one, with stub tools, a tenant guard shaped like
// Revere's tenantGuard, a scripted faux model and Fabric installed from the registry.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
  type Message,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  hook,
  MemoryStorage,
  ToolTask,
  type Conversation,
  type ConversationId,
  type HarnessSettings,
  type Report,
  type Storage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { createFabricExtension, type FabricExtensionOptions } from "../src/durable-extension.js";

export const ctx: Context = BACKGROUND_CONTEXT;
export const MODEL = { provider: "test", modelId: "scripted" } as const;

export interface StubCall {
  readonly name: string;
  readonly args: unknown;
  readonly conversationId: ConversationId;
}

export interface TurnResult {
  /** Text of the fabric_exec result the model saw. */
  readonly text: string;
  readonly isError: boolean;
  readonly status: string;
  /** The tool call id the model used. */
  readonly callId: string;
  /** System messages (prompt sections and tool declarations) of the request that issued the call. */
  readonly prompt: string;
  /** Names of the tools that request offered the model. */
  readonly offered: readonly string[];
  /** The prompt sections in force for that request: later system messages replace or remove earlier ones. */
  readonly sections: Readonly<Record<string, string>>;
}

const textOf = (message: Message | undefined): string => {
  if (message === undefined) return "";
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part: { type: string; text?: string }) => part.type === "text" ? part.text : "").join("") : "";
};

/** A one-shot latch a stub tool can wait on. */
export const latch = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
};

export interface HostOptions {
  readonly fabric?: FabricExtensionOptions;
  readonly storage?: Storage;
  readonly tools?: readonly ToolRegistration[];
  readonly onReport?: (report: Report) => void;
  readonly settings?: HarnessSettings;
}

export async function openHost(options: HostOptions = {}) {
  const calls: StubCall[] = [];
  /** Tenant of each conversation, as the host's conversation scope holds it. */
  const tenants = new Map<ConversationId, string>();
  const stub = (name: string, extra: Partial<ToolRegistration> = {}): ToolRegistration => ({
    ...defineTool({
      name,
      description: `Stub ${name} search tool`,
      parameters: Type.Object({ query: Type.Optional(Type.String()) }),
      execute: async (args, api) => {
        calls.push({ name, args, conversationId: api.conversationId });
        return { output: [{ type: "text", text: `${name}:${args.query ?? ""}` }] };
      },
    }),
    ...extra,
  });
  const hostTools = defineExtension({
    name: "host-tools",
    tools: [
      stub("search_knowledge"),
      stub("secret_admin"),
      stub("model_only", { callers: ["model"] }),
      defineTool({
        name: "fail_tool",
        description: "Always fails",
        parameters: Type.Object({}),
        execute: async (_args, api) => {
          calls.push({ name: "fail_tool", args: {}, conversationId: api.conversationId });
          return { output: [{ type: "text", text: "quota exceeded for this key" }], isError: true };
        },
      }),
      ...(options.tools ?? []),
    ],
  });
  // Shaped like Revere's tenantGuard: the tenant comes from the conversation, never from tool
  // arguments; any argument naming another tenant blocks the call.
  const guard = defineExtension({
    name: "tenant-guard",
    hooks: [hook(ToolTask, {
      beforeTool: (call, api) => {
        if (call.name === "fabric_exec") return undefined;
        const own = tenants.get(api.conversationId);
        const named = JSON.stringify(call.arguments).match(/\bt_[a-z0-9]+\b/g) ?? [];
        return named.some((tenant) => tenant !== own) ? { block: "tool arguments name another tenant" } : undefined;
      },
    })],
  });

  const faux = fauxProvider({ provider: "test", models: [{ id: "scripted" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const programs = new Map<string, { code: string; payloads?: Record<string, string> }>();
  const results = new Map<string, { text: string; isError: boolean }>();
  const prompts = new Map<string, string>();
  const callIds = new Map<string, string>();
  const offered = new Map<string, string[]>();
  const sections = new Map<string, Record<string, string>>();
  let nextCall = 0;
  const respond: FauxResponseFactory = (context) => {
    const messages = context.messages;
    const key = textOf([...messages].reverse().find((message) => message.role === "user"));
    const last = messages.at(-1);
    if (last?.role === "toolResult") {
      results.set(key, { text: textOf(last), isError: (last as { isError?: boolean }).isError === true });
      programs.delete(key);
      return fauxAssistantMessage(fauxText("done"));
    }
    const program = programs.get(key);
    if (program === undefined) return fauxAssistantMessage(fauxText("summary of the conversation"));
    prompts.set(key, JSON.stringify(messages.filter((message) => message.role === "system")));
    // pi-ai 1.4 carries the offered tools as additions and removals on system messages.
    const names = new Set<string>();
    const shown: Record<string, string> = {};
    for (const message of messages) {
      if (message.role !== "system") continue;
      const change = message as { toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[]; sections?: Record<string, string | null> };
      for (const tool of change.toolsRemoved ?? []) names.delete(tool.name);
      for (const tool of change.toolsAdded ?? []) names.add(tool.name);
      for (const [name, text] of Object.entries(change.sections ?? {})) {
        if (text === null) delete shown[name];
        else shown[name] = text;
      }
    }
    offered.set(key, [...names]);
    sections.set(key, shown);
    const id = `call_${++nextCall}`;
    callIds.set(key, id);
    return fauxAssistantMessage([fauxToolCall("fabric_exec", program, { id })], { stopReason: "toolUse" });
  };
  faux.setResponses(Array.from({ length: 200 }, () => respond));

  const registry = createRegistry();
  registry.install(hostTools);
  registry.install(guard);
  // No cast: the extension's types are the host's pi-durable 1.5 types.
  // Tests that pass fabric options get exactly those; the rest get a short deadline.
  const fabric = createFabricExtension(options.fabric ?? { timeoutMs: 10_000 });
  registry.install(fabric);
  const harness = await Harness.open(options.storage ?? new MemoryStorage(), {
    models,
    registry,
    ...(options.onReport ? { onReport: options.onReport } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
  }, ctx);

  const conversation = async (tenant: string, agent: { tools?: ToolRegistration[] } = {}): Promise<Conversation> => {
    const created = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL, ...agent } }, ctx);
    tenants.set(created.id, tenant);
    return created;
  };

  /** Submit `input` (unique per test) and let the model run `code` as one fabric_exec call. */
  const turn = async (target: Conversation, input: string, code: string, payloads?: Record<string, string>): Promise<TurnResult> => {
    programs.set(input, { code, ...(payloads ? { payloads } : {}) });
    const submission = await target.submit({ type: "input", content: input }, ctx);
    const record = await submission.wait(ctx);
    const result = results.get(input);
    return {
      text: result?.text ?? "",
      isError: result?.isError ?? false,
      status: record.status,
      callId: callIds.get(input) ?? "",
      prompt: prompts.get(input) ?? "",
      offered: offered.get(input) ?? [],
      sections: sections.get(input) ?? {},
    };
  };

  return { harness, registry, fabric, faux, calls, tenants, conversation, turn, close: () => harness.close(ctx) };
}

/** Run one program in a fresh host and close it. */
export async function runProgram(code: string, options: HostOptions = {}, payloads?: Record<string, string>) {
  const host = await openHost(options);
  try {
    const conversation = await host.conversation("t_alpha");
    const run = await host.turn(conversation, "go", code, payloads);
    return { ...run, calls: host.calls, conversationId: conversation.id };
  } finally {
    await host.close();
  }
}
