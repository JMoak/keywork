import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { messageText } from "../messages.ts";
import { SessionStore } from "./store.ts";

const piFixtureLines = [
  {
    type: "session",
    version: 3,
    id: "sess-0001",
    timestamp: "2026-08-01T09:00:00.000Z",
    cwd: "/home/dev/project",
    parentSession: "/home/dev/.sessions/earlier.jsonl",
  },
  {
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: "2026-08-01T09:00:01.000Z",
    message: { role: "user", parts: [{ type: "text", text: "add a parser" }] },
  },
  {
    type: "thinking_level_change",
    id: "e2",
    parentId: "e1",
    timestamp: "2026-08-01T09:00:02.000Z",
    thinkingLevel: "medium",
  },
  {
    type: "model_change",
    id: "e3",
    parentId: "e2",
    timestamp: "2026-08-01T09:00:03.000Z",
    provider: "acme",
    modelId: "acme-large",
  },
  {
    type: "message",
    id: "e4",
    parentId: "e3",
    timestamp: "2026-08-01T09:00:04.000Z",
    message: { role: "assistant", parts: [{ type: "text", text: "parser drafted" }] },
  },
  {
    type: "message",
    id: "e5",
    parentId: "e4",
    timestamp: "2026-08-01T09:00:05.000Z",
    message: { role: "assistant", parts: [{ type: "text", text: "abandoned attempt" }] },
  },
  {
    type: "branch_summary",
    id: "e6",
    parentId: "e4",
    timestamp: "2026-08-01T09:00:06.000Z",
    fromId: "e5",
    summary: "tried recursive descent, abandoned",
  },
  {
    type: "compaction",
    id: "e7",
    parentId: "e6",
    timestamp: "2026-08-01T09:00:07.000Z",
    summary: "## Goal\nbuild the parser",
    firstKeptEntryId: "e4",
    tokensBefore: 40000,
    details: { readFiles: ["src/parser.ts"], modifiedFiles: ["src/parser.ts"] },
    usage: { inputTokens: 900, outputTokens: 120 },
  },
  {
    type: "label",
    id: "e8",
    parentId: "e7",
    timestamp: "2026-08-01T09:00:08.000Z",
    targetId: "e4",
    label: "parser-done",
  },
  {
    type: "session_info",
    id: "e9",
    parentId: "e8",
    timestamp: "2026-08-01T09:00:09.000Z",
    name: "parser work",
  },
  {
    type: "custom",
    id: "e10",
    parentId: "e9",
    timestamp: "2026-08-01T09:00:10.000Z",
    customType: "some-extension",
    data: { anything: true },
  },
];

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-pi-fixture-"));
  tempDirs.push(dir);
  const file = join(dir, "pi-session.jsonl");
  await writeFile(file, piFixtureLines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");
  return file;
}

describe("Pi session format compatibility", () => {
  it("reads the header including version and parent session", async () => {
    const store = await SessionStore.open(await writeFixture());

    expect(store.header).toEqual(piFixtureLines[0]);
  });

  it("preserves every entry of Pi's version-3 vocabulary", async () => {
    const store = await SessionStore.open(await writeFixture());

    expect(store.entries().map((entry) => entry.type)).toEqual([
      "message",
      "thinking_level_change",
      "model_change",
      "message",
      "message",
      "branch_summary",
      "compaction",
      "label",
      "session_info",
      "custom",
    ]);
    expect(store.entries()).toEqual(piFixtureLines.slice(1));
  });

  it("resolves the tree with the branch point at e4", async () => {
    const store = await SessionStore.open(await writeFixture());

    const tree = store.tree();
    const e4 = findNode(tree, "e4");
    expect(e4?.children.map((child) => child.entry.id).sort()).toEqual(["e5", "e6"]);
    expect(e4?.label).toBe("parser-done");
  });

  it("builds context from the latest compaction: summary plus kept tail", async () => {
    const store = await SessionStore.open(await writeFixture());

    const texts = store.messages().map(messageText);
    expect(texts[0]).toBe("## Goal\nbuild the parser");
    expect(texts).toContain("parser drafted");
    expect(texts).not.toContain("add a parser");
    expect(texts).not.toContain("abandoned attempt");
  });

  it("surfaces labels, name, and stats from the fixture", async () => {
    const store = await SessionStore.open(await writeFixture());

    expect(store.labelFor("e4")).toBe("parser-done");
    expect(store.name()).toBe("parser work");
    expect(store.stats()).toEqual({
      entries: 10,
      messages: 3,
      userMessages: 1,
      branchPoints: 1,
      labels: 1,
      compactions: 1,
      usage: { inputTokens: 900, outputTokens: 120 },
      cost: { nanos: 0, pricedTurns: 0, meteredTurns: 0, unpricedTurns: 1 },
      createdAt: "2026-08-01T09:00:00.000Z",
      lastActivityAt: "2026-08-01T09:00:10.000Z",
    });
  });
});

interface NodeLike {
  entry: { id: string };
  children: NodeLike[];
  label?: string;
}

function findNode(nodes: NodeLike[], id: string): NodeLike | undefined {
  for (const node of nodes) {
    if (node.entry.id === id) return node;
    const found = findNode(node.children, id);
    if (found !== undefined) return found;
  }
  return undefined;
}
