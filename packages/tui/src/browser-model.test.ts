import { describe, expect, it } from "vitest";
import { BrowserModel, type Entry, type ReadDirectory } from "./browser-model.ts";
import { parseChord } from "./keys.ts";

type Tree = { [name: string]: Tree | "file" };

function fakeDisk(tree: Tree) {
  const reads = new Map<string, number>();
  const read: ReadDirectory = async (path) => {
    reads.set(path, (reads.get(path) ?? 0) + 1);
    const node = lookup(tree, path);
    if (node === undefined || node === "file") throw new Error(`not a directory: ${path}`);
    return Object.entries(node).map(([name, child]) => ({
      name,
      kind: child === "file" ? ("file" as const) : ("dir" as const),
    }));
  };
  return { read, reads };
}

function lookup(tree: Tree, path: string): Tree | "file" | undefined {
  let node: Tree | "file" | undefined = tree;
  for (const segment of path.split(/[\\/]/).slice(1)) {
    if (node === undefined || node === "file") return undefined;
    node = node[segment];
  }
  return node;
}

async function browserOver(tree: Tree) {
  const disk = fakeDisk(tree);
  const opened: string[] = [];
  const model = new BrowserModel(
    "root",
    disk.read,
    () => {},
    (path) => opened.push(path),
  );
  await model.settled();
  return { model, disk, opened };
}

function press(model: BrowserModel, ...specs: string[]): void {
  for (const spec of specs) model.handleKey(parseChord(spec), 5);
}

async function pressSettled(model: BrowserModel, ...specs: string[]): Promise<void> {
  press(model, ...specs);
  model.rows();
  await model.settled();
}

const sampleTree: Tree = {
  src: { "b.ts": "file", "a.ts": "file", nested: { "deep.ts": "file" } },
  docs: { "readme.md": "file" },
  ".hidden": { "secret.ts": "file" },
  "zeta.ts": "file",
  "Alpha.ts": "file",
  ".env": "file",
};

describe("BrowserModel ordering and visibility", () => {
  it("lists directories first, then files, alphabetical case-insensitive", async () => {
    const { model } = await browserOver(sampleTree);
    expect(model.rows().map((row) => row.name)).toEqual(["docs", "src", "Alpha.ts", "zeta.ts"]);
  });

  it("hides dotfiles until toggled, then marks them hidden", async () => {
    const { model } = await browserOver(sampleTree);
    press(model, ".");
    const names = model.rows().map((row) => row.name);
    expect(names).toEqual([".hidden", "docs", "src", ".env", "Alpha.ts", "zeta.ts"]);
    expect(model.rows().map((row) => row.hidden)).toEqual([true, false, false, true, false, false]);
    press(model, ".");
    expect(model.rows().map((row) => row.name)).toEqual(["docs", "src", "Alpha.ts", "zeta.ts"]);
  });

  it("indents children by depth with expansion flags", async () => {
    const { model } = await browserOver(sampleTree);
    await pressSettled(model, "j", "l");
    const rows = model.rows();
    expect(rows.map((row) => [row.name, row.depth])).toEqual([
      ["docs", 0],
      ["src", 0],
      ["nested", 1],
      ["a.ts", 1],
      ["b.ts", 1],
      ["Alpha.ts", 0],
      ["zeta.ts", 0],
    ]);
    expect(rows[1]?.expanded).toBe(true);
    expect(rows[2]?.expanded).toBe(false);
  });
});

describe("BrowserModel expansion laziness", () => {
  it("reads a directory exactly once until refresh", async () => {
    const { model, disk } = await browserOver(sampleTree);
    await pressSettled(model, "j", "l");
    model.rows();
    model.rows();
    press(model, "h");
    await pressSettled(model, "l");
    expect(disk.reads.get("root")).toBe(1);
    expect(disk.reads.get(join("root", "src"))).toBe(1);
    expect(disk.reads.has(join("root", "src", "nested"))).toBe(false);
  });

  it("re-reads only surviving expanded directories on refresh", async () => {
    const { model, disk } = await browserOver(sampleTree);
    await pressSettled(model, "j", "l");
    await pressSettled(model, "r");
    expect(disk.reads.get("root")).toBe(2);
    expect(disk.reads.get(join("root", "src"))).toBe(2);
    expect(disk.reads.get(join("root", "docs"))).toBeUndefined();
  });
});

