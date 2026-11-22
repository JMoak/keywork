import { describe, expect, it } from "vitest";
import { BrowserModel, type Entry, type ReadDirectory, watchQuietMs } from "./browser-model.ts";
import type { DebounceTiming } from "./debounce.ts";
import { parseChord } from "./keys.ts";
import { pressModel as press } from "./testing/index.ts";

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
    { readDirectory: disk.read },
    () => {},
    (path) => opened.push(path),
  );
  await model.settled();
  return { model, disk, opened };
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

  it("accepts a space and keeps the typed case from the raw sequence", async () => {
    const { model } = await browserOver({ "My Notes.md": "file", "other.ts": "file" });
    press(model, "/");
    model.handleKey(parseChord("shift+m"), 5, "M");
    press(model, "y", "space");
    expect(model.filterQuery).toBe("My ");
    expect(model.rows().map((row) => row.name)).toEqual(["My Notes.md"]);
  });

  it("drops control sequences and modified chords from the query", async () => {
    const { model } = await browserOver(sampleTree);
    press(model, "/");
    expect(model.handleKey(parseChord("ctrl+a"), 5, "")).toBe(false);
    expect(model.handleKey(parseChord("tab"), 5, "\t")).toBe(false);
    expect(model.handleKey(parseChord("alt+x"), 5, "x")).toBe(false);
    expect(model.filterQuery).toBe("");
  });
});

describe("BrowserModel modifier guard", () => {
  it("ignores shifted and control chords outside the filter", async () => {
    const { model, disk } = await browserOver(sampleTree);
    expect(model.handleKey(parseChord("ctrl+r"), 5)).toBe(false);
    expect(model.handleKey(parseChord("shift+j"), 5)).toBe(false);
    await model.settled();
    expect(disk.reads.get("root")).toBe(1);
    expect(model.cursor).toBe(0);
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
      { readDirectory: disk.read },
      () => {},
      () => {},
    );
    await model.settled();
    await pressSettled(model, "l");
    expect(model.rows()[0]).toMatchObject({ name: "broken", load: "failed", failure: "EACCES" });
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
      { readDirectory: read },
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

  it("orders names by locale, not code units", async () => {
    const { model } = await browserOver({ "z.ts": "file", "é.ts": "file" });
    expect(model.rows().map((row) => row.name)).toEqual(["é.ts", "z.ts"]);
  });
});

describe("BrowserModel gitignore awareness", () => {
  const repo: Tree = {
    ".gitignore": "file",
    dist: { "bundle.js": "file", "keep.txt": "file" },
    src: { ".gitignore": "file", "app.ts": "file", "types.gen.ts": "file" },
    "app.log": "file",
    "main.ts": "file",
  };
  const ignoreFiles: Record<string, string> = {
    [join("root", ".gitignore")]: "dist/\n*.log\n!keep.txt\n",
    [join("root", "src", ".gitignore")]: "*.gen.ts\n",
  };

  async function repoBrowser() {
    const disk = fakeDisk(repo);
    const opened: string[] = [];
    const ignoreReads: string[] = [];
    const model = new BrowserModel(
      "root",
      {
        readDirectory: disk.read,
        readIgnoreFile: async (path) => {
          ignoreReads.push(path);
          const text = ignoreFiles[path];
          if (text === undefined) throw new Error(`no ignore file at ${path}`);
          return text;
        },
      },
      () => {},
      (path) => opened.push(path),
    );
    await model.settled();
    return { model, opened, ignoreReads, disk };
  }

  it("marks matching entries ignored without hiding them", async () => {
    const { model, ignoreReads } = await repoBrowser();
    expect(ignoreReads).toEqual([join("root", ".gitignore")]);
    expect(model.rows().map((row) => [row.name, row.ignored])).toEqual([
      ["dist", true],
      ["src", false],
      ["app.log", true],
      ["main.ts", false],
    ]);
  });
});

describe("BrowserModel disk watch", () => {
  function fakeTiming() {
    let clock = 0;
    const armed: Array<{ dueAt: number; run: () => void; live: boolean }> = [];
    const timing: DebounceTiming = {
      now: () => clock,
      after: (delayMs, run) => {
        const entry = { dueAt: clock + delayMs, run, live: true };
        armed.push(entry);
        return () => {
          entry.live = false;
        };
      },
    };
    const advanceTo = (time: number): void => {
      clock = time;
      for (const entry of [...armed]) {
        if (entry.live && entry.dueAt <= clock) {
          entry.live = false;
          entry.run();
        }
      }
    };
    return { timing, advanceTo };
  }

  async function watchedBrowser(tree: Tree) {
    const disk = fakeDisk(tree);
    const watchers = new Map<string, () => void>();
    const closed: string[] = [];
    const { timing, advanceTo } = fakeTiming();
    const model = new BrowserModel(
      "root",
      {
        readDirectory: disk.read,
        watchDirectory: (path, onChange) => {
          watchers.set(path, onChange);
          return () => closed.push(path);
        },
      },
      () => {},
      () => {},
      timing,
    );
    await model.settled();
    const change = (path: string): void => watchers.get(path)?.();
    return { model, disk, watchers, closed, change, advanceTo };
  }

  it("watches each loaded directory and reloads once after a burst settles", async () => {
    const tree: Tree = { src: { "a.ts": "file" }, "main.ts": "file" };
    const { model, disk, watchers, change, advanceTo } = await watchedBrowser(tree);
    await pressSettled(model, "l");
    expect([...watchers.keys()]).toEqual(["root", join("root", "src")]);
    tree["new.ts"] = "file";
    change("root");
    advanceTo(50);
    change(join("root", "src"));
    advanceTo(100);
    change("root");
    advanceTo(100 + watchQuietMs - 1);
    await model.settled();
    expect(disk.reads.get("root")).toBe(1);
    advanceTo(100 + watchQuietMs);
    await model.settled();
    expect(disk.reads.get("root")).toBe(2);
    expect(disk.reads.get(join("root", "src"))).toBe(2);
    expect(model.rows().map((row) => row.name)).toEqual(["src", "a.ts", "main.ts", "new.ts"]);
  });

  it("closes watchers on refresh and dispose", async () => {
    const { model, closed, change, advanceTo } = await watchedBrowser({ "a.ts": "file" });
    await pressSettled(model, "r");
    expect(closed).toEqual(["root"]);
    model.dispose();
    expect(closed).toEqual(["root", "root"]);
    change("root");
    advanceTo(watchQuietMs * 2);
    await model.settled();
    expect(closed).toHaveLength(2);
  });
});
