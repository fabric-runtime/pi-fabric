import type { FabricActionDescriptor } from "../protocol.js";

// Argument-shape normalization shared by the stable Fabric providers,
// mirroring the pi core tool architecture:
//
// 1. prepareArguments canonicalizes near-miss argument spellings at the
//    registry prepare stage — aliases resolve to the canonical key (which
//    wins on conflict), value spellings repair, numeric strings coerce for
//    schema-declared numeric fields, and nullish values of declared
//    optionals are stripped.
// 2. validateArguments then owns the didactic failure tier: required
//    canonical keys are enforced and unknown keys fail
//    additionalProperties: false validation with the offending path named.
//
// Most of the repair surface is derived from each action's inputSchema
// rather than maintained by hand: key casing/spacing variants and
// singular/plural near-misses come from the declared property names,
// numeric coercion from the declared property types, and enum-value
// repairs (casing variants plus the shared synonym classes below) from the
// declared enum members. Only genuinely semantic synonyms need explicit
// vocabulary: the shared KEY_SYNONYM_CLASSES / ENUM_VALUE_CLASSES classes
// here, and provider-local `values` tables where the schema spells a
// concept as a free string instead of an enum (memory scope).

interface JsonSchemaObject {
  type?: unknown;
  properties?: unknown;
  enum?: unknown;
  items?: unknown;
  oneOf?: unknown;
  anyOf?: unknown;
}

export interface ArgNormalizationSpec {
  // Explicit escape-hatch rows. Prefer derivation or a shared synonym
  // class; keep entries here only for action-local semantics.
  aliases?: Readonly<Record<string, string>>;
  numerics?: readonly string[];
  numericArrays?: readonly string[];
  values?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  // Declared property names whose nullish values are stripped before
  // validation. Derived from the descriptor schema when omitted.
  knownKeys?: readonly string[];
}

export type ActionArgNormalizer = (
  actionName: string,
  args: Record<string, unknown>,
) => Record<string, unknown>;

// Casing/spacing/underscore-insensitive key and value form, e.g.
// "requested_by", "requestedBy", and "REQUESTED-BY" all share one form.
const normalizeForm = (key: string): string =>
  key.toLowerCase().replace(/[^a-z0-9]/g, "");

// Semantic near-miss vocabulary shared by every stable provider. A spilled
// key belonging to a class repairs to a declared canonical key only when
// exactly one member of that class is declared by the action's schema —
// ambiguity (or absence) leaves the key untouched so the validate stage
// owns its failure. `id` deliberately appears in several classes: the
// declared members of each action's schema disambiguate which repair fires
// (memory.expand takes a session id; agents.wait takes an agent id).
const KEY_SYNONYM_CLASSES: ReadonlyArray<ReadonlyArray<string>> = [
  ["session", "sessionId", "id", "file", "path"],
  ["hypothesisId", "id"],
  ["id", "agentId", "actorId", "runId"],
  ["query", "q"],
  ["limit", "max", "pageSize"],
  ["task", "prompt", "instructions"],
  ["label", "labels", "name", "title"],
  ["summary", "description"],
  ["text", "message", "body"],
  ["check", "command", "cmd", "script", "predicate"],
  ["files", "paths"],
  ["ifVersion", "versionRef", "version"],
  ["indices", "index"],
];

const KEY_CLASS_FORMS = KEY_SYNONYM_CLASSES.map(
  (cls) => new Set(cls.map(normalizeForm)),
);

// Synonym classes for schema enum values, applied only when the declared
// enum contains exactly one class member. Scope spellings such as `cwd` →
// "project" repair wherever an enum spells that concept this way; a schema
// whose enum lacks the concept keeps the value untouched for validation.
const ENUM_VALUE_CLASSES: ReadonlyArray<ReadonlyArray<string>> = [
  ["project", "cwd", "repo", "repository", "workspace", "checkout", "tree"],
  ["global", "all"],
  ["permanent", "pinned", "sticky", "durable"],
];

const VALUE_CLASS_FORMS = ENUM_VALUE_CLASSES.map(
  (cls) => new Set(cls.map(normalizeForm)),
);

type NumericKind = "scalar" | "array" | undefined;

const numericKind = (property: unknown): NumericKind => {
  if (!property || typeof property !== "object") return undefined;
  const schema = property as JsonSchemaObject;
  if (schema.type === "number" || schema.type === "integer") return "scalar";
  if (schema.type === "array") {
    const items = schema.items;
    if (
      items &&
      typeof items === "object" &&
      ((items as JsonSchemaObject).type === "number" ||
        (items as JsonSchemaObject).type === "integer")
    ) {
      return "array";
    }
  }
  return undefined;
};

