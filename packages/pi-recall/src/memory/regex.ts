import { Worker } from "node:worker_threads";

export interface RegexLimits {
  maxPatternBytes: number;
  timeoutMs: number;
}

export interface RegexExecutionError {
  code: "invalid_regex" | "regex_pattern_too_large" | "regex_timeout" | "regex_worker_error";
  message: string;
}

export type RegexExecutionResult =
  | { complete: true; matched: number[] }
  | { complete: false; matched: []; error: RegexExecutionError };

const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
parentPort.on("message", ({ pattern, haystacks }) => {
  try {
    const regex = new RegExp(pattern, "iu");
    const matched = [];
    for (let index = 0; index < haystacks.length; index += 1) {
      if (regex.test(haystacks[index])) matched.push(index);
    }
    parentPort.postMessage({ matched });
  } catch (error) {
    parentPort.postMessage({
      error: {
        code: "invalid_regex",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});
`;

/** Execute untrusted regex in a disposable worker that can be forcibly terminated. */
export const executeBoundedRegex = async (
  pattern: string,
  haystacks: string[],
  limits: RegexLimits,
): Promise<RegexExecutionResult> => {
  const patternBytes = Buffer.byteLength(pattern, "utf8");
  if (patternBytes > limits.maxPatternBytes) {
    return {
      complete: false,
      matched: [],
      error: {
        code: "regex_pattern_too_large",
        message: `Regex pattern is ${patternBytes} bytes; limit is ${limits.maxPatternBytes}.`,
      },
    };
  }

  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
      });
    } catch (error) {
      resolve({
        complete: false,
        matched: [],
        error: {
          code: "regex_worker_error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }
    let settled = false;
    const finish = (result: RegexExecutionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        complete: false,
        matched: [],
        error: {
          code: "regex_timeout",
          message: `Regex execution exceeded ${limits.timeoutMs} ms.`,
        },
      });
    }, limits.timeoutMs);
    worker.once("message", (message: unknown) => {
      const record = message as { matched?: unknown; error?: RegexExecutionError };
      if (record.error) {
        finish({ complete: false, matched: [], error: record.error });
        return;
      }
      if (Array.isArray(record.matched) && record.matched.every((value) => Number.isInteger(value))) {
        finish({ complete: true, matched: record.matched as number[] });
        return;
      }
      finish({
        complete: false,
        matched: [],
        error: { code: "regex_worker_error", message: "Regex worker returned an invalid result." },
      });
    });
    worker.once("error", (error: unknown) => {
      finish({
        complete: false,
        matched: [],
        error: {
          code: "regex_worker_error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
    worker.postMessage({ pattern, haystacks });
  });
};
