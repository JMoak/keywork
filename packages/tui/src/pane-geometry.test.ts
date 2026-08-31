import { type SessionTreeNode, textMessage } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { BrowserPane } from "./browser-pane.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { contains, encloses, fullRect, type Rect, type Screen } from "./geometry.ts";
import { Layout } from "./layout.ts";
import { McpPane } from "./mcp-pane.ts";
import { MemoryPane } from "./memory-pane.ts";
import { emptyMemoryInputs } from "./memory-pane-model.ts";
import type { ChromeWeight, Pane, PaneIntents, PaneView } from "./pane.ts";
import {
  type ChromeExtent,
  hasHeaderRow,
  paneContentHeight,
  paneContentWidth,
} from "./pane-chrome.ts";
import { drawnRect } from "./pane-geometry.ts";
import { SessionTreePane } from "./session-tree-pane.ts";
import { resolveTheme } from "./theme.ts";
import { fieldOf, innerRect, seamCells } from "./view/seams.ts";

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
            createdAt: 0,
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
        layers: [{ id: "workspace", kind: "workspace", label: "workspace" }],
        notes: [
          {
            name: longName,
            title: longName,
            layer: "workspace",
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
    for (const chrome of chromeWeights) {
      for (const size of paneSizes.filter((candidate) => candidate.width >= 8)) {
        assertTextsFit(pane, { ...size, chrome });
      }
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

const chromeWeights: ChromeWeight[] = ["regular", "seams", "borderless"];

function assertFitsAtEverySize(pane: Pane): void {
  for (const chrome of chromeWeights) {
    for (const size of paneSizes) assertTextsFit(pane, { ...size, chrome });
  }
}

function assertTextsFit(pane: Pane, extent: Required<ChromeExtent>): void {
  const { width, height, chrome } = extent;
  const view = pane.view({ theme: resolveTheme(), focused: true, width, height, chrome });
  const texts = collectTexts(view);
  const contentWidth = paneContentWidth(extent);
  const place = `${pane.id} at ${width}x${height} (${chrome})`;
  for (const text of texts) {
    expect([...text].length, `"${text}" overflows ${place}`).toBeLessThanOrEqual(contentWidth);
  }
  expect(texts.length, place).toBeLessThanOrEqual(paneContentHeight(extent) + headerRowsOf(chrome));
}

function headerRowsOf(chrome: ChromeWeight | undefined): number {
  return hasHeaderRow(chrome) ? 1 : 0;
}

function collectTexts(view: PaneView): string[] {
  const texts: string[] = [];
  walk(view, texts);
  return texts;
}

function walk(node: unknown, into: string[]): void {
  if (node === null || typeof node !== "object") return;
  const record = node as { props?: { content?: unknown; position?: string }; children?: unknown[] };
  if (record.props?.position === "absolute") return;
  if (typeof record.props?.content === "string") into.push(record.props.content);
  if (Array.isArray(record.children)) {
    for (const child of record.children) walk(child, into);
  }
}

describe("gap cells ride the layout truth", () => {
  const screens: Screen[] = [
    { width: 120, height: 40 },
    { width: 80, height: 24 },
    { width: 41, height: 13 },
    { width: 20, height: 8 },
  ];
  const gaps = [0, 1, 2, 3, 4];

  function walkLayouts(visit: (layout: Layout, screen: Screen) => void): void {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (const screen of screens) {
      const layout = new Layout();
      for (let step = 0; step < 24; step += 1) {
        const roll = random();
        if (roll < 0.5) layout.open(`p${step}`, screen);
        else if (roll < 0.65) layout.dockFocused(random() < 0.5 ? "left" : "right", screen);
        else if (roll < 0.8) layout.resizeFocused((random() - 0.5) * 0.4);
        else if (roll < 0.9) layout.undockFocused(screen);
        else layout.growDock("left", (random() - 0.5) * 0.3);
        if (layout.panes().length > 0) visit(layout, screen);
      }
    }
  }

  function drawnRects(
    layout: Layout,
    screen: Screen,
    chrome: ChromeWeight,
    gap: number,
  ): Map<string, Rect> {
    const field = fullRect(screen);
    return new Map(
      [...layout.rects(screen)].map(([id, rect]) => [id, drawnRect(rect, field, { chrome, gap })]),
    );
  }

  it("gap 0 is byte-identical to the seam-trimmed or bare rect of today", () => {
    walkLayouts((layout, screen) => {
      const field = fullRect(screen);
      for (const [, rect] of layout.rects(screen)) {
        expect(drawnRect(rect, field, { chrome: "regular", gap: 0 })).toEqual(rect);
        expect(drawnRect(rect, field, { chrome: "borderless", gap: 0 })).toEqual(rect);
        expect(drawnRect(rect, field, { chrome: "seams", gap: 0 })).toEqual(innerRect(rect, field));
      }
    });
  });

  it("keeps every drawn rect inside its layout rect, overlap-free, with the gap on every inner edge", () => {
    walkLayouts((layout, screen) => {
      for (const chrome of chromeWeights) {
        for (const gap of gaps) {
          const drawn = [...drawnRects(layout, screen, chrome, gap)].filter(
            ([, rect]) => rect.width > 0 && rect.height > 0,
          );
          for (const [id, rect] of drawn) {
            expect(encloses(layout.rects(screen).get(id) as Rect, rect)).toBe(true);
          }
          for (const [a, one] of drawn) {
            for (const [b, other] of drawn) {
              if (a !== b) expect(separation(one, other)).toBeGreaterThanOrEqual(2 * gap);
            }
          }
          if (gap === 0) continue;
          for (const [id, rect] of drawn) {
            const laid = layout.rects(screen).get(id) as Rect;
            if (laid.x > 0) expect(rect.x - laid.x).toBe(gap);
            if (laid.y > 0) expect(rect.y - laid.y).toBe(gap);
            if (laid.x + laid.width < screen.width) {
              expect(laid.x + laid.width - (rect.x + rect.width)).toBe(
                gap + (chrome === "seams" ? 1 : 0),
              );
            }
          }
        }
      }
    });
  });

  it("hit-tests exactly through gaps: a drawn cell finds its pane, a gap cell finds none", () => {
    walkLayouts((layout, screen) => {
      if (layout.panes().length < 2) return;
      for (const gap of gaps) {
        const drawn = drawnRects(layout, screen, "regular", gap);
        const laid = layout.rects(screen);
        for (let y = 0; y < screen.height; y += 3) {
          for (let x = 0; x < screen.width; x += 3) {
            const owner = [...laid].find(([, rect]) => contains(rect, x, y))?.[0];
            const hit = [...drawn].filter(([, rect]) => contains(rect, x, y)).map(([id]) => id);
            expect(hit.length).toBeLessThanOrEqual(1);
            if (hit.length === 1) expect(hit[0]).toBe(owner);
          }
        }
      }
    });
  });
});

function separation(a: Rect, b: Rect): number {
  const dx = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.max(dx, dy);
}

describe("seams and drawn boxes agree on the same layout truth", () => {
  it("puts every seam cell outside every drawn box, touching the box it belongs to", () => {
    const screens: Screen[] = [
      { width: 120, height: 40 },
      { width: 41, height: 13 },
    ];
    for (const screen of screens) {
      const layout = new Layout();
      for (const id of ["a", "b", "c", "d"]) layout.open(id, screen);
      layout.dockFocused("left", screen);
      const field = fullRect(screen);
      const rects = layout.rects(screen);
      const drawn = new Map(
        [...rects].map(([id, rect]) => [id, drawnRect(rect, field, { chrome: "seams", gap: 0 })]),
      );
      for (const cell of seamCells(rects, fieldOf(screen, 0))) {
        for (const [, box] of drawn) expect(contains(box, cell.x, cell.y)).toBe(false);
        const owner = cell.owner === undefined ? undefined : drawn.get(cell.owner);
        if (owner === undefined) continue;
        const touchesRight =
          cell.x === owner.x + owner.width && cell.y < owner.y + owner.height + 1;
        const touchesBottom =
          cell.y === owner.y + owner.height && cell.x < owner.x + owner.width + 1;
        expect(touchesRight || touchesBottom).toBe(true);
      }
    }
  });
});
