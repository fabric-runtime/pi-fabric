import type { FabricActionDescriptor, FabricInvocationContext } from "../protocol.js";
import { validationMessage } from "./action-arguments.js";
import type { AttachedMonitors, MonitorEvent, MonitorTarget } from "./attached-monitors.js";
import { parseShellMonitor, shellMonitorSchema } from "./shell-monitor.js";

export type ObservationSource = () => AttachedMonitors | undefined;

/** Shared semantics, separate discovery on the kind of work being observed. */
export function observationAction(kind: MonitorTarget["kind"]): FabricActionDescriptor {
  const { match, ...common } = shellMonitorSchema.properties;
  return {
    name: "observe",
    description: `Observe an existing local ${kind === "task" ? "task's new output" : "agent run or provider participant's operational progress"} without restarting it or polling. Delivery ui is human inspection only; wake emits bounded events to the owning agent. Terminal outcomes always bypass filters. Quiet is not failure. Returns an observation task handle: use tasks.get/watch/stop with its id. Stopping or expiring observation never stops the target. One wake observer per target; at most 8 active observations including shell monitors.`,
    inputSchema: { type: "object", additionalProperties: false, required: ["id", "delivery"], properties: {
      ...common,
      ...(kind === "task" ? { match } : {}),
      id: { type: "string", minLength: 1, description: "Exact local task or agent run ID; provider participant refs are accepted by agents.observe." },
      events: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: kind === "task" ? ["output", "quiet", "terminal"] : ["progress", "blocked", "quiet", "terminal"] } },
      quietAfterMs: { type: "integer", minimum: 1000, maximum: 1800000 },
      description: { type: "string", minLength: 1, maxLength: 120 },
    } },
    risk: "read", effect: { kind: "emission", ordering: "ordered" },
  };
}

export async function observeExisting(engine: AttachedMonitors | undefined, kind: MonitorTarget["kind"], args: Record<string, unknown>, context: FabricInvocationContext) {
  const invalid = validationMessage(observationAction(kind).inputSchema, args);
  if (invalid) throw new Error(`Invalid ${kind === "task" ? "tasks" : "agents"}.observe arguments: ${invalid}`);
  if (!engine) throw new Error("Observation is unavailable in this host");
  const { id, events, quietAfterMs, description, ...settings } = args;
  const selected = events as MonitorEvent[] | undefined;
  if (selected?.includes("quiet") && quietAfterMs === undefined) throw new Error("quiet events require quietAfterMs");
  if (quietAfterMs !== undefined && !selected?.includes("quiet")) throw new Error("quietAfterMs requires events to include quiet");
  return { task: await engine.start({
    ...parseShellMonitor(settings)!, target: { kind, id: id as string },
    events: selected ?? (kind === "task" ? ["output", "terminal"] : ["progress", "blocked", "terminal"]),
    ...(typeof quietAfterMs === "number" ? { quietAfterMs } : {}),
    ...(typeof description === "string" ? { description } : {}),
  }, context.extensionContext?.sessionManager?.getSessionId?.(), context.signal) };
}
