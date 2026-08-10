import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../agent.ts";
import type { ToolResultPart } from "../messages.ts";
import { MockProvider, textTurn, toolCallTurn } from "../mock-provider.ts";
import { coreTools } from "../tools/core.ts";
import { memoryGetTool, memoryRecallTools, memorySearchTool } from "./recall-tools.ts";
import { MemorySearch } from "./search.ts";
import { MemoryStore } from "./store.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function vaultRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "keywork-recall-"));
  cleanups.push(root);
  return root;
}

function openStore(root: string, trusted = true): MemoryStore {
  return new MemoryStore({
    vaultRoot: root,
    trusted,
    now: () => new Date("2026-08-10T14:30:00.000Z"),
  });
}

async function runTool(tool: { execute(args: unknown): Promise<string> }, args: unknown) {
  return tool.execute(args);
}

describe("memory_search", () => {
  it("recalls a fact stored by a previous session through the ordinary write tool", async () => {
    const root = await vaultRoot();
    const writer = new Agent({
      provider: new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "c1",
          name: "write",
          arguments: {
            path: "Test Runtime Convention.md",
            content: "---\nprovenance: agent\n---\nTests run on Node, not Bun.\n",
          },
        }),
        textTurn("Noted."),
      ]),
      tools: coreTools(root),
    });
    await writer.send("remember that tests run on Node");

    const store = openStore(root);
    const search = new MemorySearch(store);
    const recaller = new Agent({
      provider: new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "c2",
          name: "memory_search",
          arguments: { query: "tests node runtime" },
        }),
        textTurn("Tests run on Node."),
      ]),
      tools: coreTools(root, { store, search }),
    });
    await recaller.send("what runtime do tests use?");
    const results = recaller
      .history()
      .flatMap((message) => message.parts)
      .filter((part): part is ToolResultPart => part.type === "tool-result");
    const output = results.find((part) => part.callId === "c2")?.output ?? "";
    expect(output).toContain("[[Test Runtime Convention]]");
    expect(output).toContain("Tests run on Node, not Bun.");
    expect(results.every((part) => !part.isError)).toBe(true);
  });

  it("marks superseded hits and reports the retrieval source", async () => {
    const root = await vaultRoot();
    const store = openStore(root);
    await store.writeNote({ title: "Old Ratio Rule", body: "split 50/50\n", provenance: "user" });
    await store.writeNote({
      title: "New Ratio Rule",
      body: "split 60/40\n",
      provenance: "agent",
      supersedes: "Old Ratio Rule",
    });
    const output = await runTool(memorySearchTool(store, new MemorySearch(store)), {
      query: "ratio split rule",
    });
    expect(output).toContain("[[New Ratio Rule]]");
    expect(output).toContain("superseded by [[New Ratio Rule]]");
    expect(output.indexOf("[[New Ratio Rule]]")).toBeLessThan(output.indexOf("[[Old Ratio Rule]]"));
    expect(output).toContain("retrieval: lexical");
  });

  it("finds daily-log entries alongside notes", async () => {
    const root = await vaultRoot();
    const store = openStore(root);
    await store.appendDaily("Decided the sidebar collapses below 80 columns.", "agent");
    const output = await runTool(memorySearchTool(store, new MemorySearch(store)), {
      query: "sidebar collapses columns",
    });
    expect(output).toContain("daily/2026-08-10 14:30 [agent]");
    expect(output).toContain("sidebar collapses below 80 columns");
  });

  it("reports no matches without erroring on an unknown topic", async () => {
    const root = await vaultRoot();
    const store = openStore(root);
    await store.writeNote({ title: "Something", body: "unrelated\n", provenance: "user" });
    const output = await runTool(memorySearchTool(store, new MemorySearch(store)), {
      query: "quantum entanglement",
    });
    expect(output).toBe('no memories match "quantum entanglement"');
  });

  it("is inert over an untrusted vault", async () => {
    const root = await vaultRoot();
    const trusted = openStore(root);
    await trusted.writeNote({ title: "Secret Plan", body: "the payload\n", provenance: "user" });
    await trusted.appendDaily("payload in the daily log too", "user");
    const store = openStore(root, false);
    const output = await runTool(memorySearchTool(store, new MemorySearch(store)), {
      query: "secret plan",
    });
    expect(output).toBe('no memories match "secret plan"');
    expect(output).not.toContain("payload");
  });

  it("reports every hit to the recall listener, and nothing on a miss", async () => {
    const root = await vaultRoot();
    const store = openStore(root);
    await store.writeNote({ title: "Ratio Rule", body: "split 60/40\n", provenance: "agent" });
    const recalled: string[] = [];
    const tool = memorySearchTool(store, new MemorySearch(store), (name) => recalled.push(name));
    await runTool(tool, { query: "ratio split" });
    expect(recalled).toEqual(["Ratio Rule"]);
    await runTool(tool, { query: "quantum entanglement" });
    expect(recalled).toEqual(["Ratio Rule"]);
  });
});

