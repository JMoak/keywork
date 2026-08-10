import { type SessionTreeNode, textMessage } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import { SessionTreeModel, type SessionTreeView } from "./session-tree-model.ts";

interface NodeSpec {
  id: string;
  text?: string;
  label?: string;
  active?: boolean;
  children?: NodeSpec[];
}

function treeOf(specs: NodeSpec[], parentId: string | null = null): SessionTreeNode[] {
  return specs.map((spec) => ({
    entry: {
      type: "message",
      id: spec.id,
      parentId,
      timestamp: "",
      message: textMessage("user", spec.text ?? spec.id),
    },
    children: treeOf(spec.children ?? [], spec.id),
    onActivePath: spec.active ?? false,
    ...(spec.label !== undefined && { label: spec.label }),
  }));
}

function viewOf(specs: NodeSpec[]): SessionTreeView {
  return { sessionId: "s1", name: "fixture", roots: treeOf(specs) };
}

const branchy: NodeSpec[] = [
  {
    id: "a",
    active: true,
    children: [
      {
        id: "b",
        active: true,
        children: [
          {
            id: "c",
            active: true,
            children: [
              { id: "d1", active: true, label: "main", children: [{ id: "e1", active: true }] },
              { id: "d2", label: "alt" },
            ],
          },
        ],
      },
    ],
  },
];

interface Recorded {
  refreshes: number;
  forks: string[];
  labels: [string, string | undefined][];
}

function modelOver(specs: NodeSpec[]) {
  const recorded: Recorded = { refreshes: 0, forks: [], labels: [] };
  const model = new SessionTreeModel(() => {}, {
    refresh: () => {
      recorded.refreshes += 1;
    },
    fork: (entryId) => recorded.forks.push(entryId),
    setLabel: (entryId, label) => recorded.labels.push([entryId, label]),
  });
  model.setView(viewOf(specs));
  return { model, recorded };
}

function press(model: SessionTreeModel, ...specs: string[]): void {
  for (const spec of specs) model.handleKey(parseChord(spec), 5);
}

describe("SessionTreeModel flattening", () => {
  it("keeps linear chains flat and indents only under branch points", () => {
    const { model } = modelOver(branchy);
    expect(model.rows().map((row) => [row.id, row.depth])).toEqual([
      ["a", 0],
      ["b", 0],
      ["c", 0],
      ["d1", 1],
      ["e1", 1],
      ["d2", 1],
    ]);
  });

  it("marks the active path, branch points, and labels", () => {
    const { model } = modelOver(branchy);
    const byId = new Map(model.rows().map((row) => [row.id, row]));
    expect(byId.get("c")?.branchPoint).toBe(true);
    expect(byId.get("d2")?.onActivePath).toBe(false);
    expect(byId.get("e1")?.onActivePath).toBe(true);
    expect(byId.get("d1")?.label).toBe("main");
    expect(byId.get("d2")?.label).toBe("alt");
  });

  it("shows duplicate labels on every row that carries them", () => {
    const { model } = modelOver([{ id: "x", label: "wip", children: [{ id: "y", label: "wip" }] }]);
    expect(model.rows().map((row) => row.label)).toEqual(["wip", "wip"]);
  });
});

