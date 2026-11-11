export const compareLexical = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Canonical Unicode-aware lexical tokens with no semantic classification. */
export const tokenizeLexical = (text: string): string[] =>
  [...text.normalize("NFKC").matchAll(/[\p{L}\p{N}_]+/gu)].map((match) =>
    match[0].toLowerCase(),
  );

export const normalizeMemoryPhrase = (text: string): string =>
  text.normalize("NFKC").toLowerCase();

export const lexicalTermCounts = (text: string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const term of tokenizeLexical(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
};

export type MemoryQueryMode = "literal" | "phrase" | "regex";
export type MemoryQueryMatch = "all" | "any";

export type MemoryQueryPlan =
  | { kind: "browse" }
  | { kind: "terms"; terms: string[]; match: MemoryQueryMatch }
  | { kind: "phrase"; phrase: string; terms: string[] }
  | { kind: "regex"; pattern: string };

/** Plan only the explicitly selected query mode. Literal input is never compiled as regex. */
export const planMemoryQuery = (
  query: string | undefined,
  queryMode: MemoryQueryMode = "literal",
  queryMatch: MemoryQueryMatch = "any",
): MemoryQueryPlan => {
  if (query === undefined || query.trim().length === 0) return { kind: "browse" };
  if (queryMode === "regex") return { kind: "regex", pattern: query };
  if (queryMode === "phrase") {
    return {
      kind: "phrase",
      phrase: normalizeMemoryPhrase(query.trim()),
      terms: [...new Set(tokenizeLexical(query))],
    };
  }
  return { kind: "terms", terms: [...new Set(tokenizeLexical(query))], match: queryMatch };
};
