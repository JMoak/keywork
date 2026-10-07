import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { MockProvider, textTurn } from "../mock-provider.ts";
import {
  checkDrift,
  type DiffChanges,
  type DriftAssessment,
  type DriftJudgmentPort,
  driftJudgment,
  touchedNotes,
} from "./drift.ts";
import { MemoryStore } from "./store.ts";

const scratch = scratchDirs("keywork-drift-");
const clock = () => new Date("2026-10-07T09:00:00.000Z");

const patch = [
  "diff --git a/packages/engine/src/memory/store.ts b/packages/engine/src/memory/store.ts",
  "--- a/packages/engine/src/memory/store.ts",
  "+++ b/packages/engine/src/memory/store.ts",
  "@@ -10,4 +10,4 @@ export class MemoryStore {",
  "-  async writeNote(input: NoteInput): Promise<WriteResult> {",
  "+  async writeNote(input: NoteInput, options?: WriteOptions): Promise<WriteResult> {",
  "",
].join("\n");

const changes: DiffChanges = {
  against: "abc123",
  files: ["packages/engine/src/memory/store.ts"],
  patch,
};

async function vault(): Promise<{ store: MemoryStore; root: string }> {
  const root = await scratch();
  const store = new MemoryStore({ vaultRoot: root, trusted: true, now: clock });
  await store.writeNote({
    title: "Write Path",
    body: "Notes land through writeNote in store.ts; nothing else writes the vault.\n",
    provenance: "agent",
  });
  await store.writeNote({
    title: "Color Theme",
    body: "The pane palette is warm grey.\n",
    provenance: "user",
  });
  await store.writeNote({
    entity: "packages/engine/src/memory/store.ts",
    body: "The vault store.\n",
    provenance: "agent",
  });
  return { store, root };
}

function scriptedJudgment(
  verdict: DriftAssessment,
): DriftJudgmentPort & { asked: { note: string; evidence: string[] }[] } {
  const asked: { note: string; evidence: string[] }[] = [];
  return {
    id: "fake:drift",
    asked,
    async assess(note, evidence) {
      asked.push({ note: note.name, evidence: [...evidence] });
      return verdict;
    },
  };
}

describe("touchedNotes", () => {
  it("finds notes by cited path, changed symbol and entity identity, with evidence lines", async () => {
    const { store } = await vault();
    const touched = touchedNotes(await store.listNotes(), changes);
    const byName = new Map(touched.map((evidence) => [evidence.note.name, evidence]));
    expect([...byName.keys()].sort()).toEqual([
      "Write Path",
      "entities/packages/engine/src/memory/store.ts",
    ]);
    const writePath = byName.get("Write Path");
    expect(writePath?.reasons).toEqual([
      "cites packages/engine/src/memory/store.ts",
      "mentions writeNote (packages/engine/src/memory/store.ts)",
    ]);
    expect(writePath?.lines).toContain(
      "+  async writeNote(input: NoteInput, options?: WriteOptions): Promise<WriteResult> {",
    );
    expect(byName.get("entities/packages/engine/src/memory/store.ts")?.reasons).toEqual([
      "is the entity note for packages/engine/src/memory/store.ts",
    ]);
  });
});

describe("checkDrift", () => {
  it("asks only about touched notes and stamps the verdict without touching the body", async () => {
    const { store, root } = await vault();
    const before = await readFile(join(root, "Write Path.md"), "utf8");
    const judgment = scriptedJudgment({ verdict: "hold", reason: "signature grew, claim holds" });
    const report = await checkDrift({ store, judgment, changes, now: clock });

    expect(judgment.asked.map((ask) => ask.note).sort()).toEqual([
      "Write Path",
      "entities/packages/engine/src/memory/store.ts",
    ]);
    expect(judgment.asked.some((ask) => ask.note === "Color Theme")).toBe(false);
    expect(report.untouched).toBe(1);
    expect(report.proposed).toEqual([]);

    const note = await store.readNote("Write Path");
    expect(note?.body).toBe(
      "Notes land through writeNote in store.ts; nothing else writes the vault.\n",
    );
    expect(note?.drift).toEqual({ verdict: "hold", at: clock().toISOString(), against: "abc123" });
    const after = await readFile(join(root, "Write Path.md"), "utf8");
    expect(after.slice(after.indexOf("---\n", 4))).toBe(before.slice(before.indexOf("---\n", 4)));
    expect((await store.readNote("Color Theme"))?.drift).toBeUndefined();

    const audit = await store.readAudit();
    const line = audit.find((entry) => entry.event.startsWith("drift [[Write Path]]"));
    expect(line?.event).toContain("hold against abc123 · signature grew, claim holds");
    expect(line?.event).toContain("cites packages/engine/src/memory/store.ts");
  });

  it("turns a stale verdict into one Gardener proposal and keeps the file reverting cleanly", async () => {
    const { store } = await vault();
    const judgment = scriptedJudgment({ verdict: "stale", reason: "writeNote now takes options" });
    const report = await checkDrift({ store, judgment, changes, now: clock });
    expect(report.proposed).toEqual([
      "drift:write path",
      "drift:entities/packages/engine/src/memory/store.ts",
    ]);
    const staged = await store.listStaged();
    const review = staged.find(
      (item) => item.kind === "drift-review" && item.note === "Write Path",
    );
    expect(review).toMatchObject({
      kind: "drift-review",
      against: "abc123",
      reason: "writeNote now takes options",
    });
    const stamp = store
      .ledger()
      .filter((entry) => entry.deltas.some((delta) => delta.path === "Write Path.md"))
      .at(-1);
    expect(stamp).toBeDefined();
    expect(await store.revert(stamp?.id ?? "")).toBe("reverted");
    expect((await store.readNote("Write Path"))?.drift).toBeUndefined();
  });

  it("does not ask when the diff touches nothing the vault knows", async () => {
    const { store } = await vault();
    const judgment = scriptedJudgment({ verdict: "stale", reason: "never asked" });
    const report = await checkDrift({
      store,
      judgment,
      changes: { against: "x", files: ["README.md"], patch: "" },
    });
    expect(judgment.asked).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.untouched).toBe(3);
  });
});

describe("driftJudgment over a provider", () => {
  it("asks one bounded question per note and parses the JSON verdict", async () => {
    const provider = new MockProvider([
      textTurn('Here you go: {"verdict": "stale", "reason": "renamed"}'),
    ]);
    const judgment = driftJudgment(provider);
    const { store } = await vault();
    const [note] = await store.listNotes();
    if (note === undefined) throw new Error("fixture");
    expect(await judgment.assess(note, ["+ line"])).toEqual({
      verdict: "stale",
      reason: "renamed",
    });
    expect(provider.remaining()).toBe(0);
  });

  it("answers unsure when the provider fails or rambles", async () => {
    const { store } = await vault();
    const [note] = await store.listNotes();
    if (note === undefined) throw new Error("fixture");
    const rambling = driftJudgment(new MockProvider([textTurn("probably fine")]));
    expect((await rambling.assess(note, [])).verdict).toBe("unsure");
    const exhausted = driftJudgment(new MockProvider([]));
    expect((await exhausted.assess(note, [])).verdict).toBe("unsure");
  });
});
