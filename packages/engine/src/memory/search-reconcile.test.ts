import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { type EmbeddingsPort, MemorySearch } from "./search.ts";
import { MemoryStore } from "./store.ts";

const scratch = scratchDirs("keywork-search-reconcile-");

function countingPort(): EmbeddingsPort & { embedded: string[] } {
  const embedded: string[] = [];
  return {
    id: "mock:counting",
    embedded,
    async embed(texts) {
      embedded.push(...texts);
      return texts.map((text) => [text.includes("bun") ? 1 : 0, text.includes("vim") ? 1 : 0]);
    },
  };
}

async function indexed(): Promise<{
  root: string;
  store: MemoryStore;
  search: MemorySearch;
  port: ReturnType<typeof countingPort>;
}> {
  const root = await scratch();
  const store = new MemoryStore({ vaultRoot: root, trusted: true });
  await store.writeNote({ title: "Runtime", body: "we use bun\n", provenance: "user" });
  await store.writeNote({ title: "Editor", body: "we use vim\n", provenance: "user" });
  const port = countingPort();
  const search = new MemorySearch(store, port);
  await search.search("bun");
  return { root, store, search, port };
}

describe("index self-reconciliation (files are truth)", () => {
  it("picks up a note edited outside keywork on the next open", async () => {
    const { root, search, port } = await indexed();
    expect(port.embedded).toHaveLength(3);
    await writeFile(join(root, "Runtime.md"), "we moved to bun 1.3\n", "utf8");
    const report = await search.reconcile();
    expect(report).toEqual({ notes: 2, refreshed: ["Runtime.md"], dropped: [] });
    expect(port.embedded.filter((text) => text.includes("bun 1.3"))).toHaveLength(1);
    const hits = (await search.search("bun")).hits.map((hit) => hit.note.body);
    expect(hits[0]).toBe("we moved to bun 1.3\n");
  });

  it("leaves no index ghost behind a note deleted outside keywork", async () => {
    const { root, search } = await indexed();
    await rm(join(root, "Editor.md"));
    const report = await search.reconcile();
    expect(report).toEqual({ notes: 1, refreshed: [], dropped: ["Editor.md"] });
    const outcome = await search.search("vim");
    expect(outcome.hits.map((hit) => hit.note.name)).not.toContain("Editor");
    expect(await search.reconcile()).toEqual({ notes: 1, refreshed: [], dropped: [] });
  });

  it("reconciles a lexical-only index too, since every search reads the files", async () => {
    const root = await scratch();
    const store = new MemoryStore({ vaultRoot: root, trusted: true });
    await store.writeNote({ title: "Runtime", body: "we use bun\n", provenance: "user" });
    const search = new MemorySearch(store);
    await writeFile(join(root, "Runtime.md"), "we use deno\n", "utf8");
    expect(await search.reconcile()).toEqual({ notes: 1, refreshed: [], dropped: [] });
    expect((await search.search("deno")).hits.map((hit) => hit.note.name)).toEqual(["Runtime"]);
  });
});
