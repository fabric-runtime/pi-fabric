// A closed factory keeps host and guest normalization identical. Its serialized
// body has no module captures or host capabilities and also runs inside QuickJS.
function createPiArgumentNormalizer() {
  const __piStringFields: Record<string, string> = { bash: "command", powershell: "command", read: "path", ls: "path", grep: "pattern", find: "pattern" };
  const __piArgAliases: Record<string, Record<string, string>> = {
    bash: {
      cmd: "command", shell: "command", cmdline: "command", script: "command",
      commandLine: "command",
      workdir: "cwd", directory: "cwd", workingDirectory: "cwd",
      run_in_background: "background",
    },
    powershell: {
      cmd: "command", shell: "command", cmdline: "command", script: "command",
      commandLine: "command",
      workdir: "cwd", directory: "cwd", workingDirectory: "cwd",
      run_in_background: "background",
    },
    find: {
      query: "pattern", regex: "pattern", search: "pattern", name: "pattern",
      filename: "pattern", glob: "pattern", expression: "pattern", include: "pattern",
      max: "limit",
    },
    grep: {
      query: "pattern", regex: "pattern", search: "pattern", q: "pattern",
      expression: "pattern", text: "pattern",
      ic: "ignoreCase", caseInsensitive: "ignoreCase",
      globPattern: "glob",
      max: "limit", ctx: "context",
    },
    read: {
      file: "path", absolutePath: "path", file_path: "path", filePath: "path",
      filepath: "path", pathname: "path", target_file: "path", targetFile: "path",
      absolute_path: "path", fileAbsolutePath: "path",
      max: "limit", start: "offset",
    },
    ls: {
      dir: "path", file: "path", folder: "path", absolutePath: "path",
      file_path: "path", filePath: "path", filepath: "path", pathname: "path",
      target_file: "path", targetFile: "path", absolute_path: "path",
      fileAbsolutePath: "path", directory: "path", directoryPath: "path",
      max: "limit",
    },
    edit: {
      file: "path", absolutePath: "path", file_path: "path", filePath: "path",
      filepath: "path", pathname: "path", target_file: "path", targetFile: "path",
      absolute_path: "path", fileAbsolutePath: "path",
      old: "oldText", old_string: "oldText", oldString: "oldText",
      old_str: "oldText", oldStr: "oldText", from: "oldText",
      old_value: "oldText", old_text: "oldText", oldContent: "oldText",
      old_content: "oldText",
      new: "newText", replacement: "newText", new_string: "newText",
      newString: "newText", new_str: "newText", newStr: "newText",
      to: "newText", new_value: "newText", new_text: "newText",
      newContent: "newText", new_content: "newText",
    },
    write: {
      file: "path", absolutePath: "path", file_path: "path", filePath: "path",
      filepath: "path", pathname: "path", target_file: "path", targetFile: "path",
      absolute_path: "path", fileAbsolutePath: "path",
      contents: "content", body: "content", text: "content", data: "content",
      fileContent: "content",
    },
  };
  const __piNumericFields: Record<string, string[]> = {
    read: ["offset", "limit"],
    grep: ["limit", "context"],
    find: ["limit"],
    ls: ["limit"],
    bash: ["timeout"],
    powershell: ["timeout"],
  };
  const __piOptionalFields: Record<string, string[]> = {
    read: ["offset", "limit", "anchors"],
    grep: ["path", "glob", "ignoreCase", "literal", "context", "limit"],
    find: ["path", "limit"],
    ls: ["path", "limit"],
    bash: ["timeout", "background", "durable"],
    powershell: ["timeout", "background"],
  };
  const __normalizePiArgs = (name: string, args: any, canonicalFields: readonly string[] = []): unknown => {
    const field = __piStringFields[name];
    if (typeof args === "string" && field) return { [field]: args };
    if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
    const aliases = __piArgAliases[name];
    let out = args;
    if ((name === "bash" || name === "powershell") && Object.hasOwn(out, "timeoutMs") && !canonicalFields.includes("timeoutMs")) {
      out = { ...args };
      if (!("timeout" in out)) {
        const timeoutMs = out.timeoutMs;
        if (timeoutMs !== null && timeoutMs !== undefined) {
          out.timeout = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) / 1000 : timeoutMs;
        }
      }
      delete out.timeoutMs;
    }
    // settle is a guest-only directive (settles nonzero exits instead of
    // rejecting); strip it so it never reaches the host/bash schema.
    if ((name === "bash" || name === "powershell") && "settle" in out) {
      if (out.settle !== undefined && typeof out.settle !== "boolean") throw new TypeError("pi shell settle must be a boolean");
      if (out === args) out = { ...args };
      delete out.settle;
    }
    if (aliases) {
      for (const alias in aliases) {
        const canonical = aliases[alias]!;
        if (Object.hasOwn(out, alias) && !canonicalFields.includes(alias)) {
          if (out === args) out = { ...args };
          if (!Object.hasOwn(out, canonical)) out[canonical] = out[alias];
          delete out[alias];
        }
      }
    }
    if ((name === "bash" || name === "powershell") && "background" in out) {
      if (out.background !== undefined && typeof out.background !== "boolean") {
        throw new TypeError("pi shell background must be a boolean");
      }
    }
    const numerics = __piNumericFields[name];
    if (numerics) {
      for (const key of numerics) {
        const value = out[key];
        if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
          if (out === args) out = { ...args };
          out[key] = Number(value);
        }
      }
    }
    const optionalFields = __piOptionalFields[name];
    if (optionalFields) {
      for (const key of optionalFields) {
        if (out[key] !== null && out[key] !== undefined) continue;
        if (!(key in out)) continue;
        if (out === args) out = { ...args };
        delete out[key];
      }
    }
    if (name === "edit" && Array.isArray(out.edits)) {
      let changed = false;
      const editAliases = __piArgAliases.edit;
      const edits = out.edits.map((entry: any) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
        let edit = entry;
        for (const alias in editAliases) {
          const canonical = editAliases![alias]!;
          if (canonical !== "oldText" && canonical !== "newText") continue;
          if (!Object.hasOwn(edit, alias)) continue;
          if (edit === entry) edit = { ...entry };
          if (!Object.hasOwn(edit, canonical)) edit[canonical] = edit[alias];
          delete edit[alias];
          changed = true;
        }
        return edit;
      });
      if (changed) {
        if (out === args) out = { ...args };
        out.edits = edits;
      }
    }
    if (name === "edit" && !Array.isArray(out.edits) && ("oldText" in out || "newText" in out)) {
      if (out === args) out = { ...args };
      const edit: Record<string, unknown> = {};
      if ("oldText" in out) edit.oldText = out.oldText;
      if ("newText" in out) edit.newText = out.newText;
      out.edits = [edit];
      delete out.oldText;
      delete out.newText;
    }
    return out;
  };
  return __normalizePiArgs;
}

export const normalizePiArguments = createPiArgumentNormalizer();
export const PI_ARGUMENT_NORMALIZATION_SOURCE = `const __normalizePiArgs = (${createPiArgumentNormalizer.toString()})();`;
