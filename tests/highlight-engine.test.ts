import { describe, expect, it, vi } from "vitest";
import { highlightCode, initHighlighting } from "../src/ui/highlight.js";

// Shiki's default Oniguruma engine keeps a WebAssembly heap that only grows
// (16 MB to 172 MB on this repository's files, held for the life of Pi).
// Fabric highlights with the JavaScript regex engine, whose memory the
// collector can reclaim.
describe("fabric highlight engine", () => {
  it("highlights without instantiating WebAssembly", async () => {
    const instantiate = vi.spyOn(WebAssembly, "instantiate");
    const instantiateStreaming = vi.spyOn(WebAssembly, "instantiateStreaming");
    try {
      await initHighlighting("dark-plus");
      const rendered = highlightCode("const answer: number = 42;", "typescript");
      expect(rendered?.join("\n")).toContain("\x1b[38;2;");
      expect(instantiate).not.toHaveBeenCalled();
      expect(instantiateStreaming).not.toHaveBeenCalled();
    } finally {
      instantiate.mockRestore();
      instantiateStreaming.mockRestore();
    }
  }, 20_000);

  it("renders very long lines plain and keeps highlighting the rest", async () => {
    await initHighlighting("dark-plus");
    // Tokenizing this string literal is quadratic in the line's length: about
    // ten seconds uncapped at this size.
    const long = `const s = "${"a".repeat(60_000)}";`;
    const rendered = highlightCode(`${long}\nconst answer = 42;`, "typescript");
    expect(rendered).toHaveLength(2);
    expect(rendered![0]).not.toContain("\x1b[38;2;");
    expect(rendered![0]).toContain("a".repeat(1_000));
    expect(rendered![1]).toContain("\x1b[38;2;");
  }, 5_000);
});
