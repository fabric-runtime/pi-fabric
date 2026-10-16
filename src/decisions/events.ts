import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  FabricDecisionQuestionV1,
  FabricDecisionRequestV1,
  FabricDecisionResultV1,
  FabricDecisionsCapabilityRequestV1,
} from "../protocol.js";
import { raiseAndWait } from "./host.js";
import {
  MAX_DECISION_BODY_CHARS,
  MAX_DECISION_DEADLINE_MS,
  MAX_DECISION_OPTIONS,
  MAX_DECISION_TEXT_CHARS,
  MAX_DECISION_TITLE_CHARS,
  MIN_DECISION_TIMEOUT_MS,
  type DecisionRaiseInput,
  type DecisionRecord,
  type DecisionStore,
} from "./store.js";

// The `pi.events` decisions channel lets another extension (for example a
// question tool with no screen) hand a question to a person through the
// project's durable decisions. The caller chooses only the question; Fabric
// fixes who holds it ("user"), what expiry does ("cancel"), and the kind
// ("question"), so a caller cannot route it to a program, escalate it, or
// attach a default answer that settles without a person.

export type FabricDecisionsTarget = { store: DecisionStore } | { reason: string };
export type ResolveFabricDecisions = (context: ExtensionContext) => Promise<FabricDecisionsTarget>;

// A source names the asking extension. It cannot contain ":", so the stored
// "extension:<source>" participant id never equals a real participant id.
const SOURCE_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@._/-]{0,63}$/;

const raisedByFromSource = (source: string | undefined): Partial<DecisionRecord["raisedBy"]> => {
  if (source === undefined) return {};
  if (!SOURCE_PATTERN.test(source)) throw new Error("Decision source must match [A-Za-z0-9@][A-Za-z0-9@._/-]{0,63}");
  return { participantId: `extension:${source}` };
};

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

const optionField = (option: unknown, field: "id" | "label"): unknown =>
  typeof option === "object" && option !== null ? (option as Record<string, unknown>)[field] : undefined;

/** Copy only the named question fields; the store validates their values. */
const decisionInputFromQuestion = (question: FabricDecisionQuestionV1): DecisionRaiseInput => {
  const source = question as unknown as Record<string, unknown>;
  const options = source.options;
  return {
    kind: "question",
    title: source.title,
    ...(source.body !== undefined ? { body: source.body } : {}),
    ...(source.input !== undefined ? { input: source.input } : {}),
    ...(options !== undefined
      ? {
          options: Array.isArray(options)
            ? options.map((option: unknown) => ({ id: optionField(option, "id"), label: optionField(option, "label") }))
            : options,
        }
      : {}),
    ...(source.timeoutMs !== undefined ? { timeoutMs: source.timeoutMs } : {}),
    holder: "user",
    onExpire: "cancel",
  };
};

/** Only an answered record carries an answer; nothing else becomes one. */
const decisionResult = (record: DecisionRecord): FabricDecisionResultV1 => {
  if (record.status === "answered" && record.answer) {
    const { optionId, text, answeredBy, via, at } = record.answer;
    return {
      ok: true,
      id: record.id,
      status: "answered",
      answer: {
        ...(optionId !== undefined ? { optionId } : {}),
        ...(text !== undefined ? { text } : {}),
        answeredBy,
        via,
        at,
      },
    };
  }
  if (record.status === "cancelled" || record.status === "expired") {
    return { ok: true, id: record.id, status: record.status };
  }
  return { ok: false, id: record.id, error: `Decision ${record.id} is still ${record.status}` };
};

const once = <T>(respond: (result: T) => void): ((result: T) => void) => {
  let sent = false;
  return (result) => {
    if (sent) return;
    sent = true;
    respond(result);
  };
};

export const answerFabricDecisionsCapability = async (
  request: FabricDecisionsCapabilityRequestV1,
  resolve: ResolveFabricDecisions,
): Promise<void> => {
  const respond = once(request.respond);
  try {
    const target = await resolve(request.context);
    if ("reason" in target) {
      respond({ ok: true, available: false, reason: target.reason });
      return;
    }
    respond({
      ok: true,
      available: true,
      inputs: ["text", "confirm", "select", "editor"],
      maxOptions: MAX_DECISION_OPTIONS,
      maxTitleChars: MAX_DECISION_TITLE_CHARS,
      maxBodyChars: MAX_DECISION_BODY_CHARS,
      maxTextChars: MAX_DECISION_TEXT_CHARS,
      minTimeoutMs: MIN_DECISION_TIMEOUT_MS,
      maxTimeoutMs: MAX_DECISION_DEADLINE_MS,
    });
  } catch (error) {
    respond({ ok: false, error: message(error) });
  }
};

export const answerFabricDecisionRequest = async (
  request: FabricDecisionRequestV1,
  resolve: ResolveFabricDecisions,
  lifetime?: AbortSignal,
): Promise<void> => {
  const respond = once(request.respond);
  // The session's lifetime ends a wait as the caller's own signal does.
  const signal = lifetime && request.signal ? AbortSignal.any([request.signal, lifetime]) : lifetime ?? request.signal;
  let raised: string | undefined;
  try {
    signal?.throwIfAborted();
    const raisedBy = raisedByFromSource(request.source);
    const target = await resolve(request.context);
    if ("reason" in target) {
      respond({ ok: false, error: target.reason });
      return;
    }
    const record = await raiseAndWait(
      target.store,
      decisionInputFromQuestion(request.question),
      raisedBy,
      signal,
      (id) => {
        raised = id;
        try {
          request.onRaised?.(id);
        } catch {
          // A failing observer must not strand the decision.
        }
      },
    );
    respond(decisionResult(record));
  } catch (error) {
    respond({
      ok: false,
      error: request.signal?.aborted
        ? "Decision request aborted"
        : lifetime?.aborted
          ? "Decision request aborted: the session shut down"
          : message(error),
      ...(raised ? { id: raised } : {}),
    });
  }
};
