// Fabric failures must reach a tool result or a log line, never Pi's crash
// handler. Abort reasons Fabric creates as control flow (control-abort.ts) carry
// a global-symbol brand that survives Node's own AbortError wrapping (`cause`),
// so a rejection nobody awaited can be recognized as Fabric's. Registration-time
// module imported only by the extension entry: keep it free of imports, or it
// becomes a shared chunk in the startup graph.

const CONTROL_ABORT = Symbol.for("pi-fabric.control-abort");
const GUARD = Symbol.for("pi-fabric.crash-guard");

interface GuardState {
  roots: Set<string>;
  log: (line: string) => void;
  listener: (reason: unknown) => void;
}

const causes = function* (value: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  for (let current = value, depth = 0; current !== undefined && current !== null && depth < 8; depth++) {
    if (seen.has(current)) return;
    seen.add(current);
    yield current;
    if (typeof current !== "object") return;
    current = (current as { cause?: unknown }).cause;
  }
};

/** True for a Fabric control abort, or an error caused by one (Node's AbortError). */
export const isFabricControlAbort = (value: unknown): boolean => {
  for (const item of causes(value)) {
    if (typeof item === "object" && Reflect.get(item as object, CONTROL_ABORT) === true) return true;
  }
  return false;
};

const normalize = (file: string): string => file.replaceAll("\\", "/");

/** True when a stack frame lies in Fabric's own compiled or source tree. */
const raisedByFabric = (value: unknown, roots: ReadonlySet<string>): boolean => {
  for (const item of causes(value)) {
    const stack = item instanceof Error && typeof item.stack === "string" ? normalize(item.stack) : "";
    if (!stack) continue;
    for (const root of roots) {
      if (stack.includes(`${root}/dist/`) || stack.includes(`${root}/src/`)) return true;
    }
  }
  return false;
};

/** Whether a failure belongs to Fabric: one of its control aborts, or raised from its code. */
export const fabricOwnsFailure = (value: unknown, roots: ReadonlySet<string> = guardState()?.roots ?? new Set()): boolean =>
  isFabricControlAbort(value) || raisedByFabric(value, roots);

const unhandledRejectionMode = (): string => {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/)];
  let mode = "throw";
  for (const flag of flags) {
    const match = /^--unhandled-rejections=(.+)$/.exec(flag);
    if (match) mode = match[1]!;
  }
  return mode;
};

const describe = (value: unknown): string => {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try { return String(value); } catch { return "unprintable value"; }
};

const guardState = (): GuardState | undefined =>
  (globalThis as Record<symbol, GuardState | undefined>)[GUARD];

/**
 * Keep Fabric-owned unhandled rejections from ending the Pi process. Each one
 * is logged once and dropped. Any other rejection keeps Node's behavior: in the
 * default mode it is rethrown, so Pi's own uncaught-exception handler still
 * reports it. One listener serves every Fabric copy in the process; each copy
 * adds its package root.
 */
export function installFabricCrashGuard(
  packageRoot: string,
  log: (line: string) => void = (line) => console.warn(`[pi-fabric] ${line}`),
): void {
  const existing = guardState();
  if (existing) {
    existing.roots.add(normalize(packageRoot).replace(/\/+$/, ""));
    return;
  }
  const state: GuardState = {
    roots: new Set([normalize(packageRoot).replace(/\/+$/, "")]),
    log,
    listener: (reason: unknown) => {
      if (fabricOwnsFailure(reason, state.roots)) {
        try { state.log(`detached work failed: ${describe(reason)}`); } catch { /* A log line cannot crash either. */ }
        return;
      }
      // Another listener has already taken over unhandled-rejection policy.
      if (process.listenerCount("unhandledRejection") > 1) return;
      const mode = unhandledRejectionMode();
      if (mode === "warn" || mode === "warn-with-error-code" || mode === "none") {
        if (mode !== "none") process.emitWarning(`Unhandled promise rejection: ${describe(reason)}`, "UnhandledPromiseRejectionWarning");
        if (mode === "warn-with-error-code") process.exitCode = 1;
        return;
      }
      if (reason instanceof Error) throw reason;
      const error = new Error(`This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${describe(reason)}".`);
      (error as Error & { code?: string }).code = "ERR_UNHANDLED_REJECTION";
      throw error;
    },
  };
  (globalThis as Record<symbol, GuardState>)[GUARD] = state;
  process.on("unhandledRejection", state.listener);
}

/** Test seam: remove the process listener and forget registered roots. */
export function uninstallFabricCrashGuard(): void {
  const state = guardState();
  if (!state) return;
  process.off("unhandledRejection", state.listener);
  delete (globalThis as Record<symbol, GuardState | undefined>)[GUARD];
}
