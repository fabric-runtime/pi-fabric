import { describe, expect, it } from "vitest";
import { allocateSummaryBytes, foldFailureLedger, foldUserStaleness, type StalenessOp } from "../src/verified/context.js";

// Codec checks of the compiled context kernels. The laws themselves are proven
// in proofs/context.ts; these distinguish argument positions and encodings.
describe("compiled context kernels", () => {
  it("allocates the user's bytes before operational residue", () => {
    expect(allocateSummaryBytes(100, 30, 50)).toEqual({ userBytes: 30, operationBytes: 50 });
    expect(allocateSummaryBytes(100, 30, 90)).toEqual({ userBytes: 30, operationBytes: 70 });
    expect(allocateSummaryBytes(100, 130, 90)).toEqual({ userBytes: 100, operationBytes: 0 });
    expect(allocateSummaryBytes(0, 5, 5)).toEqual({ userBytes: 0, operationBytes: 0 });
    expect(() => allocateSummaryBytes(-1, 0, 0)).toThrow(RangeError);
  });

  it("counts staleness from user messages only", () => {
    const fold = (ops: StalenessOp[]) => foldUserStaleness(ops);
    expect(fold([])).toEqual({ anchored: false, compactions: 0, background: 0 });
    expect(fold(["compaction", "background", "other"])).toEqual({ anchored: false, compactions: 0, background: 0 });
    expect(fold(["user", "compaction", "background", "background", "compaction", "other"]))
      .toEqual({ anchored: true, compactions: 2, background: 2 });
    // Background deliveries never reset the count; a user message does.
    expect(fold(["user", "compaction", "background", "compaction", "user", "background"]))
      .toEqual({ anchored: true, compactions: 0, background: 1 });
  });

  it("accounts for every failure once and itemizes fresh open failures before aged ones", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let trial = 0; trial < 50; trial++) {
      const failures = Array.from({ length: Math.floor(random() * 40) }, () => ({ fresh: random() < 0.6, resolved: random() < 0.3 }));
      const limit = Math.floor(random() * 10);
      const ledger = foldFailureLedger(failures, limit);
      expect(ledger.total).toBe(failures.length);
      expect(ledger.open + ledger.aged + ledger.resolved).toBe(failures.length);
      expect(ledger.resolved).toBe(failures.filter((f) => f.resolved).length);
      expect(ledger.aged).toBe(failures.filter((f) => !f.resolved && !f.fresh).length);
      // Independent reference: room goes to unresolved failures in input order,
      // and an aged one takes room only while no fresh open failure was left out.
      let room = limit, skipped = 0;
      const expected = failures.map((f) => {
        const open = f.fresh && !f.resolved, aged = !f.fresh && !f.resolved;
        const take = room > 0 && (open || (aged && skipped === 0));
        if (open && room === 0) skipped += 1;
        if (take) room -= 1;
        return take;
      });
      expect(ledger.itemized).toEqual(expected);
      expect(failures.filter((_, index) => ledger.itemized[index]).every((f) => !f.resolved)).toBe(true);
    }
  });
});
