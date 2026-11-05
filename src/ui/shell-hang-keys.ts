import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { FabricProgramTasks } from "../core/program-tasks.js";
import type { FabricShellJobStore } from "../core/shell-jobs.js";
import { installFabricEscapeHalt } from "./escape-halt.js";

const CTRL_B_CHORD_MS = 1_000;

interface ShellHangKeyOptions {
  enabled: () => boolean;
  ownsInput: () => boolean;
  jobs: () => FabricShellJobStore | undefined;
  programs?: () => FabricProgramTasks | undefined;
}

/**
 * Spill or kill a nested shell that is still waiting, without a jobs API. With
 * no shell waiting, Ctrl+B twice from an empty editor moves the running
 * `fabric_exec` program to the background instead. A non-empty editor keeps
 * Ctrl+B as cursor-left.
 */
export function installFabricShellHangKeys(
  context: ExtensionContext,
  options: ShellHangKeyOptions,
): () => void {
  if (context.mode !== "tui" || typeof context.ui.onTerminalInput !== "function") return () => {};
  const stopMonitors = installFabricEscapeHalt(context, {
    enabled: options.enabled, ownsInput: options.ownsInput, halted: () => false,
    halt: () => {
      let count = 0;
      for (const job of options.jobs()?.live() ?? []) if (job.options.monitor && job.stop("Main interrupted")) count++;
      return count;
    },
  });
  let chordArmedAt = 0;
  const unsubscribe = context.ui.onTerminalInput((data) => {
    if (options.ownsInput() || !options.enabled()) {
      chordArmedAt = 0;
      return undefined;
    }
    const jobs = options.jobs();
    const shells = jobs?.waiting().length ?? 0;
    const ctrlB = matchesKey(data, "ctrl+b");
    const programs = shells === 0 && ctrlB && editorEmpty(context) ? options.programs?.() : undefined;
    if (!jobs || (shells === 0 && !programs?.waiting())) {
      chordArmedAt = 0;
      return undefined;
    }
    if (ctrlB) {
      const now = Date.now();
      if (chordArmedAt > 0 && now - chordArmedAt <= CTRL_B_CHORD_MS) {
        chordArmedAt = 0;
        if (programs) {
          const count = programs.detachWaiting();
          if (count > 0) {
            context.ui.notify(
              count === 1
                ? "Fabric: program moved to the background · /fabric tasks"
                : `Fabric: ${count} programs moved to the background · /fabric tasks`,
              "info",
            );
          }
          return { consume: true };
        }
        const count = jobs.spillWaiting();
        if (count > 0) {
          context.ui.notify(
            count === 1
              ? "Fabric: shell still running · output spilled to a live log"
              : `Fabric: ${count} shells still running · output spilled to live logs`,
            "info",
          );
        }
        return { consume: true };
      }
      chordArmedAt = now;
      if (shells > 0) context.ui.notify("Fabric: press Ctrl+B again to background the waiting shell", "info");
      return { consume: true };
    }
    chordArmedAt = 0;
    if (matchesKey(data, "ctrl+k")) {
      const count = jobs.killWaiting();
      if (count > 0) {
        context.ui.notify(
          count === 1 ? "Fabric: killed waiting shell" : `Fabric: killed ${count} waiting shells`,
          "warning",
        );
      }
      return { consume: true };
    }
    return undefined;
  });
  return () => { stopMonitors(); unsubscribe(); };
}

const editorEmpty = (context: ExtensionContext): boolean => {
  try { return (context.ui.getEditorText?.() ?? "") === ""; } catch { return false; }
};