describe("BrowserModel cursor", () => {
  it("moves with j/k and arrows, clamped to the rows", async () => {
    const { model } = await browserOver(sampleTree);
    press(model, "k");
    expect(model.cursor).toBe(0);
    press(model, "j", "j", "down");
    expect(model.cursor).toBe(3);
    press(model, "j");
    expect(model.cursor).toBe(3);
    press(model, "up", "k");
    expect(model.cursor).toBe(1);
  });

  it("pages by the given row count", async () => {
    const { model } = await browserOver(sampleTree);
    model.handleKey(parseChord("pagedown"), 2);
    expect(model.cursor).toBe(2);
    model.handleKey(parseChord("pageup"), 2);
    expect(model.cursor).toBe(0);
  });

  it("h collapses an expanded dir, or jumps to the parent row", async () => {
    const { model } = await browserOver(sampleTree);
    await pressSettled(model, "j", "l");
    press(model, "j", "j");
    expect(model.rows()[model.cursor]?.name).toBe("a.ts");
    press(model, "h");
    expect(model.rows()[model.cursor]?.name).toBe("src");
    press(model, "h");
    expect(model.rows()[model.cursor]?.expanded).toBe(false);
    expect(model.rows().map((row) => row.name)).toEqual(["docs", "src", "Alpha.ts", "zeta.ts"]);
  });

  it("stays on the collapsed dir when the rows below it vanish", async () => {
    const { model } = await browserOver(sampleTree);
    await pressSettled(model, "j", "l");
    press(model, "j", "h", "h");
    expect(model.rows()[model.cursor]?.name).toBe("src");
  });

  it("survives a refresh that removes the row under it", async () => {
    const tree: Tree = { "a.ts": "file", "b.ts": "file", "c.ts": "file" };
    const { model } = await browserOver(tree);
    press(model, "j", "j");
    delete tree["c.ts"];
    await pressSettled(model, "r");
    expect(model.rows()[model.cursor]?.name).toBe("b.ts");
  });
});

describe("BrowserModel filter", () => {
  it("starts with slash, narrows by subsequence, and escape clears", async () => {
    const { model } = await browserOver(sampleTree);
    press(model, "/", "s", "c");
    expect(model.rows().map((row) => row.name)).toEqual(["src"]);
    press(model, "escape");
    expect(model.filtering).toBe(false);
    expect(model.rows()).toHaveLength(4);
  });

  it("routes j/k into the query while filtering, and commits on enter", async () => {
    const { model } = await browserOver({ "jjkjk.ts": "file", "other.ts": "file" });
    press(model, "/", "j", "j", "k");
    expect(model.cursor).toBe(0);
    expect(model.rows().map((row) => row.name)).toEqual(["jjkjk.ts"]);
    press(model, "enter");
    expect(model.filtering).toBe(false);
    expect(model.filterQuery).toBe("jjk");
    press(model, "escape");
    expect(model.filterQuery).toBe("");
  });

  it("edits with backspace and matches case-insensitively", async () => {
    const { model } = await browserOver(sampleTree);
    press(model, "/", "a", "l", "x", "backspace");
    expect(model.rows().map((row) => row.name)).toEqual(["Alpha.ts"]);
  });

  it("clamps the cursor when the filter narrows past it", async () => {
    const { model } = await browserOver(sampleTree);
    press(model, "j", "j", "j", "/", "d");
    expect(model.rows()[model.cursor]?.name).toBe("docs");
  });
});

describe("BrowserModel open intent", () => {
  it("fires for files on enter or l, never for dirs", async () => {
    const { model, opened } = await browserOver(sampleTree);
    press(model, "enter", "l");
    expect(opened).toEqual([]);
    press(model, "j", "j", "enter", "l");
    expect(opened).toEqual([join("root", "Alpha.ts"), join("root", "Alpha.ts")]);
  });
});

