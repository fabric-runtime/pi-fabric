import { loadTieredIndex } from "./index.js";
import { SESSIONS_MAX } from "./request-limits.js";
import {
  parseBranches,
  resolveRefs,
  resolveIndexOptions,
  liveBranchResolver,
  resolveTierRefs,
  type MemoryProviderContext,
} from "./request-context.js";
import {
  listHostSnapshots,
  loadHostTieredIndex,
  memorySourceFailure,
  resolveRegisteredSource,
} from "./host-source.js";

export async function processMemorySessions(
  args: Record<string, unknown>,
  context: MemoryProviderContext,
  signal?: AbortSignal,
): Promise<unknown> {
  const sourceId = typeof args.source === "string" && args.source.length > 0
    ? args.source
    : undefined;
  const scope = typeof args.scope === "string" ? args.scope : undefined;
  const branches = parseBranches(args.branches, "memory.sessions");
  const limit =
    typeof args.limit === "number" && Number.isSafeInteger(args.limit) && args.limit >= 1
      ? Math.min(args.limit, SESSIONS_MAX)
      : SESSIONS_MAX;

  if (sourceId !== undefined) {
    try {
      const source = resolveRegisteredSource(context.sources, sourceId);
      const { snapshots, coverageReasons } = await listHostSnapshots(source, limit, "list", signal, context.fabricScope);
      const options = resolveIndexOptions(context.config, context.agentDir, branches);
      const index = loadHostTieredIndex(snapshots, options, false, undefined, coverageReasons);
      const shards = new Map(index.shards.map((shard) => [shard.sessionFile, shard]));
      const digests = new Map(index.digests.map((digest) => [digest.file, digest]));
      const sessions = snapshots.map((snapshot) => {
        const tier = index.tiers.get(snapshot.displayKey) ?? "cold";
        const shard = shards.get(snapshot.displayKey);
        const digest = digests.get(snapshot.displayKey);
        return {
          id: shard?.sessionId ?? digest?.sessionId ?? snapshot.sessionId,
          file: snapshot.displayKey,
          cwd: digest?.cwd ?? snapshot.metadata.cwd ?? "",
          mtime: snapshot.metadata.updatedAt ?? 0,
          entryCount: shard?.entries.length ?? digest?.entryCount ?? 0,
          tier,
          branches,
          lineageFingerprint: shard?.lineageFingerprint ?? digest?.lineageFingerprint ?? null,
        };
      });
      return {
        scope: `source:${sourceId}`,
        branches,
        sessions,
        ...(index.coverage.complete ? {} : { coverage: index.coverage }),
      };
    } catch (error) {
      const failure = memorySourceFailure(error);
      if (!failure) throw error;
      return {
        scope: `source:${sourceId}`,
        branches,
        sessions: [],
        error: failure,
      };
    }
  }

  const refs = resolveRefs(scope, context, true).slice(0, limit);
  const options = resolveIndexOptions(
    context.config,
    context.agentDir,
    branches,
    liveBranchResolver(context),
  );
  const index = loadTieredIndex(refs, resolveTierRefs(refs, context), options);
  const shards = new Map(index.shards.map((shard) => [shard.sessionFile, shard]));
  const digests = new Map(index.digests.map((digest) => [digest.file, digest]));
  const sessions = refs.map((ref) => {
    const tier = index.tiers.get(ref.file) ?? "cold";
    const shard = shards.get(ref.file);
    const digest = digests.get(ref.file);
    return {
      id: shard?.sessionId ?? digest?.sessionId ?? ref.id,
      file: ref.file,
      cwd: digest?.cwd ?? ref.cwd,
      mtime: ref.mtime,
      entryCount: shard?.entries.length ?? digest?.entryCount ?? 0,
      tier,
      branches,
      lineageFingerprint: shard?.lineageFingerprint ?? digest?.lineageFingerprint ?? null,
    };
  });
  return { scope: scope ?? "session", branches, sessions };
}
