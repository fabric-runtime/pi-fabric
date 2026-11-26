// Language-neutral execution contract shared by all Fabric kernel backends.
export type FabricKernel = "typescript" | "python";

export type FabricSandboxTerminationReason =
  | "completed"
  | "runtime_error"
  | "timed_out"
  | "aborted";

export interface FabricSandboxResult {
  value: unknown;
  logs: string[];
  /** Explicit image() output, including partial output on errors. */
  emitted?: unknown[];
  terminationReason: FabricSandboxTerminationReason;
  error?: string;
}

/** A host-call result exactly as the guest received it. */
export type FabricJournalOutcome =
  | { ok: true; json?: string }
  | {
      ok: false;
      message: string;
      bashExit?: { exitCode: number; output: string };
      fields?: Array<[string, number]>;
    };

/** One recorded result, served on resume in its recorded delivery order. */
export interface FabricJournalDelivery {
  seq: number;
  /** Bridge ref the guest issued. */
  ref: string;
  /** Tool ref behind fabric.$call or fabric.$nativeTool. */
  target?: string;
  digest: string;
  /** Logical time the guest saw when this result arrived. */
  at: number;
  outcome: FabricJournalOutcome;
  /** Host-local state the execution service restores for a served call. */
  local?: unknown;
}

/** Why a resume stops. `question`, when present, asks whether the one call
 * that may have run should run again; only an explicit yes repeats it. */
export interface FabricJournalStop {
  report: string;
  question?: string;
}

/**
 * Records and replays one QuickJS execution (see exec-journal.ts). The runtime
 * numbers host calls as the guest issues them, delivers results one at a time,
 * and on resume serves recorded results before any call reaches the host.
 */
export interface FabricJournalDriver {
  /** Guest prelude that pins the clock, Math.random, and the time zone. */
  readonly shim: string;
  readonly startedAt: number;
  /** True when resuming: every call waits until the recorded results are served. */
  readonly resuming: boolean;
  readonly replay: readonly FabricJournalDelivery[];
  digest(args: Record<string, unknown>): string;
  /**
   * Append a completion before the guest sees it; returns the guest's new
   * clock. A driver that saves asynchronously returns a promise: the runtime
   * delivers the result only after it resolves, delivers results in the order
   * complete() was called, and stops the program when it rejects.
   */
  complete(
    seq: number,
    ref: string,
    args: Record<string, unknown>,
    value: unknown,
    outcome: FabricJournalOutcome,
  ): number | Promise<number>;
  /** Restore host-local state; stop work when the execution signal aborts. */
  served(delivery: FabricJournalDelivery, args: Record<string, unknown>, signal: AbortSignal): void | Promise<void>;
  /** After serving: a stop, or undefined to run the waiting calls live. */
  frontier(
    held: ReadonlyArray<{ seq: number; ref: string; args: Record<string, unknown> }>,
  ): FabricJournalStop | undefined;
  diverged(
    expected: FabricJournalDelivery,
    actual?: { ref: string; args: Record<string, unknown> },
  ): string;
}

export interface FabricSandboxOptions {
  timeoutMs: number;
  nativeStoreEnabled?: boolean;
  nativeToolsEnabled?: boolean;
  codemodeProfile?: "additive" | "native";
  memoryLimitBytes: number;
  /** Optional uninterrupted guest CPU limit. Await host work/timers to yield. */
  maxCpuSliceMs?: number;
  maxPendingTimers?: number;
  maxLogChars?: number;
  strings?: Record<string, string>;
  tokenBudget?: number;
  signal?: AbortSignal;
  cwd?: string;
  minimumTimeoutMsForHostCall?(
    ref: string,
    args: Record<string, unknown>,
  ): number | undefined;
  /** True for a host call that waits for a person (executor.humanWaitRefs).
   * The program deadline is paused while any such call is in flight. */
  isHumanWaitHostCall?(ref: string, args: Record<string, unknown>): boolean;
  /** Receives the running program deadline (epoch ms) each time it is set,
   * raised or resumed, and undefined while a human wait pauses it. */
  onDeadline?(deadlineAt: number | undefined): void;
  /** Declared core override fields must not be consumed as built-in aliases. */
  piToolCanonicalFields?: Record<string, string[]>;
  /**
   * Registered providers to expose as globals named after them. Each call is
   * a `fabric.$call` host call, exactly like `tools.call`. Kernels skip any
   * name src/provider-globals.ts refuses and never replace an existing global.
   */
  providerGlobals?: readonly string[];
  transpiledCode?: string;
  transpiledSourceMap?: string;
  /** Static π.<key> references from the compiler AST for this exact source. */
  payloadKeys?: readonly string[];
  /** Durable crash journal; QuickJS only. Absent means unchanged behavior. */
  journal?: FabricJournalDriver;
  /** On resume, asks a person whether a call that may have run should run
   * again. Only `true` repeats it; any other outcome keeps the stop. */
  confirmRepeat?: {
    ask(question: string, signal: AbortSignal): Promise<boolean>;
    /** Pause the program deadline while asking. A hard deadline never pauses. */
    pausesDeadline: boolean;
  };
}

/** Runs a host-side wait for a person with the program deadline paused.
 * The deadline resumes with its saved budget when the wait settles. */
export type FabricHumanWait = <T>(wait: () => Promise<T>) => Promise<T>;

export type FabricHostCall = (
  ref: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  /** Supplied by runtimes so the host can pause the deadline for a human
   * step inside an ordinary call, such as an approval prompt. */
  humanWait?: FabricHumanWait,
  /** Present only for a journaled call; `seq` is its issue order. */
  call?: { seq: number },
) => Promise<unknown>;

export interface FabricKernelRuntime {
  execute(
    code: string,
    hostCall: FabricHostCall,
    options: FabricSandboxOptions,
  ): Promise<FabricSandboxResult>;
}
