// Which registered Fabric providers become program globals, and which names
// they can never take. Dependency-free: every kernel and the runtime's
// registration path import it. Keep it out of the startup graph (FabricState
// does not import it). tests/provider-globals.test.ts derives every list
// below from the kernels, the guest declarations, TypeScript's keyword table,
// the Python interpreter and the built-in provider sources, and fails when a
// new global or built-in provider is missing here.

/** Globals Fabric defines in at least one kernel (TypeScript or Python). */
const FABRIC_GLOBALS = [
  "agent", "agents", "budget", "cache", "clearInterval", "clearTimeout", "compact",
  "components", "console", "council", "decisions", "describeNamespace", "describeTool",
  "exit", "extensions", "fabric", "image", "jev", "load", "log", "mcp", "memory", "mesh",
  "models", "nativeDiscovery", "nativeTools", "parallel", "payloads", "phase", "pi",
  "pipeline", "prewalk", "print", "programs", "rlm", "schema", "searchTools",
  "setInterval", "setTimeout", "state", "store", "text", "thinking", "tools", "workflow",
  // CPython and Monty bind asyncio in every program namespace.
  "asyncio",
] as const;

/** Fabric's own providers, including the ones without a global. */
const BUILTIN_PROVIDERS = [
  "agents", "cache", "compact", "components", "decisions", "extensions", "fabric", "jev",
  "mcp", "memory", "mesh", "native", "pi", "prewalk", "programs", "schema", "sessions",
  "state", "tasks", "thinking",
] as const;

/** Names a program prelude binds: saved programs read `input`, Jev programs call `program`. */
const PROGRAM_NAMES = ["input", "program"] as const;

/** Lowercase TypeScript keywords, a superset of JavaScript's reserved words. */
const TYPESCRIPT_KEYWORDS = [
  "abstract", "accessor", "any", "as", "assert", "asserts", "async", "await", "bigint",
  "boolean", "break", "case", "catch", "class", "const", "constructor", "continue",
  "debugger", "declare", "default", "defer", "delete", "do", "else", "enum", "export",
  "extends", "false", "finally", "for", "from", "function", "get", "global", "if",
  "implements", "import", "in", "infer", "instanceof", "interface", "intrinsic", "is",
  "keyof", "let", "module", "namespace", "never", "new", "null", "number", "object", "of",
  "out", "override", "package", "private", "protected", "public", "readonly", "require",
  "return", "satisfies", "set", "static", "string", "super", "switch", "symbol", "this",
  "throw", "true", "try", "type", "typeof", "undefined", "unique", "unknown", "using",
  "var", "void", "while", "with", "yield",
] as const;

/**
 * Lowercase JavaScript globals in the sandboxes, plus common host globals a
 * program might expect. `arguments` is listed because the program body runs
 * inside a function, where it names that function's own arguments.
 */
const JAVASCRIPT_GLOBALS = [
  "arguments", "atob", "btoa", "crypto", "document", "escape", "eval", "exports", "fetch",
  "navigator", "performance", "process", "self", "unescape", "window",
] as const;

const PYTHON_KEYWORDS = [
  "and", "as", "assert", "async", "await", "break", "case", "class", "continue", "def",
  "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
  "is", "lambda", "match", "nonlocal", "not", "or", "pass", "raise", "return", "try",
  "type", "while", "with", "yield",
  // Soft keyword added in Python 3.15 (PEP 810, explicit lazy imports).
  "lazy",
] as const;

const PYTHON_BUILTINS = [
  "abs", "aiter", "all", "anext", "any", "ascii", "bin", "bool", "breakpoint", "bytearray",
  "bytes", "callable", "chr", "classmethod", "compile", "complex", "copyright", "credits",
  "delattr", "dict", "dir", "divmod", "enumerate", "eval", "exec", "exit", "filter",
  "float", "format", "frozendict", "frozenset", "getattr", "globals", "hasattr", "hash", "help", "hex",
  "id", "input", "int", "isinstance", "issubclass", "iter", "len", "license", "list",
  "locals", "map", "max", "memoryview", "min", "next", "object", "oct", "open", "ord", "pow",
  "print", "property", "quit", "range", "repr", "reversed", "round", "sentinel", "set", "setattr",
  "slice", "sorted", "staticmethod", "str", "sum", "super", "tuple", "type", "vars", "zip",
] as const;

/** At most this many provider globals per program; the rest stay reachable through tools.call. */
export const MAX_PROVIDER_GLOBALS = 64;

/** A provider global is a lowercase ASCII identifier of at most 64 characters. */
const PROVIDER_GLOBAL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

// Same shape the registry accepts; other names never register, so they need no warning.
const REGISTRY_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

const RESERVED = new Map<string, string>();
const reserve = (owner: string, names: readonly string[]): void => {
  for (const name of names) if (!RESERVED.has(name)) RESERVED.set(name, `${owner} "${name}"`);
};
reserve("the Fabric program global", FABRIC_GLOBALS);
reserve("the built-in Fabric provider", BUILTIN_PROVIDERS);
reserve("the program-prelude name", PROGRAM_NAMES);
reserve("the TypeScript keyword", TYPESCRIPT_KEYWORDS);
reserve("the JavaScript global", JAVASCRIPT_GLOBALS);
reserve("the Python keyword", PYTHON_KEYWORDS);
reserve("the Python builtin", PYTHON_BUILTINS);

const NOT_AN_IDENTIFIER =
  "a program global must be a lowercase identifier (a-z, 0-9, _) of at most 64 characters";

/** What a provider name clashes with, or undefined when it can be a program global. */
export const providerGlobalConflict = (name: string): string | undefined =>
  PROVIDER_GLOBAL_NAME_PATTERN.test(name) ? RESERVED.get(name) : NOT_AN_IDENTIFIER;

export const isProviderGlobalName = (name: string): boolean =>
  providerGlobalConflict(name) === undefined;

/** The eligible names, deduplicated, sorted and capped: the exact globals a program gets. */
export const providerGlobalNames = (names: Iterable<string>): string[] =>
  [...new Set(names)]
    .filter(isProviderGlobalName)
    .sort()
    .slice(0, MAX_PROVIDER_GLOBALS);

const providerGlobalWarning = (name: string, conflict: string): string =>
  `Fabric provider "${name}" gets no program global: ${conflict === NOT_AN_IDENTIFIER
    ? conflict
    : `the name clashes with ${conflict}`}. Call its actions with tools.call({ ref: "${name}.<action>", args }).`;

const warned = new Set<string>();

/**
 * Warn once per process when a provider registered by another extension
 * cannot have a program global. Names the registry would refuse are skipped.
 */
export const warnProviderGlobalConflict = (
  name: string,
  warn: (message: string) => void = (message) => console.warn(`[pi-fabric] ${message}`),
): boolean => {
  if (!REGISTRY_NAME_PATTERN.test(name) || warned.has(name)) return false;
  const conflict = providerGlobalConflict(name);
  if (conflict === undefined) return false;
  warned.add(name);
  warn(providerGlobalWarning(name, conflict));
  return true;
};
