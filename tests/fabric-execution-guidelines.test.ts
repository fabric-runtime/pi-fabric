import { describe, expect, it } from "vitest";
import { fabricExecutionGuidelines, fabricOwnedExecutionGuidelines } from "../src/core/execution-guidelines.js";
import { fabricGuidanceDelivery, relocateFabricGuidelines, stripFabricRuleBullets } from "../src/core/guidance-delivery.js";

// Universal routing is proved by promptGuidance. These cases exercise the
// Boolean codec, exact text adapter and the selective-provider boundary.
describe("portable Fabric execution guidelines", () => {
  it("delivers every authored rule exactly once through a section-only provider", () => {
    for (const [kernel, runtime, managed] of [
      ["typescript", "monty", false], ["python", "monty", false],
      ["python", "cpython", false], ["typescript", "monty", true],
    ] as const) {
      const rules = fabricExecutionGuidelines(kernel, runtime, managed);
      const nativeRules = { fabric_exec: [...rules, "An unrelated rule."], other_tool: ["Other tool guidance."] };
      const plan = relocateFabricGuidelines(nativeRules, rules, fabricGuidanceDelivery(true, true, false));
      // A provider may drop generated tool/rules sections and retain only
      // named extension sections, exactly as claude-bridge does.
      const projected = Object.values({ fabric: plan.text }).join("\n\n");
      for (const rule of rules) expect(projected.split(rule).length - 1).toBe(1);
      expect(plan.remaining).toEqual(["An unrelated rule."]);
      expect(nativeRules.fabric_exec).toEqual([...rules, "An unrelated rule."]);
      expect(nativeRules.other_tool).toEqual(["Other tool guidance."]);
    }
  });

  it("uses the explicit append for forced and legacy prompts, including an existing sections object", () => {
    expect(fabricGuidanceDelivery(true, true, true)).toEqual({ section: false, append: true, native: false });
    expect(fabricGuidanceDelivery(true, false, false)).toEqual({ section: false, append: true, native: false });
    const rules = fabricExecutionGuidelines();
    const original = `Header\r\n<rules>\r\n${rules.map(x => `- ${x}`).join("\r\n")}\r\n- Foreign rule.\r\n</rules>\r\nFooter`;
    const plan = relocateFabricGuidelines(undefined, rules, fabricGuidanceDelivery(true, false, false));
    const rendered = stripFabricRuleBullets(original, fabricOwnedExecutionGuidelines()) + "\n\n" + plan.text;
    for (const rule of rules) expect(rendered.split(rule).length - 1).toBe(1);
    expect(rendered).toContain("Header\r\n<rules>\r\n- Foreign rule.\r\n</rules>\r\nFooter");
    expect(stripFabricRuleBullets(`A prose mention: ${rules[0]}`, fabricOwnedExecutionGuidelines())).toBe(`A prose mention: ${rules[0]}`);
  });

  it("does not strip or inject inactive guidance", () => {
    const rules = fabricExecutionGuidelines();
    const native = { fabric_exec: [...rules] };
    expect(relocateFabricGuidelines(native, rules, fabricGuidanceDelivery(false, true, false))).toEqual({});
    expect(native.fabric_exec).toEqual(rules);
  });

  it("keeps preparation pure and repeated renders identical across kernel changes", () => {
    const rules = fabricExecutionGuidelines("python", "monty");
    const original = [...rules];
    const native = { fabric_exec: [...fabricExecutionGuidelines(), ...rules, "Retained rule."] };
    const before = structuredClone(native);
    const delivery = fabricGuidanceDelivery(true, true, false);
    const first = relocateFabricGuidelines(native, rules, delivery, fabricOwnedExecutionGuidelines());
    expect(native).toEqual(before);
    const second = relocateFabricGuidelines({ fabric_exec: first.remaining! }, rules, delivery, fabricOwnedExecutionGuidelines());
    expect(second).toEqual(first);
    expect(first.remaining).toEqual(["Retained rule."]);
    expect(rules).toEqual(original);
    rules.pop();
    expect(fabricExecutionGuidelines("python", "monty")).toEqual(original);
  });

  it("keeps schema and persistence guidance concise across coding kernels", () => {
    for (const kernel of ["typescript", "python"] as const) {
      const text = fabricExecutionGuidelines(kernel).join("\n");
      expect(text).toContain("Inspect findings before choosing dependent reads or edits.");
      expect(text).toContain("Background long-running work when independent tasks can proceed; collect its result before completion.");
      expect(text).toContain("Form a falsifiable hypothesis covering the reported failure and affected paths.");
      expect(text).toContain("Let contrary evidence invalidate the plan.");
      expect(text).toContain("Verify postconditions before declaring success.");
      expect(text).not.toContain("smallest complete fix");
      expect(text).not.toContain("A build alone is not completion");
      expect(text).not.toContain("schema.hypothesize");
      expect(text).toContain("Be ambitious and persistent");
      expect(text).toContain("Treat new requests as additive, not replacements");
      expect(text).toContain("unless explicitly reprioritized");
      expect(text.length).toBeLessThan(1700);
    }
    const managed = fabricExecutionGuidelines("typescript", "monty", true).join("\n");
    expect(managed).toContain("Treat new requests as additive, not replacements");
    expect(managed).toContain("Verify postconditions before declaring success.");
  });

  it("keeps language and sandbox instructions faithful to the selected kernel", () => {
    expect(fabricExecutionGuidelines("typescript").join("\n")).toContain("Promise.all");
    const monty = fabricExecutionGuidelines("python", "monty").join("\n");
    expect(monty).toContain("asyncio.gather");
    expect(monty).toContain("Monty requires acyclic");
    expect(monty).not.toContain("Promise.all");
    expect(fabricExecutionGuidelines("python", "cpython").join("\n")).not.toContain("Monty requires");
    expect(fabricExecutionGuidelines("typescript", "monty", true).join("\n")).not.toContain("pi.bash");
  });
});
