import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditLine, parseAuditLog } from "./audit.ts";
import { MemoryStore } from "./store.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe("parseAuditLog", () => {
  it("round-trips audit lines and skips anything that is not one", () => {
    const raw = `${auditLine("2026-08-21T10:00:00.000Z", "gardener sweep: promoted 1")}# stray heading\n${auditLine("2026-08-21T10:00:01.000Z", "approved note → Web Claim.md")}`;
    expect(parseAuditLog(raw)).toEqual([
      { timestamp: "2026-08-21T10:00:00.000Z", event: "gardener sweep: promoted 1" },
      { timestamp: "2026-08-21T10:00:01.000Z", event: "approved note → Web Claim.md" },
    ]);
  });

  it("reads back what the store audited, oldest first", async () => {
    const root = await mkdtemp(join(tmpdir(), "keywork-audit-"));
    cleanups.push(root);
    let tick = 0;
    const store = new MemoryStore({
      vaultRoot: root,
      trusted: true,
      now: () => new Date(Date.UTC(2026, 7, 21, 10, 0, tick++)),
    });
    await store.recordAudit("first");
    await store.recordAudit("second");
    expect((await store.readAudit()).map((entry) => entry.event)).toEqual(["first", "second"]);
    expect(await new MemoryStore({ vaultRoot: root, trusted: false }).readAudit()).toEqual([]);
  });
});
