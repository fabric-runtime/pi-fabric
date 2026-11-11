// Severed seam of the pi-fabric extraction: the memory module imports only
// trace *types* from ../audit/trace.js. The recording machinery stays
// fork-side; the persisted-shape schema (validators included) is carried
// verbatim in ./trace-schema.ts because compaction/trace-events.ts reads it.
export type {
  FabricTraceJsonPrimitive,
  FabricTraceJsonValue,
  FabricExecutionOutcomeV1,
  FabricExecutionFailureStageV1,
  FabricExecutionTraceOperationV1,
  FabricExecutionTraceCountsV1,
  FabricExecutionTraceV1,
} from "./trace-schema.js";
export {
  FABRIC_EXECUTION_TRACE_KIND,
  FABRIC_EXECUTION_TRACE_VERSION,
  isFabricExecutionTraceV1,
  readFabricExecutionTraceV1,
} from "./trace-schema.js";
