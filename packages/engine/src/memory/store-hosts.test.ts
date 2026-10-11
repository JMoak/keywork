import { cp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { planForget, stageForget } from "./forget.ts";
import { InvalidTitleError } from "./naming.ts";
import { MemoryStore } from "./store.ts";

const scratch = scratchDirs("keywork-store-hosts-");

function clockFrom(iso: string): () => Date {
  return () => new Date(iso);
}

async function hostStore(root: string, host: string, at: string): Promise<MemoryStore> {
  return new MemoryStore({ vaultRoot: root, trusted: true, host, now: clockFrom(at) });
}

async function syncBothWays(a: string, b: string): Promise<void> {
  await cp(a, b, { recursive: true, force: false, errorOnExist: false });
  await cp(b, a, { recursive: true, force: false, errorOnExist: false });
}

describe("per-host layout", () => {
  it("writes daily entries and audit lines to this host's own segment", async () => {
    const root = await scratch();
    const store = await hostStore(root, "alpha", "2026-08-10T09:00:00Z");
    await store.appendDaily("learned something", "agent");
    await store.recordAudit("swept");
    expect(await readdir(join(root, "daily"))).toEqual(["2026-08-10.alpha.md"]);
    expect((await readdir(root)).filter((name) => name.startsWith("curation"))).toEqual([
      "curation.alpha.md",
    ]);
    expect(await store.listDailyDates()).toEqual(["2026-08-10"]);
    expect((await store.readDaily("2026-08-10")).map((entry) => entry.text)).toEqual([
      "learned something",
    ]);
    expect((await store.readAudit()).map((entry) => entry.event)).toEqual(["swept"]);
  });

  it("reads the shared file and every host segment as one day, ordered by time", async () => {
    const root = await scratch();
    const legacy = new MemoryStore({
      vaultRoot: root,
      trusted: true,
      now: clockFrom("2026-08-10T08:00:00Z"),
    });
    await legacy.appendDaily("before hosts", "user");
    const alpha = await hostStore(root, "alpha", "2026-08-10T09:00:00Z");
    const beta = await hostStore(root, "beta", "2026-08-10T08:30:00Z");
    await alpha.appendDaily("alpha first", "agent");
    await beta.appendDaily("beta first", "agent");
    await alpha.appendDaily("alpha second", "agent");
    expect((await alpha.readDaily("2026-08-10")).map((entry) => entry.text)).toEqual([
      "before hosts",
      "beta first",
      "alpha first",
      "alpha second",
    ]);
    expect(await beta.listDailyDates()).toEqual(["2026-08-10"]);
    expect(await readFile(join(root, "daily", "2026-08-10.md"), "utf8")).toBe(
      "- 08:00 [prov: user] before hosts\n",
    );
  });

  it("unions audit segments by timestamp", async () => {
    const root = await scratch();
    const alpha = await hostStore(root, "alpha", "2026-08-10T09:00:00Z");
    const beta = await hostStore(root, "beta", "2026-08-10T08:00:00Z");
    await alpha.recordAudit("alpha event");
    await beta.recordAudit("beta event");
    expect((await alpha.readAudit()).map((entry) => entry.event)).toEqual([
      "beta event",
      "alpha event",
    ]);
  });

  it("keeps audit segments out of the note space", async () => {
    const root = await scratch();
    const alpha = await hostStore(root, "alpha", "2026-08-10T09:00:00Z");
    await alpha.recordAudit("event");
    await alpha.writeNote({ title: "Real Note", body: "x\n", provenance: "user" });
    expect((await alpha.listNotes()).map((note) => note.name)).toEqual(["Real Note"]);
    await expect(
      alpha.writeNote({ title: "curation.beta", body: "x\n", provenance: "user" }),
    ).rejects.toBeInstanceOf(InvalidTitleError);
    expect(alpha.isNotePath("curation.beta.md")).toBe(false);
    expect(await alpha.segmentHosts()).toEqual(["alpha"]);
  });

  it("forgets a session's entries from the right segment and reverts byte for byte", async () => {
    const root = await scratch();
    const alpha = await hostStore(root, "alpha", "2026-08-10T09:00:00Z");
    const beta = await hostStore(root, "beta", "2026-08-10T08:30:00Z");
    await alpha.appendDaily("alpha keeps", "agent", "s-keep");
    await beta.appendDaily("beta forgets", "agent", "s-gone");
    await alpha.appendDaily("alpha forgets", "agent", "s-gone");
    const betaBefore = await readFile(join(root, "daily", "2026-08-10.beta.md"), "utf8");
    const plan = await planForget(alpha, "s-gone");
    expect(plan.entries.map((entry) => entry.id)).toEqual(["2026-08-10#0", "2026-08-10#2"]);
    const review = await stageForget(alpha, plan);
    if (review === undefined) throw new Error("expected a staged forget");
    const landed = await alpha.approve(review.id);
    expect((await alpha.readDaily("2026-08-10")).map((entry) => entry.text)).toEqual([
      "alpha keeps",
    ]);
    expect(await readdir(join(root, "daily"))).toEqual(["2026-08-10.alpha.md"]);
    expect(await alpha.revert(landed.ledgerId)).toBe("reverted");
    expect(await readFile(join(root, "daily", "2026-08-10.beta.md"), "utf8")).toBe(betaBefore);
  });
});

describe("two-vault divergence (append case)", () => {
  it("merges by file union after a sync, with nothing to resolve", async () => {
    const vaultA = await scratch();
    const vaultB = await scratch();
    const alpha = await hostStore(vaultA, "alpha", "2026-08-10T09:00:00Z");
    const beta = await hostStore(vaultB, "beta", "2026-08-10T09:30:00Z");
    await alpha.writeNote({ title: "Shared", body: "both start here\n", provenance: "user" });
    await syncBothWays(vaultA, vaultB);
    await alpha.appendDaily("alpha learned", "agent");
    await alpha.recordAudit("alpha swept");
    await beta.appendDaily("beta learned", "agent");
    await beta.recordAudit("beta swept");
    await syncBothWays(vaultA, vaultB);
    for (const store of [alpha, beta]) {
      expect((await store.readDaily("2026-08-10")).map((entry) => entry.text)).toEqual([
        "alpha learned",
        "beta learned",
      ]);
      expect((await store.readAudit()).map((entry) => entry.event)).toEqual([
        "alpha swept",
        "beta swept",
      ]);
      expect(await store.segmentHosts()).toEqual(["alpha", "beta"]);
    }
    expect(await readFile(join(vaultA, "daily", "2026-08-10.alpha.md"), "utf8")).toBe(
      await readFile(join(vaultB, "daily", "2026-08-10.alpha.md"), "utf8"),
    );
  });
});
