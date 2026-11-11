import { coverageComplete } from "../verified/policy.js";
import type { NormalizationCoverage, NormalizedEntry } from "./normalize.js";
import { compareLexical, tokenizeLexical } from "./tokenize.js";

const DEFAULT_FILES_TOUCHED_LIMIT = 50;

/** Compact structural posting: source identity, typed role/tool fields, time, and exact Fabric capability identity. */
export type DigestEntryAddress = [
  index: number,
  entryId: string | null,
  operationAddress: string | null,
  role: string | null,
  toolName: string | null,
  timestamp: number | null,
  ref: string | null,
  provider: string | null,
  action: string | null,
  outcome: NormalizedEntry["outcome"] | null,
];

interface DigestIndexCoverage {
  complete: boolean;
  vocabularyBytes: number;
  reasons: string[];
}

export interface SessionDigest {
  sessionId: string;
  file: string;
  cwd: string;
  firstTs: number | null;
  lastTs: number | null;
  entryCount: number;
  filesTouched: string[];
  toolHistogram: Record<string, number>;
  errorCount: number;
  /** Sorted exact unique canonical terms. Terms never contain posting lists. */
  vocabulary: string[];
  /** Structural entry identities retained independently from lexical vocabulary. */
  addresses: DigestEntryAddress[];
  indexCoverage: DigestIndexCoverage;
}

export interface DigestInput {
  sessionId: string;
  file: string;
  cwd: string;
  entries: NormalizedEntry[];
  maxVocabularyBytes?: number;
  filesTouchedLimit?: number;
  normalizationCoverage?: NormalizationCoverage;
}

const vocabularyJsonBytes = (terms: string[]): number =>
  Buffer.byteLength(JSON.stringify(terms), "utf8");

/** Purely fold normalized session entries into bounded lexical and structural metadata. */
export const foldSessionDigest = (input: DigestInput): SessionDigest => {
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let errorCount = 0;
  const filesTouched: string[] = [];
  const seenFiles = new Set<string>();
  const tools = new Map<string, number>();
  const vocabulary = new Set<string>();
  const filesLimit = Math.max(0, input.filesTouchedLimit ?? DEFAULT_FILES_TOUCHED_LIMIT);
  const maxVocabularyBytes = Math.max(2, input.maxVocabularyBytes ?? Number.MAX_SAFE_INTEGER);
  let filesLimitReached = false;
  let vocabularyLimitReached = false;
  let estimatedVocabularyBytes = 2;

  for (const entry of input.entries) {
    if (entry.timestamp !== null) {
      firstTs = firstTs === null ? entry.timestamp : Math.min(firstTs, entry.timestamp);
      lastTs = lastTs === null ? entry.timestamp : Math.max(lastTs, entry.timestamp);
    }
    if (entry.isError) errorCount += 1;
    if (entry.toolName) tools.set(entry.toolName, (tools.get(entry.toolName) ?? 0) + 1);
    for (const file of entry.filesTouched ?? []) {
      const normalized = file.trim();
      if (!normalized || seenFiles.has(normalized)) continue;
      if (filesTouched.length >= filesLimit) {
        filesLimitReached = true;
        continue;
      }
      seenFiles.add(normalized);
      filesTouched.push(normalized);
    }

    if (!vocabularyLimitReached) {
      for (const term of tokenizeLexical(entry.text)) {
        if (vocabulary.has(term)) continue;
        const termBytes = Buffer.byteLength(JSON.stringify(term), "utf8")
          + (vocabulary.size === 0 ? 0 : 1);
        if (estimatedVocabularyBytes + termBytes > maxVocabularyBytes) {
          vocabularyLimitReached = true;
          break;
        }
        vocabulary.add(term);
        estimatedVocabularyBytes += termBytes;
      }
    }
  }

  const sortedVocabulary = [...vocabulary].sort(compareLexical);
  const toolHistogram = Object.fromEntries(
    [...tools.entries()].sort(([left], [right]) => compareLexical(left, right)),
  );
  const addresses: DigestEntryAddress[] = input.entries.map((entry) => [
    entry.index,
    entry.entryId,
    entry.operationAddress ?? null,
    entry.role,
    entry.toolName,
    entry.timestamp,
    entry.ref ?? null,
    entry.provider ?? null,
    entry.action ?? null,
    entry.outcome ?? null,
  ]);
  const reasons = new Set(input.normalizationCoverage?.reasons ?? []);
  if (filesLimitReached) reasons.add("max_files_touched");
  if (vocabularyLimitReached) reasons.add("max_cold_vocabulary_bytes");
  const sortedReasons = [...reasons].sort(compareLexical);

  return {
    sessionId: input.sessionId,
    file: input.file,
    cwd: input.cwd,
    firstTs,
    lastTs,
    entryCount: input.entries.length,
    filesTouched,
    toolHistogram,
    errorCount,
    vocabulary: sortedVocabulary,
    addresses,
    indexCoverage: {
      complete: coverageComplete(input.normalizationCoverage?.complete ?? true, sortedReasons.length > 0),
      vocabularyBytes: vocabularyJsonBytes(sortedVocabulary),
      reasons: sortedReasons,
    },
  };
};
