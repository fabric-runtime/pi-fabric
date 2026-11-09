import type { FabricLifecycleEventType } from "../lifecycle/types.js";

interface Publisher {
  publishHostLifecycle(event: FabricLifecycleEventType, payload: unknown): Promise<void>;
}

/** Abort must not wait for the mesh lock. The broker still owns and orders the
 * publication; shutdown drains it. Completed boundaries keep their ordering. */
export async function settleLifecyclePublication(
  publisher: Publisher,
  event: FabricLifecycleEventType,
  payload: unknown,
  interrupted: boolean,
): Promise<void> {
  const publication = publisher.publishHostLifecycle(event, payload);
  if (!interrupted) { await publication; return; }
  void publication.catch(error => {
    console.warn(`[pi-fabric] ${event} publication after abort failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
