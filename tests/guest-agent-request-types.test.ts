import { describe, expect, it } from "vitest";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

// Wrong value types are filtered unless type correctness is requested; unknown properties never are.
const check = (code: string) => typeCheckFabricCode(code, GUEST_TYPE_DECLARATIONS, true);

describe("FabricAgentRequest guest declaration", () => {
  it("accepts the task, model, thinking and systemPrompt a bound agent program passes", () => {
    const result = check(
      'const r = await agents.run({ task: "t", model: "provider/id", thinking: "high", systemPrompt: "Be brief." }); return r.status;',
    );
    expect(result.errors).toEqual([]);
  });

  it("rejects a systemPrompt that is not a string", () => {
    expect(check('await agents.run({ task: "t", systemPrompt: 7 }); return 1;').errors.length).toBeGreaterThan(0);
  });
});