describe("SessionTreeModel navigation and collapse", () => {
  it("moves with j/k and clamps at the edges", () => {
    const { model } = modelOver(branchy);
    press(model, "k");
    expect(model.cursor).toBe(0);
    press(model, "j", "j", "down", "up");
    expect(model.cursor).toBe(2);
    press(model, "pagedown", "pagedown");
    expect(model.cursor).toBe(5);
  });

  it("h collapses a subtree, l expands it, enter toggles", () => {
    const { model } = modelOver(branchy);
    press(model, "j", "j", "h");
    expect(model.rows().map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(model.cursorRow()?.collapsed).toBe(true);
    press(model, "l");
    expect(model.rows()).toHaveLength(6);
    press(model, "enter");
    expect(model.rows()).toHaveLength(3);
    press(model, "enter");
    expect(model.rows()).toHaveLength(6);
  });

  it("h on a leaf jumps to its parent entry", () => {
    const { model } = modelOver(branchy);
    press(model, "pagedown");
    expect(model.cursorRow()?.id).toBe("d2");
    press(model, "h");
    expect(model.cursorRow()?.id).toBe("c");
  });

  it("keeps the cursored row through a collapse elsewhere", () => {
    const { model } = modelOver(branchy);
    press(model, "j");
    const before = model.cursorRow()?.id;
    model.handleKey(parseChord("enter"), 5);
    expect(model.cursorRow()?.id).toBe(before);
  });

  it("windowed rendering keeps the cursor inside the viewport", () => {
    const { model } = modelOver(branchy);
    press(model, "pagedown");
    const visible = model.visibleRows(2);
    expect(visible.some(({ index }) => index === model.cursor)).toBe(true);
    expect(visible).toHaveLength(2);
  });
});

describe("SessionTreeModel effects", () => {
  it("r asks for a refresh", () => {
    const { model, recorded } = modelOver(branchy);
    press(model, "r");
    expect(recorded.refreshes).toBe(1);
  });

  it("f forks from the cursored entry", () => {
    const { model, recorded } = modelOver(branchy);
    press(model, "j", "f");
    expect(recorded.forks).toEqual(["b"]);
  });

  it("f on an empty session does nothing", () => {
    const { model, recorded } = modelOver([]);
    press(model, "f", "j", "h", "l", "enter");
    expect(recorded.forks).toEqual([]);
    expect(model.rows()).toEqual([]);
  });
});

describe("SessionTreeModel labeling", () => {
  it("shift+l prefills the existing label and enter commits the edit", () => {
    const { model, recorded } = modelOver(branchy);
    press(model, "pagedown");
    press(model, "shift+l");
    expect(model.labelDraft).toBe("alt");
    press(model, "backspace", "backspace", "backspace", "w", "i", "p", "enter");
    expect(recorded.labels).toEqual([["d2", "wip"]]);
    expect(model.labeling).toBe(false);
  });

  it("committing an empty draft clears the label", () => {
    const { model, recorded } = modelOver(branchy);
    press(model, "pagedown", "shift+l", "backspace", "backspace", "backspace", "enter");
    expect(recorded.labels).toEqual([["d2", undefined]]);
  });

  it("escape cancels without touching the label", () => {
    const { model, recorded } = modelOver(branchy);
    press(model, "shift+l", "x", "escape");
    expect(recorded.labels).toEqual([]);
    expect(model.labeling).toBe(false);
    press(model, "j");
    expect(model.cursor).toBe(1);
  });

  it("navigation keys spell into the draft instead of moving", () => {
    const { model } = modelOver(branchy);
    press(model, "shift+l", "j", "k");
    expect(model.labelDraft).toBe("jk");
    expect(model.cursor).toBe(0);
    press(model, "escape");
  });
});

describe("SessionTreeModel refresh survival", () => {
  it("keeps the cursor on the same entry when the tree grows", () => {
    const { model } = modelOver(branchy);
    press(model, "j", "j");
    model.setView(viewOf([{ id: "new-root", children: branchy }]));
    expect(model.cursorRow()?.id).toBe("c");
  });

  it("clamps to the nearest surviving row when the cursored entry vanishes", () => {
    const { model } = modelOver(branchy);
    press(model, "pagedown");
    expect(model.cursorRow()?.id).toBe("d2");
    model.setView(viewOf([{ id: "a", children: [{ id: "b" }] }]));
    expect(model.cursor).toBeLessThan(model.rows().length);
    expect(model.cursorRow()).toBeDefined();
  });

  it("survives the tree emptying and repopulating", () => {
    const { model } = modelOver(branchy);
    press(model, "j");
    model.setView(viewOf([]));
    expect(model.cursorRow()).toBeUndefined();
    model.setView(viewOf([{ id: "solo" }]));
    expect(model.cursorRow()?.id).toBe("solo");
  });
});

describe("SessionTreeModel property: cursor always lands on a visible row", () => {
  it("holds for any random op sequence over a deep unbalanced tree", () => {
    const deep = (depth: number): NodeSpec[] => {
      if (depth === 0) return [{ id: "leaf" }];
      const chain: NodeSpec = { id: `n${depth}`, children: deep(depth - 1) };
      return depth % 7 === 0 ? [chain, { id: `side${depth}` }] : [chain];
    };
    const full = deep(40);
    const pruned = deep(23);
    let alternate = false;
    const model = new SessionTreeModel(() => {}, {
      refresh: () => {
        alternate = !alternate;
        model.setView(viewOf(alternate ? pruned : full));
      },
      fork: () => {},
      setLabel: () => {},
    });
    model.setView(viewOf(full));
    const ops = [
      "j",
      "k",
      "h",
      "l",
      "enter",
      "r",
      "f",
      "pagedown",
      "pageup",
      "shift+l",
      "escape",
      "x",
    ];
    let seed = 11;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let step = 0; step < 400; step += 1) {
      press(model, ops[Math.floor(random() * ops.length)] as string);
      const rows = model.rows();
      const visible = model.visibleRows(4);
      if (rows.length === 0) continue;
      expect(model.cursor).toBeGreaterThanOrEqual(0);
      expect(model.cursor).toBeLessThan(rows.length);
      expect(visible.some(({ index }) => index === model.cursor)).toBe(true);
    }
  });
});
