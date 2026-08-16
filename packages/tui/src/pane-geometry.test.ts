import { type SessionTreeNode, textMessage } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { BrowserPane } from "./browser-pane.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { McpPane } from "./mcp-pane.ts";
import { MemoryPane } from "./memory-pane.ts";
import { emptyMemoryInputs } from "./memory-pane-model.ts";
import type { Pane, PaneIntents, PaneView } from "./pane.ts";
import { paneContentHeight, paneContentWidth } from "./pane-chrome.ts";
import { SessionTreePane } from "./session-tree-pane.ts";
import { resolveTheme } from "./theme.ts";

const paneSizes = [
  { width: 5, height: 3 },
  { width: 8, height: 4 },
  { width: 11, height: 5 },
  { width: 17, height: 7 },
  { width: 29, height: 9 },
  { width: 60, height: 20 },
  { width: 118, height: 31 },
];

const longName = "an-extremely-long-entry-name-that-must-never-escape-its-pane-box.txt";

const inertIntents: PaneIntents = {
  openFile: () => {},
  openSession: () => {},
  focusPane: () => {},
};

describe("pane content stays inside the chrome at every drawable size", () => {
  it("session overview and tree rows fit", async () => {
    const pane = new SessionTreePane(
      "tree-1",
      () => {},
      inertIntents,
      {
        overview: async () => [
          {
            id: "sess",
            title: `${longName} ${longName}`,
            modifiedAt: 1,
            entryCount: 123,
            branchCount: 45,
            labelCount: 6,
            arc: longName,
          },
        ],
        load: async () => ({
          sessionId: "sess",
          roots: [treeNode("e1", `${longName} ${longName}`, [treeNode("e2", longName)])],
        }),
        setLabel: async () => {},
        fork: async () => undefined,
      },
      () => "sess",
    );
    await pane.settled();
    assertFitsAtEverySize(pane);
    pane.handleKey({ name: "l", ctrl: false, shift: false, meta: false });
    await pane.settled();
    assertFitsAtEverySize(pane);
  });

  it("an empty session overview keeps its calm zero-state inside the chrome", async () => {
    const pane = new SessionTreePane(
      "tree-1",
      () => {},
      inertIntents,
      {
        overview: async () => [],
        load: async () => undefined,
        setLabel: async () => {},
        fork: async () => undefined,
      },
      () => undefined,
    );
    await pane.settled();
    assertFitsAtEverySize(pane);
  });

  it("mcp rows fit", async () => {
    const pane = new McpPane("mcp-1", () => {}, {
      load: async () => [
        { name: longName, state: "connected", toolCount: 12 },
        { name: "linear", state: "down", toolCount: 0, lastError: `spawn ENOENT ${longName}` },
      ],
      restart: async () => {},
      setEnabled: async () => {},
      listTools: async () => [],
    });
    await pane.settled();
    assertFitsAtEverySize(pane);
  });

  it("memory rows fit", async () => {
    const pane = new MemoryPane("memory-1", () => {}, {
      load: async () => ({
        ...emptyMemoryInputs,
        scopes: ["workspace"],
        notes: [
          {
            name: longName,
            title: longName,
            scope: "workspace",
            provenance: "agent",
            curing: 3,
            links: [],
            aliases: [],
          },
        ],
      }),
      approve: async () => {},
      discard: async () => {},
    });
    await pane.settled();
    assertFitsAtEverySize(pane);
  });

  it("browser rows fit", async () => {
    const pane = new BrowserPane(
      "browser-1",
      "/workspace",
      () => {},
      inertIntents,
      async () => [
        { name: longName, kind: "file" },
        { name: `${longName}-dir`, kind: "dir" },
      ],
    );
    await pane.settled();
    assertFitsAtEverySize(pane);
  });

  it("conversation transcript wraps to the pane with the width floor removed", () => {
    const pane = new ConversationPane("session-1", undefined, () => {});
    for (const size of paneSizes.filter((candidate) => candidate.width >= 8)) {
      assertTextsFit(pane, size.width, size.height);
    }
  });
});

function treeNode(id: string, text: string, children: SessionTreeNode[] = []): SessionTreeNode {
  return {
    entry: {
      id,
      parentId: null,
      timestamp: "2026-08-15T00:00:00Z",
      type: "message",
      message: textMessage("user", text),
    },
    children,
    onActivePath: true,
  };
}

function assertFitsAtEverySize(pane: Pane): void {
  for (const size of paneSizes) assertTextsFit(pane, size.width, size.height);
}

function assertTextsFit(pane: Pane, width: number, height: number): void {
  const view = pane.view({ theme: resolveTheme(), focused: true, width, height });
  const texts = collectTexts(view);
  const contentWidth = paneContentWidth(width);
  const place = `${pane.id} at ${width}x${height}`;
  for (const text of texts) {
    expect([...text].length, `"${text}" overflows ${place}`).toBeLessThanOrEqual(contentWidth);
  }
  expect(texts.length, place).toBeLessThanOrEqual(paneContentHeight(height));
}

function collectTexts(view: PaneView): string[] {
  const texts: string[] = [];
  walk(view, texts);
  return texts;
}

function walk(node: unknown, into: string[]): void {
  if (node === null || typeof node !== "object") return;
  const record = node as { props?: { content?: unknown }; children?: unknown[] };
  if (typeof record.props?.content === "string") into.push(record.props.content);
  if (Array.isArray(record.children)) {
    for (const child of record.children) walk(child, into);
  }
}
