import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FabricOwnedModelGuidance } from "../components/model-guidance.js";
import type { FabricModelAliases, FabricModelCandidate } from "../core/model-resolution.js";
import type { FabricAgentConfig, FabricMeshConfig, FabricRetentionConfig } from "../config.js";
import type { FabricActorInfo, FabricActorRequest } from "../actors/types.js";
import type { AgentHandleInfo, AgentRunRequest, FabricRunOutcome } from "../agents/types.js";
import type { FabricKernel } from "../runtime/kernel.js";
import type { MeshIdentity } from "../mesh/store.js";
import type { OwnerHeartbeatFields } from "../core/atomic-write.js";
import type { FabricScope } from "../protocol.js";
export const sleepUnlessAborted = (ms: number, signal?: AbortSignal): Promise<void> =>
  // Executor form: the configured lib is ES2022, which has no
  // Promise.withResolvers, and an abort listener plus a timer need shared
  // completion control.
  new Promise<void>((resolve, reject) => {
    const aborted = (): Error =>
      signal?.reason instanceof Error ? signal.reason : new Error("Fabric residency request was aborted");
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(aborted());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Remove an abandoned file-exchange request. The resident host renames
 * unstarted requests out of `requests/` before running them, so deleting our
 * file cancels work the host has not picked up yet; a late host response is
 * removed as well. Deleting a request the host already moved is a no-op, and
 * in-flight work still runs to completion. Best effort: never throws.
 */
export const abandonResidentRequest = (
  requestsPath: string,
  responsesPath: string,
  requestId: string,
): void => {
  for (const directory of [requestsPath, responsesPath]) {
    try {
      fs.rmSync(path.join(directory, `${requestId}.json`), { force: true });
    } catch { /* best effort: an abandoned request must not raise a second error */ }
  }
};

export const RESIDENT_HOST_FORMAT = 1 as const;
const RESIDENT_DELIVERY_PREFIX = "residency/deliveries/";

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const residentHostId = (rootId: string): string =>
  `resident:${digest(rootId).slice(0, 24)}`;

export const residentRoot = (meshRoot: string, rootId: string): string =>
  path.join(meshRoot, "residency", digest(rootId));

export const residentDeliveryPrefix = (rootId: string): string =>
  `${RESIDENT_DELIVERY_PREFIX}${digest(rootId).slice(0, 32)}/`;

export interface ResidentPiModelState {
  available: FabricModelCandidate[];
  aliases: FabricModelAliases;
  defaultModel?: string;
}

export interface ResidentHostConfig {
  format: typeof RESIDENT_HOST_FORMAT;
  rootId: string;
  sessionId: string;
  cwd: string;
  projectRoot: string;
  meshRoot: string;
  actorRoot: string;
  sessionActorRoot?: string;
  residencyRoot: string;
  fullCodeMode: boolean;
  kernel?: FabricKernel;
  pythonRuntime?: "cpython" | "monty";
  agents: FabricAgentConfig;
  mesh: FabricMeshConfig;
  retention: FabricRetentionConfig;
  workerPath: string;
  fabricExtensionPath: string;
  piBinary: string;
  claudeBinary: string;
  vedaBinary: string;
  piModels?: ResidentPiModelState;
  modelGuidance?: FabricOwnedModelGuidance[];
}

// `identity` and `heartbeatAt` are additive (format stays 1): they let a
// reader in another PID namespace judge the owner by heartbeat.
export interface ResidentHostOwner extends OwnerHeartbeatFields {
  format: typeof RESIDENT_HOST_FORMAT;
  hostId: string;
  pid: number;
  token: string;
  startedAt: number;
  readyAt: number;
}

interface ResidentSpawnCommand {
  format: typeof RESIDENT_HOST_FORMAT;
  operation: "spawn";
  requestId: string;
  rootId: string;
  /** Carries the host-only recursiveToolAuthority deny cap. Absence is not a grant;
   * the receiving manager also applies its own inherited authority. Format stays 1. */
  request: AgentRunRequest;
  /** A registered runner's residentModule, imported by the host before launch. */
  runnerModule?: string;
  createdAt: number;
}

interface ResidentCleanupCommand {
  format: typeof RESIDENT_HOST_FORMAT;
  operation: "cleanup";
  requestId: string;
  rootId: string;
  id: string;
  deleteBranch: boolean;
  createdAt: number;
}

interface ResidentForegroundCommand {
  format: typeof RESIDENT_HOST_FORMAT;
  operation: "foreground";
  requestId: string;
  rootId: string;
  id: string;
  createdAt: number;
}

interface ResidentRemoveActorCommand {
  format: typeof RESIDENT_HOST_FORMAT;
  operation: "removeActor";
  requestId: string;
  rootId: string;
  id: string;
  createdAt: number;
}

interface ResidentCreateActorCommand {
  format: typeof RESIDENT_HOST_FORMAT;
  operation: "createActor";
  requestId: string;
  rootId: string;
  request: FabricActorRequest;
  createdAt: number;
}

export type ResidentCommand =
  | ResidentSpawnCommand
  | ResidentCleanupCommand
  | ResidentForegroundCommand
  | ResidentRemoveActorCommand
  | ResidentCreateActorCommand;

export interface ResidentCommandResponse {
  format: typeof RESIDENT_HOST_FORMAT;
  requestId: string;
  ok: boolean;
  handle?: AgentHandleInfo;
  actor?: FabricActorInfo;
  error?: string;
  /** Set when a claimed request was interrupted; the same concept as a run record's outcome. */
  outcome?: FabricRunOutcome;
  completedAt: number;
}

export interface ResidentAgentMetadata {
  format: typeof RESIDENT_HOST_FORMAT;
  rootId: string;
  id: string;
  runDirectory: string;
  handle: AgentHandleInfo;
  worktreeGitRoot?: string;
  /** Creation-time relative root; absent in legacy metadata. */
  worktreeRoot?: string;
  /** Imported again by a restarted host before it re-attaches hosted runs. */
  runnerModule?: string;
  /** The scope the durable child launched with (forwarded by the requesting session). */
  scope?: FabricScope;
  /** Main consumed this terminal result; suppress queued delivery across reconnects. */
  completionConsumedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ResidentDeliveryRecord {
  format: typeof RESIDENT_HOST_FORMAT;
  /** Survives payload truncation; lets Main read the authoritative terminal result. */
  agentCompletionId?: string;
  id: string;
  rootId: string;
  from: MeshIdentity;
  delivery: "steer" | "followUp";
  triggerTurn: boolean;
  message: string;
  data?: unknown;
  createdAt: number;
}
