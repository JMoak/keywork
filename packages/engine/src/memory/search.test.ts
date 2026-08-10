import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type EmbeddingsPort, lexicalRanking, MemorySearch, tokenize } from "./search.ts";
import { MemoryStore, type NoteInput } from "./store.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function vault(trusted = true): Promise<MemoryStore> {
  const root = await mkdtemp(join(tmpdir(), "keywork-search-"));
  cleanups.push(root);
  return new MemoryStore({
    vaultRoot: root,
    trusted,
    now: () => new Date("2026-08-10T14:30:00.000Z"),
  });
}

async function seeded(store: MemoryStore, notes: Array<Partial<NoteInput> & { title: string }>) {
  for (const note of notes) {
    await store.writeNote({ body: "", provenance: "user", ...note });
  }
}

const axes: Record<string, string[]> = {
  garden: ["garden", "plant", "cultivation", "curing"],
  terminal: ["terminal", "tty", "console"],
  session: ["session", "conversation", "transcript"],
};

function countingPort(): EmbeddingsPort & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    id: "mock:topics-v1",
    calls,
    async embed(texts: string[]): Promise<number[][]> {
      calls.push(texts);
      return texts.map((text) => {
        const lower = text.toLowerCase();
        return Object.values(axes).map((words) =>
          words.reduce((sum, word) => sum + (lower.includes(word) ? 1 : 0), 0),
        );
      });
    },
  };
}

function failingPort(): EmbeddingsPort {
  return {
    id: "mock:down",
    async embed(): Promise<number[][]> {
      throw new Error("provider down");
    },
  };
}

describe("lexicalRanking", () => {
  it("ranks a title match above a body-only match", async () => {
    const store = await vault();
    await seeded(store, [
      { title: "Dock ratio", body: "the column defaults to 0.3" },
      { title: "Layout tree", body: "splits nest; the dock ratio lives elsewhere" },
      { title: "Unrelated", body: "nothing to see" },
    ]);
    const ranked = lexicalRanking(await store.listNotes(), "dock ratio");
    expect(ranked.map((entry) => entry.note.title)).toEqual(["Dock ratio", "Layout tree"]);
  });

  it("returns nothing for a query with no indexable terms", async () => {
    const store = await vault();
    await seeded(store, [{ title: "Dock ratio", body: "0.3" }]);
    expect(lexicalRanking(await store.listNotes(), "!!! ?")).toEqual([]);
  });
});

describe("tokenize", () => {
  it("lowercases, splits punctuation, and drops single characters", () => {
    expect(tokenize("Dock-Ratio: a b12 X")).toEqual(["dock", "ratio", "12"]);
  });
});

describe("MemorySearch", () => {
  it("is empty and lexical-sourced for an untrusted vault", async () => {
    const search = new MemorySearch(await vault(false));
    const outcome = await search.search("anything");
    expect(outcome.hits).toEqual([]);
    expect(outcome.source).toEqual({ kind: "lexical" });
  });

  it("degrades to lexical-only without an embeddings port", async () => {
    const store = await vault();
    await seeded(store, [{ title: "Dock ratio", body: "0.3 default" }]);
    const outcome = await new MemorySearch(store).search("dock");
    expect(outcome.source).toEqual({ kind: "lexical" });
    expect(outcome.hits.map((hit) => hit.note.title)).toEqual(["Dock ratio"]);
    expect(outcome.hits[0]?.legs).toEqual(["lexical"]);
  });

  it("surfaces semantically related notes with zero lexical overlap", async () => {
    const store = await vault();
    await seeded(store, [
      { title: "Curing garden", body: "staged entries harden as they survive recalls" },
      { title: "Terminal chrome", body: "borders render one cell inside the tty rect" },
    ]);
    const outcome = await new MemorySearch(store, countingPort()).search("plant cultivation");
    expect(outcome.source).toEqual({ kind: "hybrid", embeddings: "mock:topics-v1" });
    expect(outcome.hits.map((hit) => hit.note.title)).toEqual(["Curing garden"]);
    expect(outcome.hits[0]?.legs).toEqual(["semantic"]);
  });

  it("fuses legs so a note ranked by both outranks single-leg notes", async () => {
    const store = await vault();
    await seeded(store, [
      { title: "Session garden", body: "the conversation curing garden" },
      { title: "Session store", body: "JSONL conversation entries" },
      { title: "Garden shed", body: "plant tools" },
    ]);
    const outcome = await new MemorySearch(store, countingPort()).search("conversation garden");
    expect(outcome.hits[0]?.note.title).toBe("Session garden");
    expect(outcome.hits[0]?.legs.sort()).toEqual(["lexical", "semantic"]);
  });

  it("keeps lexical results and reports degradation when embedding fails", async () => {
    const store = await vault();
    await seeded(store, [{ title: "Dock ratio", body: "0.3 default" }]);
    const outcome = await new MemorySearch(store, failingPort()).search("dock");
    expect(outcome.source).toEqual({
      kind: "lexical-degraded",
      embeddings: "mock:down",
      reason: "provider down",
    });
    expect(outcome.hits.map((hit) => hit.note.title)).toEqual(["Dock ratio"]);
  });

  it("floors superseded notes below their successors regardless of score", async () => {
    const store = await vault();
    await seeded(store, [
      { title: "Old dock fact", body: "dock ratio dock ratio dock ratio is 0.3" },
    ]);
    await store.writeNote({
      title: "New dock fact",
      body: "dock ratio is 0.4",
      provenance: "user",
      supersedes: "Old dock fact",
    });
    const outcome = await new MemorySearch(store).search("dock ratio");
    expect(outcome.hits.map((hit) => hit.note.title)).toEqual(["New dock fact", "Old dock fact"]);
    expect(outcome.hits[0]?.superseded).toBe(false);
    expect(outcome.hits[1]?.superseded).toBe(true);
  });

  it("respects the limit after flooring", async () => {
    const store = await vault();
    await seeded(store, [
      { title: "Dock one", body: "dock" },
      { title: "Dock two", body: "dock" },
      { title: "Dock three", body: "dock" },
    ]);
    const outcome = await new MemorySearch(store).search("dock", { limit: 2 });
    expect(outcome.hits).toHaveLength(2);
  });

  it("re-embeds only changed notes across searches", async () => {
    const store = await vault();
    await seeded(store, [
      { title: "Curing garden", body: "staged entries harden" },
      { title: "Terminal chrome", body: "tty borders" },
    ]);
    const port = countingPort();
    const search = new MemorySearch(store, port);
    await search.search("plant");
    expect(port.calls).toEqual([
      [expect.stringContaining("Curing garden"), expect.stringContaining("Terminal chrome")],
      ["plant"],
    ]);
    await search.search("plant");
    expect(port.calls).toHaveLength(3);
    expect(port.calls[2]).toEqual(["plant"]);
    await store.writeNote({ title: "Curing garden", body: "hardened now", provenance: "user" });
    await search.search("plant");
    expect(port.calls[3]).toEqual([expect.stringContaining("hardened now")]);
  });

  it("returns nothing for a blank query", async () => {
    const store = await vault();
    await seeded(store, [{ title: "Dock ratio", body: "0.3" }]);
    const outcome = await new MemorySearch(store).search("   ");
    expect(outcome.hits).toEqual([]);
  });
});