const stringEnumValues = (property: unknown): readonly string[] | undefined => {
  if (!property || typeof property !== "object") return undefined;
  const schema = property as JsonSchemaObject;
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter(
      (entry): entry is string => typeof entry === "string",
    );
    return values.length > 0 ? values : undefined;
  }
  for (const branch of [schema.oneOf, schema.anyOf]) {
    if (!Array.isArray(branch)) continue;
    const consts = branch
      .map((entry) =>
        entry && typeof entry === "object"
          ? (entry as { const?: unknown }).const
          : undefined,
      )
      .filter((entry): entry is string => typeof entry === "string");
    if (consts.length > 0) return consts;
  }
  return undefined;
};

// form → enum value. Exact forms of declared members win; class synonyms
// fill in only when exactly one declared member belongs to the class.
const deriveEnumValueMap = (
  values: readonly string[],
): Map<string, string> => {
  const map = new Map<string, string>();
  const seen = new Map<string, string | undefined>();
  for (const value of values) {
    const form = normalizeForm(value);
    seen.set(form, seen.has(form) ? undefined : value);
  }
  for (const [form, value] of seen) if (value !== undefined) map.set(form, value);
  for (const classForms of VALUE_CLASS_FORMS) {
    const members = values.filter((value) => classForms.has(normalizeForm(value)));
    if (members.length !== 1) continue;
    const [hit] = members as [string];
    for (const form of classForms) {
      if (form !== normalizeForm(hit) && !map.has(form)) map.set(form, hit);
    }
  }
  return map;
};

type DerivedAction = {
  declared: Set<string>;
  declaredForms: Map<string, string>;
  singulars: Map<string, string>;
  numerics: Set<string>;
  numericArrays: Set<string>;
  values: Map<string, Map<string, unknown>>;
  aliases?: Readonly<Record<string, string>> | undefined;
};

// The value-column meaning of the schema, precomputed once per action.
const deriveAction = (
  inputSchema: JsonSchemaObject | undefined,
  explicit: ArgNormalizationSpec | undefined,
): DerivedAction => {
  const properties =
    inputSchema && typeof inputSchema === "object" &&
    inputSchema.properties &&
    typeof inputSchema.properties === "object"
      ? (inputSchema.properties as Record<string, unknown>)
      : undefined;
  const declared = new Set(Object.keys(properties ?? {}));
  const declaredForms = new Map<string, string>();
  const ambiguousForms = new Set<string>();
  for (const key of declared) {
    const form = normalizeForm(key);
    if (declaredForms.has(form)) {
      ambiguousForms.add(form);
      declaredForms.delete(form);
    } else if (!ambiguousForms.has(form)) {
      declaredForms.set(form, key);
    }
  }
  const singulars = new Map<string, string>();
  for (const key of declared) {
    const form = normalizeForm(key);
    if (!form.endsWith("s")) continue;
    const singular = form.slice(0, -1);
    if (!singular || declaredForms.has(singular) || singular === form) continue;
    if (singulars.get(singular) !== undefined) singulars.delete(singular);
    else singulars.set(singular, key);
  }
  for (const form of ambiguousForms) singulars.delete(form);

  const numerics = new Set(explicit?.numerics ?? []);
  const numericArrays = new Set(explicit?.numericArrays ?? []);
  const values = new Map<string, Map<string, unknown>>();
  if (properties) {
    for (const [key, property] of Object.entries(properties)) {
      const kind = numericKind(property);
      if (kind === "scalar") numerics.add(key);
      else if (kind === "array") numericArrays.add(key);
      const enumValues = stringEnumValues(property);
      if (enumValues) values.set(key, new Map(deriveEnumValueMap(enumValues)));
    }
  }
  for (const [key, remaps] of Object.entries(explicit?.values ?? {})) {
    const map = values.get(key) ?? new Map<string, unknown>();
    for (const [spelling, target] of Object.entries(remaps)) {
      map.set(normalizeForm(spelling), target);
    }
    values.set(key, map);
  }
  return { declared, declaredForms, singulars, numerics, numericArrays, values, aliases: explicit?.aliases };
};

