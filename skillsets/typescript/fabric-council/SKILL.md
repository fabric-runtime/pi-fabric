---
name: fabric-council
description: Runs a bounded multi-perspective Pi Fabric council with independent reviewers and best-effort synthesis. Use for architecture choices, plans, reviews, and adversarial cross-checking.
disable-model-invocation: true
---

# Fabric Council

Use one `fabric_exec` call with bounded role fan-out. Choose three to eight roles that disagree usefully rather than duplicating one another, such as correctness, security, operability, maintainability, and requirements skepticism. Pin a model to a role when you want vendor diversity as well as role diversity.

```ts
type CouncilSeat = { role: string; model?: string; thinking?: FabricThinking };
type CouncilOutcome =
  | { role: string; model?: string; status: "completed"; report: string }
  | { role: string; model?: string; status: "failed"; error: string };

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const specs: unknown = JSON.parse(π.roles);
if (!Array.isArray(specs)) throw new Error("Council roles must be a JSON array.");
const seats: CouncilSeat[] = [];
for (const spec of specs) {
  const entry = (typeof spec === "string" ? { role: spec } : spec) as Record<string, unknown> | null;
  if (!entry || typeof entry !== "object") {
    throw new Error("Each council role must be a string or a { role, model?, thinking? } object.");
  }
  const role = text(entry.role);
  if (!role) {
    if (typeof spec === "string") continue;
    throw new Error("A council role object needs a non-empty role.");
  }
  if ([entry.model, entry.thinking].some((value) => value != null && typeof value !== "string")) {
    throw new Error(`Council role "${role}" has a non-string model or thinking.`);
  }
  const thinking = text(entry.thinking);
  if (thinking && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) {
    throw new Error(`Council role "${role}" has unknown thinking "${thinking}".`);
  }
  const seat: CouncilSeat = { role };
  if (text(entry.model)) seat.model = text(entry.model);
  if (text(entry.thinking)) seat.thinking = text(entry.thinking) as FabricThinking;
  const earlier = seats.find((other) => other.role === role);
  if (!earlier) seats.push(seat);
  else if (earlier.model !== seat.model || earlier.thinking !== seat.thinking) {
    throw new Error(`Council role "${role}" appears twice with different settings.`);
  }
}
if (seats.length < 3 || seats.length > 8) {
  throw new Error("Council requires 3–8 distinct non-empty roles.");
}
let synthesisModel = text(π.synthesis) || undefined;
if (synthesisModel || seats.some((seat) => seat.model)) {
  // Match registry keys exactly before any agent runs, so a typo spends nothing.
  const keys = new Map((await tools.models()).map((entry) => [entry.key.toLowerCase(), entry.key]));
  const canonical = (needle: string, owner: string): string => {
    const key = keys.get(needle.toLowerCase());
    if (key) return key;
    const id = needle.toLowerCase().split("/").pop();
    const near = [...keys.values()].filter((candidate) => candidate.toLowerCase().endsWith(`/${id}`));
    throw new Error(
      `Council: model "${needle}" for ${owner} is not in the model registry.` +
        (near.length ? ` Did you mean: ${near.slice(0, 8).join(", ")}?` : ""),
    );
  };
  for (const seat of seats) if (seat.model) seat.model = canonical(seat.model, `role "${seat.role}"`);
  if (synthesisModel) synthesisModel = canonical(synthesisModel, "synthesis");
}
await workflow.configure({
  name: "Council review",
  description: `${seats.length} independent perspectives with best-effort synthesis`,
});
await phase("Deliberate", { total: seats.length + 1 });
const outcomes = await parallel(
  seats.map((seat) => async (): Promise<CouncilOutcome> => {
    const pin = seat.model ? { model: seat.model } : {};
    try {
      const report = await agent(
        `Act as the ${seat.role} council member. Independently analyze this task:\n\n${π.task}`,
        {
          label: seat.role,
          tools: ["read", "grep", "find", "ls"],
          ...pin,
          ...(seat.thinking ? { thinking: seat.thinking } : {}),
        },
      );
      return { role: seat.role, ...pin, status: "completed", report };
    } catch (error) {
      return {
        role: seat.role,
        ...pin,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }),
  { concurrency: seats.length },
);
const completed = outcomes.filter(
  (outcome): outcome is Extract<CouncilOutcome, { status: "completed" }> =>
    outcome.status === "completed",
);
const failures = outcomes.filter(
  (outcome): outcome is Extract<CouncilOutcome, { status: "failed" }> =>
    outcome.status === "failed",
);
const coverage = { requested: seats.length, completed: completed.length };
// Name the model each seat and the synthesis requested; an unpinned seat ran on the session default.
const pins = {
  seats: seats.map((seat, index) => ({ ...seat, status: outcomes[index].status })),
  ...(synthesisModel ? { synthesisModel } : {}),
};
if (completed.length === 0) {
  return { status: "failed", coverage, ...pins, failures, result: null };
}
// Park completed reports in mesh before synthesis: an audit trail that survives this
// program, and full-text recovery when synthesis fails or a budget runs out.
// The run suffix keeps same-second councils from overwriting each other: mesh.put is create-or-update.
const reportsKey = `council/${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${Math.random().toString(36).slice(2, 8)}/reports`;
let reports: string | { error: string } = reportsKey;
try {
  await mesh.put({
    key: reportsKey,
    value: completed.map((outcome) => ({
      role: outcome.role,
      ...(outcome.model ? { model: outcome.model } : {}),
      report: outcome.report,
    })),
  });
} catch (error) {
  reports = { error: error instanceof Error ? error.message : String(error) };
}
if (completed.length === 1) {
  return {
    status: "partial",
    coverage,
    ...pins,
    failures,
    result: completed[0].report,
    reports,
    synthesisSkipped: "Only one role completed; another agent would add no diversity.",
  };
}

try {
  const result = await agent(
    `Synthesize these completed reports into one decision. Reject unsupported claims, preserve material disagreements, attribute each concern to its role. Do not infer the views of failed roles.\n\nTask:\n${π.task}\n\nReports:\n${JSON.stringify(completed)}`,
    {
      label: "council synthesis",
      tools: ["read", "grep", "find", "ls"],
      ...(synthesisModel ? { model: synthesisModel } : {}),
    },
  );
  return {
    status: failures.length === 0 ? "success" : "partial",
    coverage,
    ...pins,
    failures,
    result,
    reports,
  };
} catch (error) {
  return {
    status: "partial",
    coverage,
    ...pins,
    failures,
    result: null,
    synthesisError: error instanceof Error ? error.message : String(error),
    reports,
    fallback: completed.map((outcome) => ({
      role: outcome.role,
      status: "completed",
      report: typeof reports === "string" ? outcome.report.slice(0, 1200) : outcome.report,
    })),
  };
}
```

Pass the task as `strings.task`, the JSON role array as `strings.roles`, and the synthesis model key as `strings.synthesis`; an empty `strings.synthesis` keeps the session default. A role is a string or `{ "role": "security", "model": "provider/id", "thinking": "high" }`, and a role without `model` runs on the session default. Model keys must match a Pi registry key from `tools.models()` exactly, ignoring case; the skill refuses a `models.aliases` name or a partial id, and checks every key before any agent runs. Every result lists `seats`, each with its role, pinned model and thinking, and status, plus `synthesisModel` when one was pinned. These are the models the skill requested; keeping a run on its pinned model is the host's job. Successful synthesis returns only the compact decision, coverage, seats, and failures. Whenever at least one seat completes, the full role reports are parked to mesh under a `council/<timestamp>-<run>/reports` key and every outcome carries it as `reports`: check `typeof reports === "string"` first, because a failed `mesh.put` yields an `{ error }` object instead of a key — never pass that to `mesh.get` or `mesh.delete`, and the synthesis-failure fallback then carries the full untruncated reports. Otherwise `mesh.get` the key for audit or to retry a budget-starved synthesis with one plain agent, and `mesh.delete` it when no longer needed. On synthesis failure the fallback carries report heads plus that mesh key, so full texts never need to land in context; one surviving role returns directly without spending another agent call.

Concurrent calls can overshoot an observational `tokenBudget` because usage settles afterward. Reserve at least `seats.length + 1` top-level agent calls when synthesis may run, and use a finite role set rather than relying on token accounting as a hard concurrent ceiling. A budget-exhausted synthesis loses nothing: the parked reports are complete, so re-run only the synthesis step.

Status is `success`, `partial`, or `failed`. A partial result is usable evidence with named gaps and must not trigger an automatic whole-council rerun. If a missing perspective matters, retry that role with one plain agent using the original task and role; do not invoke a new council or rerun successful roles. Do not use a council for a lookup or a decision with no meaningful competing considerations.
