// `pi-recall sessions` — list known sessions in scope. The service layer is
// the fork's processMemorySessions verbatim; this is only the text rendering
// in the same style as the recall/expand tiers.
import type { MemoryProviderContext } from "../memory/request-context.js";
import { processMemorySessions } from "../memory/sessions-service.js";
import { normalizeMemoryArgs } from "../providers/memory-provider.js";

interface SessionsView {
  scope?: string;
  branches?: string;
  sessions?: Array<{
    id?: string;
    file?: string;
    cwd?: string;
    mtime?: number;
    entryCount?: number;
    tier?: string;
    lineageFingerprint?: string | null;
  }>;
  error?: { code?: string; message?: string };
}

const isoTimestamp = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z")
    : "-";

export const renderSessions = (response: unknown): { ok: boolean; lines: string[] } => {
  const view = (typeof response === "object" && response !== null ? response : {}) as SessionsView;
  if (view.error) {
    const code = typeof view.error.code === "string" ? view.error.code : "error";
    const message = typeof view.error.message === "string" ? view.error.message : "";
    return { ok: false, lines: [`sessions failed (${code}): ${message}`] };
  }
  const sessions = view.sessions ?? [];
  const lines = [
    `scope=${view.scope ?? "-"} branches=${view.branches ?? "-"} count=${sessions.length}`,
  ];
  sessions.forEach((session, position) => {
    const parts = [
      `sid=${session.id ?? "-"}`,
      `ts=${isoTimestamp(session.mtime)}`,
      `tier=${session.tier ?? "cold"}`,
      `entries=${session.entryCount ?? 0}`,
    ];
    if (typeof session.cwd === "string" && session.cwd !== "") parts.push(`cwd=${session.cwd}`);
    if (typeof session.file === "string") parts.push(`file=${session.file}`);
    lines.push(`[${position + 1}] ${parts.join(" ")}`);
  });
  return { ok: true, lines };
};

export const runSessions = async (
  rawArgs: Record<string, unknown>,
  context: MemoryProviderContext,
  signal?: AbortSignal,
): Promise<{ ok: boolean; lines: string[] }> => {
  const args = normalizeMemoryArgs("sessions", rawArgs);
  const response = await processMemorySessions(args, context, signal);
  return renderSessions(response);
};