const lexiconRepair = (
  form: string,
  declaredForms: Map<string, string>,
): string | undefined => {
  const candidates = new Set<string>();
  for (const classForms of KEY_CLASS_FORMS) {
    if (!classForms.has(form)) continue;
    for (const [declaredForm, declaredKey] of declaredForms) {
      if (declaredForm !== form && classForms.has(declaredForm)) {
        candidates.add(declaredKey);
      }
    }
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
};

/** Unique declared key for a spilled spelling, or undefined when already
 * canonical / ambiguous / unmatched. Used by the catalog repair compiler. */
export const uniqueDeclaredKeyForSpelling = (
  spilled: string,
  declared: readonly string[],
): string | undefined => {
  if (declared.includes(spilled)) return undefined;
  const derived = deriveAction(
    {
      type: "object",
      properties: Object.fromEntries(declared.map((key) => [key, {}])),
    },
    undefined,
  );
  const form = normalizeForm(spilled);
  const canonical =
    derived.declaredForms.get(form) ??
    derived.singulars.get(form) ??
    lexiconRepair(form, derived.declaredForms);
  return canonical && canonical !== spilled ? canonical : undefined;
};

const applyDerived = (
  args: Record<string, unknown>,
  derived: DerivedAction,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...args };

  // Explicit action-local aliases first, then derived repairs. Both obey
  // canonical-wins: the canonical key keeps an already-supplied value and
  // the spelling variant is dropped either way.
  const repair = (alias: string, canonical: string) => {
    if (!(alias in out) || alias === canonical) return;
    if (!(canonical in out)) out[canonical] = out[alias];
    delete out[alias];
  };
  for (const [alias, canonical] of Object.entries(derived.aliases ?? {})) {
    repair(alias, canonical);
  }
  for (const key of [...Object.keys(out)]) {
    if (derived.declared.has(key)) continue;
    const form = normalizeForm(key);
    const canonical =
      derived.declaredForms.get(form) ??
      derived.singulars.get(form) ??
      lexiconRepair(form, derived.declaredForms);
    if (canonical && canonical !== key) repair(key, canonical);
  }

  for (const key of derived.numerics) {
    const value = out[key];
    if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
      out[key] = Number(value);
    }
  }
  for (const key of derived.numericArrays) {
    const value = out[key];
    if (Array.isArray(value)) {
      out[key] = value.map((entry) =>
        typeof entry === "string" && entry.trim() !== "" && !Number.isNaN(Number(entry))
          ? Number(entry)
          : entry,
      );
    }
  }
  for (const [key, remaps] of derived.values) {
    const value = out[key];
    if (typeof value === "string") {
      const next = remaps.get(normalizeForm(value));
      if (next !== undefined) out[key] = next;
    }
  }
  if (derived.declared.size > 0) {
    for (const key of Object.keys(out)) {
      if (derived.declared.has(key) && (out[key] === null || out[key] === undefined)) {
        delete out[key];
      }
    }
  }
  return out;
};

// Low-level explicit-spec normalizer. Used directly by tests and as the
// shared mechanics for per-key aliases, value spellings, numeric strings,
// and nullish stripping; actionArgNormalizer layers schema derivation and
// the shared synonym lexicon on top.
export const normalizeActionArgs = (
  args: Record<string, unknown>,
  spec: ArgNormalizationSpec,
): Record<string, unknown> => {
  const derived: DerivedAction = {
    // The low-level path strips nullish values only for explicit knownKeys;
    // schema-derived declared keys come from actionArgNormalizer.
    declared: new Set(spec.knownKeys ?? []),
    declaredForms: new Map(),
    singulars: new Map(),
    numerics: new Set(spec.numerics ?? []),
    numericArrays: new Set(spec.numericArrays ?? []),
    values: new Map(
      Object.entries(spec.values ?? {}).map(([key, remaps]) => [
        key,
        new Map(
          Object.entries(remaps).map(([spelling, target]) => [normalizeForm(spelling), target]),
        ),
      ]),
    ),
    aliases: spec.aliases,
  };
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  return applyDerived(args, derived);
};

// Build a provider prepareArguments hook. Repair behavior derives from each
// action's inputSchema (declared key forms, singular/plural variants,
// numeric property types, enum value spellings) plus the shared synonym
// lexicon; the residual table holds only action-local semantics the schema
// cannot express.
export const actionArgNormalizer = (
  describeActions: () => ReadonlyArray<Pick<FabricActionDescriptor, "name" | "inputSchema">>,
  table: Record<string, ArgNormalizationSpec> = {},
): ActionArgNormalizer => {
  const derived = new Map<string, DerivedAction>();
  for (const descriptor of describeActions()) {
    derived.set(
      descriptor.name,
      deriveAction(
        descriptor.inputSchema as JsonSchemaObject | undefined,
        table[descriptor.name],
      ),
    );
  }
  return (actionName, args) => {
    if (!args || typeof args !== "object" || Array.isArray(args)) return args;
    const action = derived.get(actionName);
    return action ? applyDerived(args, action) : args;
  };
};
