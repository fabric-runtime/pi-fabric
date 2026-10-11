import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentSessionRuntime, createAgentSessionServices, createCodemodeExtension,
  createMcpExtension, createToolSearchExtension, ExtensionRunner, getAgentDir,
  hasTrustRequiringProjectResources, ProjectTrustStore, resolveCliModel,
  runRpcMode, SessionManager, SettingsManager,
  type CreateAgentSessionRuntimeFactory, type LoadExtensionsResult,
  type ProjectTrustContext, type ProjectTrustHandler,
} from "@earendil-works/pi-coding-agent";
import { createDurableAgentSession } from "./session.js";
import { openDurableWorkerStorage } from "./storage.js";
import type { DurableWorkerOptions } from "./worker-options.js";

/** Match native headless trust: only global/explicit extensions can decide trust. */
export async function resolveDurableProjectTrust(options: {
  cwd: string; agentDir: string; extensionsResult: LoadExtensionsResult;
  defaultProjectTrust: "ask" | "always" | "never";
}): Promise<boolean> {
  if (!hasTrustRequiringProjectResources(options.cwd)) return true;
  const store = new ProjectTrustStore(options.agentDir);
  const context: ProjectTrustContext = {
    cwd: options.cwd, mode: "rpc", hasUI: false,
    ui: { select: async () => undefined, confirm: async () => false,
      input: async () => undefined, notify: message => process.stderr.write(`${message}\n`) },
  };
  for (const extension of options.extensionsResult.extensions) {
    for (const handler of extension.handlers.get("project_trust")?.slice() ?? []) {
      try {
        const result = await (handler as ProjectTrustHandler)({ type: "project_trust", cwd: options.cwd }, context);
        if (result?.trusted !== "yes" && result?.trusted !== "no") continue;
        const trusted = result.trusted === "yes";
        if (result.remember === true) store.set(options.cwd, trusted);
        return trusted;
      } catch (error) {
        process.stderr.write(`Extension ${extension.path} project_trust error: ${String(error)}\n`);
      }
    }
  }
  return store.get(options.cwd) ?? options.defaultProjectTrust === "always";
}

// Sessions here run on the pinned worker SDK, a class identity Fabric's tool
// capture cannot locate by itself (see HOST_RUNNERS_SYMBOL in
// src/capture/interceptor.ts). Advertise it before extensions load. A global
// stays process-local, unlike an environment variable; it is inline so the
// extension's startup graph gains no chunk shared with this worker module.
const advertiseHostExtensionRunner = (): void => {
  const key = Symbol.for("pi-fabric.host-extension-runners.v1");
  const holder = globalThis as typeof globalThis & { [key: symbol]: Set<unknown> | undefined };
  (holder[key] ??= new Set()).add(ExtensionRunner);
};

/** A full native Pi runtime host whose Agent scheduling is owned by pi-durable. */
export async function createDurableWorkerRuntime(options: DurableWorkerOptions): Promise<AgentSessionRuntime> {
  advertiseHostExtensionRunner();
  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const manager = options.sessionFile ? SessionManager.open(options.sessionFile, undefined, cwd) : SessionManager.inMemory(cwd);
  let current: { close(): Promise<void> } | undefined;
  const initialSessionId = manager.getSessionId();
  let first = true;
  const closeCurrent = async () => {
    const previous = current;
    current = undefined;
    await previous?.close();
  };
  const factory: CreateAgentSessionRuntimeFactory = async target => {
    // The native runtime already aborts, emits shutdown, and disposes the old session.
    await closeCurrent();
    const settings = SettingsManager.create(target.cwd, target.agentDir, { projectTrusted: false });
    const services = await createAgentSessionServices({
      cwd: target.cwd, agentDir: target.agentDir, settingsManager: settings,
      modelRuntimeSignal: AbortSignal.timeout(15_000),
      resourceLoaderReloadOptions: {
        resolveProjectTrust: ({ extensionsResult }) => resolveDurableProjectTrust({
          cwd: target.cwd, agentDir: target.agentDir, extensionsResult,
          defaultProjectTrust: settings.getDefaultProjectTrust(),
        }),
      },
      resourceLoaderOptions: {
        additionalExtensionPaths: options.extensions,
        noExtensions: options.noExtensions,
        appendSystemPrompt: options.appendSystemPrompt ? [options.appendSystemPrompt] : [],
        extensionFactories: [
          { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
          { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
          { name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
        ],
      },
    });
    const extensionErrors = services.resourceLoader.getExtensions().errors;
    if (extensionErrors.length) throw new Error(`Durable worker extension loading failed: ${JSON.stringify(extensionErrors)}`);
    for (const diagnostic of services.diagnostics) {
      process.stderr.write(`${diagnostic.type}: ${diagnostic.message}\n`);
    }
    const selection = resolveCliModel({
      ...(options.model ? { cliModel: options.model } : {}),
      ...(options.provider ? { cliProvider: options.provider } : {}),
      ...(options.thinking ? { cliThinking: options.thinking } : {}),
      modelRuntime: services.modelRuntime,
    });
    if (selection.error) throw new Error(selection.error);
    if (selection.warning) process.stderr.write(`${selection.warning}\n`);
    // The initial run path is stable even for non-exported sessions on restart.
    // Native /new, /fork, and /resume receive separate durable conversation stores.
    const recoverInitialRequest = first;
    const sessionId = target.sessionManager.getSessionId();
    const key = sessionId === initialSessionId ? "initial" : createHash("sha256").update(sessionId).digest("hex");
    first = false;
    const lease = await openDurableWorkerStorage(path.join(options.directory, key));
    try {
      const host = await createDurableAgentSession({
        ...services, sessionManager: target.sessionManager,
        ...(target.sessionStartEvent ? { sessionStartEvent: target.sessionStartEvent } : {}),
        storage: lease.storage, runId: `${options.runId}:${key}`,
        ...(selection.model ? { model: selection.model } : {}),
        ...((options.thinking ?? selection.thinkingLevel) ? { thinkingLevel: (options.thinking ?? selection.thinkingLevel)! } : {}),
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.noTools ? { noTools: options.noTools } : {}),
      });
      // A normal /new, /fork, or /resume is a new request, not crash recovery
      // of this store's original submission. Keep its journal but admit new work.
      if (!recoverInitialRequest) host.agent.setRequestId(randomUUID());
      current = { close: async () => {
        try { await host.agent.close(); }
        finally {
          try { await lease.storage.close(BACKGROUND_CONTEXT); }
          finally { await lease.release(); }
        }
      } };
      return { session: host.session, extensionsResult: services.resourceLoader.getExtensions(), services, diagnostics: services.diagnostics };
    } catch (error) {
      try { await lease.storage.close(BACKGROUND_CONTEXT); } finally { await lease.release(); }
      throw error;
    }
  };
  const initial = await factory({ cwd, agentDir, sessionManager: manager });
  class DurableRuntime extends AgentSessionRuntime {
    override async dispose(): Promise<void> {
      try { await super.dispose(); } finally { await closeCurrent(); }
    }
  }
  return new DurableRuntime(initial.session, initial.services, factory, initial.diagnostics);
}

export async function runDurableWorker(options: DurableWorkerOptions): Promise<void> {
  const runtime = await createDurableWorkerRuntime(options);
  try { await runRpcMode(runtime); }
  finally { await runtime.dispose(); }
}
