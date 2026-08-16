import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapMemory } from "./bootstrap.ts";
import { MemoryStore } from "./store.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function openStore(trusted = true): Promise<MemoryStore> {
  const root = await mkdtemp(join(tmpdir(), "keywork-bootstrap-"));
  cleanups.push(root);
  return new MemoryStore({
    vaultRoot: root,
    trusted,
    now: () => new Date("2026-08-10T14:30:00.000Z"),
  });
}

async function seededStore(): Promise<MemoryStore> {
  const store = await openStore();
  await store.writeNote({ title: "Casual Note", body: "c\n", provenance: "user", confidence: 0.2 });
  await store.writeNote({ title: "Useful Note", body: "u\n", provenance: "user", confidence: 0.9 });
  await store.writeNote({ title: "Pinned Note", body: "p\n", provenance: "user", pinned: true });
  await store.writeMoc(["Casual Note", "Useful Note", "Pinned Note"], "user");
  return store;
}

describe("bootstrapMemory", () => {
  it("transcludes pinned notes first, then most-useful, per layer", async () => {
    const store = await seededStore();
    const injection = await bootstrapMemory([{ name: "workspace", store, budget: 10_000 }]);
    expect(injection.layers[0]?.selection.notes.map((note) => note.title)).toEqual([
      "Pinned Note",
      "Useful Note",
      "Casual Note",
    ]);
    expect(injection.text).toContain("# Memory");
    expect(injection.text).toContain("## workspace memory");
    expect(injection.text.indexOf("### [[Pinned Note]]")).toBeLessThan(
      injection.text.indexOf("### [[Useful Note]]"),
    );
    expect(injection.tokens).toBeGreaterThan(0);
  });

  it("gives every layer its own budget", async () => {
    const workspace = await seededStore();
    const user = await openStore();
    await user.writeNote({ title: "Global Habit", body: "g".repeat(400), provenance: "user" });
    await user.writeMoc(["Global Habit"], "user");
    const injection = await bootstrapMemory([
      { name: "workspace", store: workspace, budget: 10_000 },
      { name: "user", store: user, budget: 10 },
    ]);
    expect(injection.text).toContain("## workspace memory");
    expect(injection.text).not.toContain("## user memory");
    expect(injection.layers[1]?.selection.skipped).toEqual(["Global Habit"]);
  });

  it("selects nothing on a zero budget and skips notes larger than the budget whole", async () => {
    const store = await openStore();
    await store.writeNote({ title: "Huge", body: "h".repeat(800), provenance: "user" });
    await store.writeNote({ title: "Tiny", body: "t\n", provenance: "user" });
    await store.writeMoc(["Huge", "Tiny"], "user");
    const zero = await bootstrapMemory([{ name: "workspace", store, budget: 0 }]);
    expect(zero.text).toBe("");
    expect(zero.layers[0]?.selection.skipped).toEqual(["Huge", "Tiny"]);
    const small = await bootstrapMemory([{ name: "workspace", store, budget: 20 }]);
    expect(small.layers[0]?.selection.notes.map((note) => note.title)).toEqual(["Tiny"]);
    expect(small.text).toContain("### [[Tiny]]");
    expect(small.text).not.toContain("hhh");
  });

  it("stays calm when MEMORY.md is missing", async () => {
    const store = await openStore();
    await store.writeNote({ title: "Orphan", body: "o\n", provenance: "user" });
    const injection = await bootstrapMemory([{ name: "workspace", store, budget: 10_000 }]);
    expect(injection.text).toBe("");
    expect(injection.tokens).toBe(0);
  });

  it("injects nothing from an untrusted layer", async () => {
    const store = await openStore(false);
    const injection = await bootstrapMemory([{ name: "workspace", store, budget: 10_000 }]);
    expect(injection.text).toBe("");
    expect(injection.layers[0]?.selection.notes).toEqual([]);
  });

  it("produces an empty injection with no layers at all", async () => {
    const injection = await bootstrapMemory([]);
    expect(injection).toEqual({ text: "", tokens: 0, layers: [] });
  });
});
