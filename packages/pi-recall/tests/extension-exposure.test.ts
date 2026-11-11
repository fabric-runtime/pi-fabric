// Regression pin for v0.2.0: the memory trio is declared to the model by
// default — exposure "direct", not the retired shell-bridge "deferred".
// The extension module is imported for its side-effect-free top level only;
// a capture stub stands in for the ExtensionAPI host.
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerMemoryExtension from "../extensions/memory.js";

interface RegisteredTool {
  name: string;
  exposure: string;
}

describe("memory extension tool exposure", () => {
  test("memory_recall / memory_expand / memory_sessions register direct", () => {
    const registered: RegisteredTool[] = [];
    const pi = {
      registerTool: (tool: RegisteredTool) => {
        registered.push(tool);
      },
    } as unknown as ExtensionAPI;

    registerMemoryExtension(pi);

    expect(registered.map((tool) => tool.name)).toEqual([
      "memory_recall",
      "memory_expand",
      "memory_sessions",
    ]);
    for (const tool of registered) {
      expect(tool.exposure).toBe("direct");
    }
  });
});
