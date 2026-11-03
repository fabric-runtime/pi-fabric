// System prompt builders for before_agent_start; the extension loads them at
// the first agent start, not while registering.
export { fabricGuidanceDelivery, relocateFabricGuidelines, stripFabricRuleBullets } from "./guidance-delivery.js";
export { coreOverridePromptGuidance } from "./core-override-guidance.js";
export { buildSkillReferenceGuidance } from "./skill-references.js";
export { managedHostExecutionGuidance, managedHostKernelGuidance } from "./managed-host-guidance.js";
export {
  defaultFabricExecutionGuidance,
  extensionToolRosterGuidance,
  fabricExecutionKernelGuidance,
  fabricSchemaGuidance,
} from "./system-guidance.js";