describe("BrowserModel failure", () => {
  it("marks a directory that fails to read without throwing", async () => {
    const disk = {
      read: async (path: string): Promise<Entry[]> => {
        if (path === "root") return [{ name: "broken", kind: "dir" }];
        throw new Error("EACCES");
      },
    };
    const model = new BrowserModel(
      "root",
      disk.read,
      () => {},
      () => {},
    );
    await model.settled();
    await pressSettled(model, "l");
    expect(model.rows()[0]).toMatchObject({ name: "broken", load: "failed", failure: "EACCES" });
  });

  it("surfaces a root read failure", async () => {
    const model = new BrowserModel(
      "root",
      async () => {
        throw new Error("ENOENT");
      },
      () => {},
      () => {},
    );
    await model.settled();
    expect(model.rootFailure()).toBe("ENOENT");
    expect(model.rows()).toEqual([]);
  });
});

describe("BrowserModel windowing", () => {
  it("keeps the cursor inside the window and clamps the scroll", async () => {
    const tree: Tree = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`f${String(index).padStart(2, "0")}.ts`, "file"]),
    );
    const { model } = await browserOver(tree);
    model.scrollTop = 99;
    expect(model.visibleRows(5)[0]?.index).toBe(0);
    for (let step = 0; step < 9; step += 1) press(model, "j");
    const window = model.visibleRows(5);
    expect(window.map(({ index }) => index)).toEqual([5, 6, 7, 8, 9]);
    expect(window.some(({ index }) => index === model.cursor)).toBe(true);
    press(model, "k", "k", "k", "k", "k", "k");
    expect(model.visibleRows(5)[0]?.index).toBe(3);
  });
});

describe("BrowserModel property: cursor always lands on a visible row", () => {
  it("holds for any random op sequence", async () => {
    const tree: Tree = {
      src: { nested: { "deep.ts": "file", inner: { "core.ts": "file" } }, "a.ts": "file" },
      docs: { "readme.md": "file" },
      ".config": { "settings.json": "file" },
      "main.ts": "file",
      ".env": "file",
    };
    const { model } = await browserOver(tree);
    const ops = ["j", "k", "h", "l", "enter", ".", "r", "/", "escape", "pagedown", "pageup", "s"];
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let step = 0; step < 300; step += 1) {
      const op = ops[Math.floor(random() * ops.length)] as string;
      await pressSettled(model, op);
      const rows = model.rows();
      model.visibleRows(4);
      if (rows.length === 0) {
        expect(model.cursor).toBe(0);
      } else {
        expect(model.rows()[model.cursor]).toBeDefined();
      }
    }
  });
});

function join(...segments: string[]): string {
  return segments.join(sep);
}

const sep = process.platform === "win32" ? "\\" : "/";

describe("BrowserModel refresh and caching", () => {
  it("ignores reads that started before a refresh", async () => {
    const waiters = new Map<string, ((entries: Entry[]) => void)[]>();
    const read: ReadDirectory = (path) =>
      new Promise((resolve) => {
        const queue = waiters.get(path) ?? [];
        queue.push(resolve);
        waiters.set(path, queue);
      });
    const model = new BrowserModel(
      "root",
      read,
      () => {},
      () => {},
    );
    press(model, "r");
    const [stale, fresh] = waiters.get("root") ?? [];
    fresh?.([{ name: "fresh.ts", kind: "file" }]);
    stale?.([{ name: "stale.ts", kind: "file" }]);
    await model.settled();
    expect(model.rows().map((row) => row.name)).toEqual(["fresh.ts"]);
  });

  it("reuses the built rows until the tree changes", async () => {
    const { model } = await browserOver(sampleTree);
    const first = model.rows();
    expect(model.rows()).toBe(first);
    press(model, ".");
    expect(model.rows()).not.toBe(first);
  });

  it("orders names by locale, not code units", async () => {
    const { model } = await browserOver({ "z.ts": "file", "é.ts": "file" });
    expect(model.rows().map((row) => row.name)).toEqual(["é.ts", "z.ts"]);
  });
});
