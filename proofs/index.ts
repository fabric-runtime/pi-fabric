// The registered kernels. Each module is proved, refused in every broken
// variant, cross-checked against its builders, and compiled to
// `src/verified/generated/<module>.js`.
import { promptGuidanceKernels, PROMPT_GUIDANCE_BUGS } from "./prompt-guidance.js";
import { actorNameKernels, ACTOR_NAME_BUGS } from "./actor-name.js";
import { authorityKernels, AUTHORITY_BUGS } from "./authority.js";
import { compactionKernels, CUT_BUGS } from "./compaction.js";
import { budgetKernels, BUDGET_BUGS } from "./budget.js";
import { grantKernels, GRANT_BUGS } from "./grants.js";
import { speculationKernels, SPECULATION_BUGS } from "./speculation.js";
import type { Kernel } from "./kernel.js";
import { lifecycleKernels, LIFECYCLE_BUGS } from "./lifecycle.js";
import { policyKernels, POLICY_BUGS } from "./policy.js";
import { providerKernels, PROVIDER_BUGS } from "./provider.js";
import { resourceKernels, RESOURCE_BUGS } from "./resources.js";
import { storageKernels, STORAGE_BUGS } from "./storage.js";

export interface KernelModule {
  /** Generated module stem: `src/verified/generated/<stem>.js`. */
  readonly stem: string;
  /** The proof source, hashed into the receipt. */
  readonly source: string;
  readonly kernels: (bug?: string) => Kernel[];
  /** Deliberately broken variants: each must leave at least one claim unproven. */
  readonly bugs: readonly string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const modules: readonly KernelModule[] = [
  { stem: "policy", source: "proofs/policy.ts", kernels: policyKernels as any, bugs: POLICY_BUGS },
  { stem: "compaction", source: "proofs/compaction.ts", kernels: compactionKernels as any, bugs: CUT_BUGS },
  { stem: "resources", source: "proofs/resources.ts", kernels: resourceKernels as any, bugs: RESOURCE_BUGS },
  { stem: "lifecycle", source: "proofs/lifecycle.ts", kernels: lifecycleKernels as any, bugs: LIFECYCLE_BUGS },
  { stem: "storage", source: "proofs/storage.ts", kernels: storageKernels as any, bugs: STORAGE_BUGS },
  { stem: "provider", source: "proofs/provider.ts", kernels: providerKernels as any, bugs: PROVIDER_BUGS },
  { stem: "authority", source: "proofs/authority.ts", kernels: authorityKernels as any, bugs: AUTHORITY_BUGS },
  { stem: "grants", source: "proofs/grants.ts", kernels: grantKernels as any, bugs: GRANT_BUGS },
  { stem: "speculation", source: "proofs/speculation.ts", kernels: speculationKernels as any, bugs: SPECULATION_BUGS },
  { stem: "actor-name", source: "proofs/actor-name.ts", kernels: actorNameKernels as any, bugs: ACTOR_NAME_BUGS },
  { stem: "budget", source: "proofs/budget.ts", kernels: budgetKernels as any, bugs: BUDGET_BUGS },
  { stem: "prompt-guidance", source: "proofs/prompt-guidance.ts", kernels: promptGuidanceKernels as any, bugs: PROMPT_GUIDANCE_BUGS },
];
