import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentChildQuestionRequest, AgentChildQuestionResponse } from "../agents/types.js";
import type { ResolvedFabricAction } from "../core/action-registry.js";
import {
  MAX_DECISION_BODY_CHARS,
  MAX_DECISION_OPTIONS,
  MAX_DECISION_TITLE_CHARS,
  type DecisionRaiseInput,
  type DecisionRecord,
  type DecisionStore,
} from "./store.js";

// Host-side consumers of the decision store: headless approvals
// (approvals.headless "decision") and routed child dialogs
// (agents.childQuestions "route").

export const DEFAULT_HEADLESS_APPROVAL_TIMEOUT_MS = 300_000;
const DEFAULT_CHILD_QUESTION_TIMEOUT_MS = 600_000;
const CANCELLED: AgentChildQuestionResponse = { cancelled: true };

const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/** Raise a decision and wait for it; an aborted wait cancels the decision. */
export const raiseAndWait = async (
  store: DecisionStore,
  input: DecisionRaiseInput,
  raisedBy: Partial<DecisionRecord["raisedBy"]>,
  signal: AbortSignal | undefined,
  onRaised?: (id: string) => void,
): Promise<DecisionRecord> => {
  const record = await store.raise(input, raisedBy);
  onRaised?.(record.id);
  try {
    return await store.wait(record.id, signal ? { signal } : {});
  } catch (error) {
    await store.cancel(record.id, { answeredBy: store.identity.id, via: "abort" }).catch(() => undefined);
    throw error;
  }
};

/**
 * No-UI approval: a user-held "approval" decision with approve/deny options.
 * Only an explicit approve answer allows the call; deny, cancel, and expiry deny.
 */
export const requestHeadlessApproval = async (
  store: DecisionStore,
  action: Pick<ResolvedFabricAction, "ref" | "risk" | "description">,
  options: { reason?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> => {
  const settled = await raiseAndWait(store, {
    kind: "approval",
    title: clip(`${action.ref} requests ${action.risk} access`, MAX_DECISION_TITLE_CHARS),
    body: clip([action.description, options.reason].filter(Boolean).join("\n\n"), MAX_DECISION_BODY_CHARS),
    options: [
      { id: "approve", label: "Approve once" },
      { id: "deny", label: "Deny" },
    ],
    holder: "user",
    timeoutMs: options.timeoutMs ?? DEFAULT_HEADLESS_APPROVAL_TIMEOUT_MS,
    onExpire: "cancel",
  }, {}, options.signal);
  return settled.status === "answered" && settled.answer?.optionId === "approve";
};

interface ChildQuestion {
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout: number;
}

const parseChildQuestion = (value: Record<string, unknown>): ChildQuestion | undefined => {
  const method = value.method;
  if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return undefined;
  const options = Array.isArray(value.options)
    ? value.options.filter((option): option is string => typeof option === "string")
    : undefined;
  if (method === "select" && !options?.length) return undefined;
  const string = (field: unknown): string | undefined => typeof field === "string" ? field : undefined;
  const message = string(value.message);
  const placeholder = string(value.placeholder);
  const prefill = string(value.prefill);
  return {
    method,
    title: string(value.title) ?? "",
    ...(message !== undefined ? { message } : {}),
    ...(options && method === "select" ? { options } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(prefill !== undefined ? { prefill } : {}),
    timeout: typeof value.timeout === "number" && Number.isFinite(value.timeout) && value.timeout >= 1_000
      ? Math.floor(value.timeout)
      : DEFAULT_CHILD_QUESTION_TIMEOUT_MS,
  };
};

const askViaUi = async (
  ui: ExtensionContext["ui"],
  label: string,
  question: ChildQuestion,
  signal: AbortSignal,
): Promise<AgentChildQuestionResponse> => {
  const dialog = { signal, timeout: question.timeout };
  if (question.method === "select") {
    const value = await ui.select(label, question.options!, dialog);
    return value !== undefined && question.options!.includes(value) ? { value } : CANCELLED;
  }
  if (question.method === "confirm") {
    return { confirmed: await ui.confirm(label, question.message ?? "", dialog) };
  }
  if (question.method === "input") {
    const value = await ui.input(label, question.placeholder, dialog);
    return value === undefined ? CANCELLED : { value };
  }
  // ui.editor takes no dialog options: race it against the deadline and abort.
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), question.timeout);
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const value = await Promise.race([ui.editor(label, question.prefill), stop]);
    return value === undefined ? CANCELLED : { value };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
};

const responseFromDecision = (
  question: ChildQuestion,
  decision: DecisionRecord,
): AgentChildQuestionResponse => {
  if (decision.status !== "answered" || !decision.answer) return CANCELLED;
  const { optionId, text } = decision.answer;
  if (question.method === "confirm") return { confirmed: optionId === "yes" };
  if (question.method === "select") {
    const index = optionId?.startsWith("o") ? Number(optionId.slice(1)) - 1 : -1;
    const value = question.options?.[index];
    return value === undefined ? CANCELLED : { value };
  }
  return text === undefined ? CANCELLED : { value: text };
};

/**
 * Answer one routed child dialog: through the parent's interactive UI when it
 * has one, otherwise through a root-held decision. Missing UI and store, a
 * malformed request, or any failure cancels the child's dialog.
 */
export const routeChildQuestion = async (
  request: AgentChildQuestionRequest,
  deps: { context: Pick<ExtensionContext, "hasUI" | "ui">; store?: DecisionStore },
): Promise<AgentChildQuestionResponse> => {
  const question = parseChildQuestion(request.question);
  if (!question || request.signal.aborted) return CANCELLED;
  const label = `${request.name}: ${question.title || "question"}`;
  if (deps.context.hasUI) return askViaUi(deps.context.ui, label, question, request.signal);
  if (!deps.store) return CANCELLED;
  const input: DecisionRaiseInput = {
    kind: "question",
    title: clip(label, MAX_DECISION_TITLE_CHARS),
    ...(question.message ? { body: clip(question.message, MAX_DECISION_BODY_CHARS) } : {}),
    ...(question.method === "select"
      ? {
          input: "select",
          options: question.options!.slice(0, MAX_DECISION_OPTIONS).map((option, index) => ({
            id: `o${index + 1}`,
            label: clip(option || `Option ${index + 1}`, MAX_DECISION_TITLE_CHARS),
          })),
        }
      : { input: question.method === "input" ? "text" : question.method }),
    holder: "root",
    timeoutMs: Math.max(1_000, question.timeout),
    onExpire: "cancel",
  };
  const decision = await raiseAndWait(
    deps.store,
    input,
    { participantId: request.actorId ?? request.runId, runId: request.runId },
    request.signal,
    request.onDecision,
  );
  return responseFromDecision(question, decision);
};