describe("memory_get", () => {
  async function seededStore(): Promise<MemoryStore> {
    const store = openStore(await vaultRoot());
    await store.writeNote({
      title: "Layout Decision",
      body: "line one\nline two\nline three\n",
      provenance: "agent",
      pinned: true,
    });
    return store;
  }

  it("reads a note as numbered lines with a provenance header", async () => {
    const store = await seededStore();
    const output = await runTool(memoryGetTool(store), { note: "Layout Decision" });
    expect(output).toContain("[[Layout Decision]] · provenance: agent · pinned");
    expect(output).toContain("    1\tline one");
    expect(output).toContain("    3\tline three");
  });

  it("reads a line range and reports what remains", async () => {
    const store = await seededStore();
    const output = await runTool(memoryGetTool(store), {
      note: "Layout Decision",
      offset: 2,
      limit: 1,
    });
    expect(output).toContain("    2\tline two");
    expect(output).not.toContain("line one");
    expect(output).toContain("... (1 more lines)");
  });

  it("answers an out-of-range offset with the note length", async () => {
    const store = await seededStore();
    const output = await runTool(memoryGetTool(store), { note: "Layout Decision", offset: 99 });
    expect(output).toContain('"Layout Decision" has only 3 lines');
  });

  it("names the missing note instead of throwing", async () => {
    const store = await seededStore();
    const output = await runTool(memoryGetTool(store), { note: "Never Written" });
    expect(output).toBe('no note named "Never Written"');
  });

  it("reads a daily log by date", async () => {
    const store = await seededStore();
    await store.appendDaily("first fact", "agent");
    const output = await runTool(memoryGetTool(store), { note: "daily/2026-08-10" });
    expect(output).toContain("14:30 [agent] first fact");
  });

  it("is inert over an untrusted vault", async () => {
    const root = await vaultRoot();
    const trusted = openStore(root);
    await trusted.writeNote({ title: "Secret Plan", body: "the payload\n", provenance: "user" });
    await trusted.appendDaily("daily payload", "user");
    const store = openStore(root, false);
    expect(await runTool(memoryGetTool(store), { note: "Secret Plan" })).toBe(
      'no note named "Secret Plan"',
    );
    expect(await runTool(memoryGetTool(store), { note: "2026-08-10" })).toBe(
      "no daily log for 2026-08-10",
    );
  });
});

describe("tool registration", () => {
  it("keeps both recall tools read-only and named for the engine", async () => {
    const store = openStore(await vaultRoot());
    const tools = memoryRecallTools(store, new MemorySearch(store));
    expect(tools.map((tool) => tool.name)).toEqual(["memory_search", "memory_get"]);
    expect(tools.every((tool) => tool.mutates !== true)).toBe(true);
  });

  it("stays out of coreTools unless memory is supplied", async () => {
    const names = coreTools(".").map((tool) => tool.name);
    expect(names).not.toContain("memory_search");
    const store = openStore(await vaultRoot());
    const withMemory = coreTools(".", { store, search: new MemorySearch(store) });
    expect(withMemory.map((tool) => tool.name)).toContain("memory_get");
  });
});

describe("recall formatting", () => {
  it("keeps the recalled snippet to the first line", async () => {
    const root = await vaultRoot();
    const store = openStore(root);
    await store.writeNote({
      title: "Multiline Fact",
      body: "headline sentence\nsecond line detail\n",
      provenance: "user",
    });
    const output = await runTool(memorySearchTool(store, new MemorySearch(store)), {
      query: "headline sentence",
    });
    expect(output).toContain("headline sentence");
    expect(output).not.toContain("second line detail");
  });
});
