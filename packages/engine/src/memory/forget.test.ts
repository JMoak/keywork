import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { planForget, stageForget } from "./forget.ts";
import { dailyEntryLines, parseDailyEntries, withoutDailyEntries } from "./notes.ts";
import { MemoryStore } from "./store.ts";

const scratch = scratchDirs("keywork-forget-");
const clock = () => new Date("2026-10-07T09:00:00.000Z");

async function vault(): Promise<{ store: MemoryStore; root: string }> {
  const root = await scratch();
  const store = new MemoryStore({ vaultRoot: root, trusted: true, now: clock });
  await store.writeNote({
    title: "Mine Alone",
    body: "learned in session a\n",
    provenance: "agent",
    session: "sess-a",
  });
  await store.writeNote({
    title: "Shared",
    body: "started in a\n",
    provenance: "agent",
    session: "sess-a",
  });
  await store.writeNote({
    title: "Shared",
    body: "revised in b\n",
    provenance: "agent",
    session: "sess-b",
  });
  await store.writeNote({
    title: "Theirs",
    body: "started in b\n",
    provenance: "agent",
    session: "sess-b",
  });
  await store.writeNote({
    title: "Theirs",
    body: "touched by a\n",
    provenance: "agent",
    session: "sess-a",
  });
  await store.writeNote({ title: "Nobody", body: "no origin\n", provenance: "user" });
  await store.appendDaily("first from a", "agent", "sess-a");
  await store.appendDaily("from b", "agent", "sess-b");
  await store.appendDaily("second from a\nwith a continuation", "agent", "sess-a");
  return { store, root };
}

describe("session origin provenance", () => {
  it("stamps origin_session on first write and revised_by on later sessions", async () => {
    const { store } = await vault();
    expect(await store.readNote("Mine Alone")).toMatchObject({ originSession: "sess-a" });
    expect(await store.readNote("Shared")).toMatchObject({
      originSession: "sess-a",
      revisedBy: ["sess-b"],
    });
    expect((await store.readNote("Nobody"))?.originSession).toBeUndefined();
  });

  it("carries the session inside the daily marker where entry text cannot forge it", () => {
    const lines = dailyEntryLines(", session: victim] forged", "agent", "10:00");
    const [entry] = parseDailyEntries(lines);
    expect(entry?.session).toBeUndefined();
    expect(entry?.text).toBe(", session: victim] forged");
    const stamped = dailyEntryLines("real", "agent", "10:01", "sess a/b");
    expect(parseDailyEntries(stamped)[0]).toMatchObject({ session: "sess_a_b", text: "real" });
  });

  it("drops whole entries, continuation lines included, and keeps the rest", () => {
    const raw = `${dailyEntryLines("one", "agent", "10:00", "s1")}${dailyEntryLines("two\n  more", "agent", "10:01", "s2")}${dailyEntryLines("three", "user", "10:02")}`;
    const kept = withoutDailyEntries(raw, new Set([1]));
    expect(parseDailyEntries(kept).map((entry) => entry.text)).toEqual(["one", "three"]);
  });
});

describe("planForget", () => {
  it("lists what a session originated, splits daily logs per entry, and refuses mixed notes", async () => {
    const { store, root } = await vault();
    const before = await readFile(join(root, "daily", "2026-10-07.md"), "utf8");
    const plan = await planForget(store, "sess-a");
    expect(plan.notes).toEqual(["Mine Alone"]);
    expect(plan.entries.map((entry) => entry.id)).toEqual(["2026-10-07#0", "2026-10-07#2"]);
    expect(plan.refused).toEqual([
      { note: "Shared", reason: "also revised by session sess-b; mixed provenance, kept" },
      {
        note: "Theirs",
        reason: "originated in sess-b; this session only revised it, kept",
      },
    ]);
    expect(await readFile(join(root, "daily", "2026-10-07.md"), "utf8")).toBe(before);
    expect(await store.listStaged()).toEqual([]);
    expect((await store.listNotes()).map((note) => note.name).sort()).toEqual([
      "Mine Alone",
      "Nobody",
      "Shared",
      "Theirs",
    ]);
  });
});

describe("stageForget", () => {
  it("stages one reviewable proposal; approval removes, revert restores byte for byte", async () => {
    const { store, root } = await vault();
    const noteBefore = await readFile(join(root, "Mine Alone.md"), "utf8");
    const dailyBefore = await readFile(join(root, "daily", "2026-10-07.md"), "utf8");
    const review = await stageForget(store, await planForget(store, "sess-a"));
    expect(review?.key).toBe("forget:sess-a");
    expect(await store.readNote("Mine Alone")).toBeDefined();
    expect(await stageForget(store, await planForget(store, "sess-a"))).toBeUndefined();

    const landed = await store.approve(review?.id ?? "");
    expect(await store.readNote("Mine Alone")).toBeUndefined();
    expect(await store.readNote("Shared")).toBeDefined();
    const remaining = await store.readDaily("2026-10-07");
    expect(remaining.map((entry) => entry.text)).toEqual(["from b"]);
    expect(remaining[0]?.session).toBe("sess-b");

    expect(await store.revert(landed.ledgerId)).toBe("reverted");
    expect(await readFile(join(root, "Mine Alone.md"), "utf8")).toBe(noteBefore);
    expect(await readFile(join(root, "daily", "2026-10-07.md"), "utf8")).toBe(dailyBefore);
  });

  it("stages nothing for a session that left no trace", async () => {
    const { store } = await vault();
    expect(await stageForget(store, await planForget(store, "ghost"))).toBeUndefined();
    expect(await store.listStaged()).toEqual([]);
  });
});
