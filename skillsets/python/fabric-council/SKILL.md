---
name: fabric-council
description: Runs a bounded multi-perspective Pi Fabric council with independent reviewers and best-effort synthesis. Use for architecture choices, plans, reviews, and adversarial cross-checking.
disable-model-invocation: true
---

# Fabric Council — Python

Use one Python `fabric_exec`. Pass `payloads.task`, a JSON array in `payloads.roles`, and a synthesis model key in `payloads.synthesis`; an empty `payloads.synthesis` keeps the session default. Choose 3–8 distinct non-empty roles with useful disagreements, not redundant reviewers. A role is a string or an object with `role` and optional `model` and `thinking`; a role without `model` runs on the session default. Label the outer `display` and every child.

```python
import asyncio
import json
from datetime import datetime, timezone

async def ask(task, name, options=None):
    request = {"task": task, "name": name, "tools": ["read", "grep", "find", "ls"]}
    if options:
        request.update(options)
    result = await agents.run(request)
    if result["status"] != "completed":
        raise RuntimeError(result.get("error") or result["status"])
    return result["value"] if result.get("value") is not None else result["text"]

def text(value):
    return value.strip() if isinstance(value, str) else ""

def canonical(keys, needle, owner):
    key = keys.get(needle.lower())
    if key is not None:
        return key
    model_id = needle.lower().split("/")[-1]
    near = [candidate for candidate in keys.values() if candidate.lower().endswith("/" + model_id)]
    hint = " Did you mean: " + ", ".join(near[:8]) + "?" if near else ""
    raise ValueError("Council: model " + needle + " for " + owner + " is not in the model registry." + hint)

specs = json.loads(π.roles)
if not isinstance(specs, list):
    raise ValueError("Council roles must be a JSON array.")
seats = []
for spec in specs:
    entry = {"role": spec} if isinstance(spec, str) else spec
    if not isinstance(entry, dict):
        raise ValueError("Each council role must be a string or an object with role and optional model and thinking.")
    role = text(entry.get("role"))
    if not role:
        if isinstance(spec, str):
            continue
        raise ValueError("A council role object needs a non-empty role.")
    if [value for value in [entry.get("model"), entry.get("thinking")] if value is not None and not isinstance(value, str)]:
        raise ValueError("Council role " + role + " has a non-string model or thinking.")
    if text(entry.get("thinking")) and text(entry.get("thinking")) not in ["off", "minimal", "low", "medium", "high", "xhigh", "max"]:
        raise ValueError("Council role " + role + " has unknown thinking " + text(entry.get("thinking")) + ".")
    seat = {"role": role}
    if text(entry.get("model")):
        seat["model"] = text(entry.get("model"))
    if text(entry.get("thinking")):
        seat["thinking"] = text(entry.get("thinking"))
    earlier = [other for other in seats if other["role"] == role]
    if not earlier:
        seats.append(seat)
    elif earlier[0].get("model") != seat.get("model") or earlier[0].get("thinking") != seat.get("thinking"):
        raise ValueError("Council role " + role + " appears twice with different settings.")
if len(seats) < 3 or len(seats) > 8:
    raise ValueError("Council requires 3–8 distinct non-empty roles.")
synthesis_model = text(π.synthesis)
if synthesis_model or [seat for seat in seats if seat.get("model")]:
    # Match registry keys exactly before any agent runs, so a typo spends nothing.
    keys = {}
    for entry in await tools.models():
        keys[entry["key"].lower()] = entry["key"]
    for seat in seats:
        if seat.get("model"):
            seat["model"] = canonical(keys, seat["model"], "role " + seat["role"])
    if synthesis_model:
        synthesis_model = canonical(keys, synthesis_model, "synthesis")

async def review(seat):
    options = {}
    outcome = {"role": seat["role"]}
    if seat.get("model"):
        options["model"] = seat["model"]
        outcome["model"] = seat["model"]
    if seat.get("thinking"):
        options["thinking"] = seat["thinking"]
    try:
        report = await ask("Act as the " + seat["role"] + " council member. Independently analyze:\n" + π.task, seat["role"], options)
        outcome.update({"status": "completed", "report": report})
    except Exception as error:
        outcome.update({"status": "failed", "error": str(error)})
    return outcome

outcomes = await asyncio.gather(*[review(seat) for seat in seats])
completed = [item for item in outcomes if item["status"] == "completed"]
failures = [item for item in outcomes if item["status"] == "failed"]
coverage = {"requested": len(seats), "completed": len(completed)}
# Name the model each seat and the synthesis requested; an unpinned seat ran on the session default.
summary = {"coverage": coverage, "seats": [dict(seats[index], status=outcomes[index]["status"]) for index in range(len(seats))]}
if synthesis_model:
    summary["synthesisModel"] = synthesis_model
if not completed:
    return dict(summary, status="failed", failures=failures, result=None)
# Park completed reports in mesh before synthesis: an audit trail that survives this
# program, and full-text recovery when synthesis fails or a budget runs out.
reports_key = "council/" + datetime.now(timezone.utc).strftime("%Y-%m-%d-%H-%M-%S") + "/reports"
try:
    await mesh.put({
        "key": reports_key,
        "value": [
            {"role": item.get("role"), **({"model": item["model"]} if item.get("model") else {}), "report": item["report"]}
            for item in completed
        ],
    })
    reports = reports_key
except Exception as error:
    reports = {"error": str(error)}
if len(completed) == 1:
    return dict(summary, status="partial", failures=failures, result=completed[0]["report"], reports=reports, synthesisSkipped="Only one role completed; another agent adds no diversity.")
try:
    result = await ask("Synthesize only the completed reports into one decision. Reject unsupported claims, preserve material disagreements, and attribute concerns to roles. Never infer views of failed roles.\nTask:\n" + π.task + "\nReports:\n" + json.dumps(completed), "council synthesis", {"model": synthesis_model} if synthesis_model else None)
    return dict(summary, status="partial" if failures else "success", failures=failures, result=result, reports=reports)
except Exception as error:
    return dict(summary, status="partial", failures=failures, result=None, synthesisError=str(error), reports=reports, fallback=[{"role": item.get("role"), "status": "completed", "report": item["report"][:1200]} for item in completed])
```

Reserve at least the role count plus one agent call. Concurrency remains host-limited; usage settles afterward, not as a hard token reservation. Model keys must match a Pi registry key from `tools.models()` exactly, ignoring case; the program refuses a `models.aliases` name or a partial id, and checks every key before any agent runs. Whenever at least one seat completes, full role reports are parked to mesh under a `council/<timestamp>/reports` key carried by every outcome as `reports`: `mesh.get` it for audit or to retry a budget-starved synthesis with one plain agent, and `mesh.delete` it when no longer needed; on synthesis failure the fallback carries report heads plus that mesh key, so full texts never need to land in context. Every result lists `seats` with each role's pinned model, thinking, and status, plus `synthesisModel` when one was pinned. These are the models the program requested; keeping a run on its pinned model is the host's job. Successful synthesis returns only the compact decision, coverage, seats, and failures; raw reports return only on synthesis failure. A partial result is useful evidence with named gaps, not permission for an automatic whole-council rerun. Retry only the failed role or synthesis when needed. Do not use a council for a lookup.
