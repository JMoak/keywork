import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrowserDisk, Entry } from "./browser-model.ts";
import { FileIndex, fileIndexLimits, fileJumpSource, fileJumpsAllowed } from "./file-index.ts";
import { AppProbe } from "./probe.ts";
import { paneIds, stubFilePane } from "./testing/workflow-probe.ts";

type Tree = { [name: string]: Tree | string };

function diskOver(tree: Tree) {
  const reads: string[] = [];
  const lookup = (path: string): Tree | string | undefined => {
    let node: Tree | string | undefined = tree;
    for (const segment of path.split(/[\\/]/).slice(1)) {
      if (node === undefined || typeof node === "string") return undefined;
      node = node[segment];
    }
    return node;
  };
  const disk: BrowserDisk = {
    readDirectory: async (path) => {
      reads.push(path);
      const node = lookup(path);
      if (node === undefined || typeof node === "string") throw new Error(`not a dir: ${path}`);
      return Object.entries(node).map(
        ([name, child]): Entry => ({ name, kind: typeof child === "string" ? "file" : "dir" }),
      );
    },
    readIgnoreFile: async (path) => {
      const node = lookup(path);
      if (typeof node !== "string") throw new Error(`no ignore file at ${path}`);
      return node;
    },
  };
  return { disk, reads };
}

async function indexOver(tree: Tree, limits = fileIndexLimits) {
  const { disk, reads } = diskOver(tree);
  const index = new FileIndex("root", disk, () => {}, limits);
  return {
    index,
    reads,
    relatives: async () => (await settledEntries(index)).map((f) => f.relative),
  };
}

async function settledEntries(index: FileIndex) {
  index.ensure();
  await index.settled();
  return index.entries();
}

describe("FileIndex walk", () => {
  it("lists files breadth-first, directories first within a level, skipping .git", async () => {
    const { relatives } = await indexOver({
      src: { "b.ts": "", "a.ts": "", nested: { "deep.ts": "" } },
      ".git": { HEAD: "" },
      "readme.md": "",
    });
    expect(await relatives()).toEqual(["readme.md", "src/a.ts", "src/b.ts", "src/nested/deep.ts"]);
  });

  it("builds lazily: nothing is read until the entries are asked for", async () => {
    const { index, reads } = await indexOver({ "a.ts": "" });
    expect(reads).toEqual([]);
    expect(index.entries()).toEqual([]);
    await index.settled();
    expect(reads).toEqual(["root"]);
    expect(index.entries().map((file) => file.path)).toEqual([join("root", "a.ts")]);
  });

  it("leaves out gitignored files and never descends into ignored directories", async () => {
    const { relatives, reads } = await indexOver({
      ".gitignore": "dist/\n*.log\n",
      dist: { "bundle.js": "" },
      src: { ".gitignore": "*.gen.ts\n", "app.ts": "", "types.gen.ts": "" },
      "app.log": "",
    });
    expect(await relatives()).toEqual([".gitignore", "src/.gitignore", "src/app.ts"]);
    expect(reads).not.toContain(join("root", "dist"));
  });

  it("caps the entry count at the pinned limit", async () => {
    expect(fileIndexLimits).toEqual({ maxEntries: 2000, maxDepth: 8 });
    const wide: Tree = Object.fromEntries(
      Array.from({ length: 2500 }, (_, at) => [`f${String(at).padStart(4, "0")}.ts`, ""]),
    );
    const { relatives } = await indexOver(wide);
    expect((await relatives()).length).toBe(2000);
    const small = await indexOver(wide, { maxEntries: 3, maxDepth: 8 });
    expect(await small.relatives()).toEqual(["f0000.ts", "f0001.ts", "f0002.ts"]);
  });

  it("stops descending past the depth limit", async () => {
    const tree: Tree = { "top.ts": "" };
    let cursor = tree;
    for (let depth = 1; depth <= 10; depth += 1) {
      const child: Tree = { [`d${depth}.ts`]: "" };
      cursor[`d${depth}`] = child;
      cursor = child;
    }
    const { relatives } = await indexOver(tree, { maxEntries: 2000, maxDepth: 2 });
    expect(await relatives()).toEqual(["top.ts", "d1/d1.ts", "d1/d2/d2.ts"]);
  });

  it("treats an unreadable directory as empty rather than failing the walk", async () => {
    const { disk } = diskOver({ ok: { "a.ts": "" }, "b.ts": "" });
    const failing: BrowserDisk = {
      readDirectory: async (path) => {
        if (path.endsWith("ok")) throw new Error("EACCES");
        return disk.readDirectory(path);
      },
    };
    const index = new FileIndex("root", failing);
    expect((await settledEntries(index)).map((file) => file.relative)).toEqual(["b.ts"]);
  });

  it("refresh re-walks and ensure does not", async () => {
    const tree: Tree = { "a.ts": "" };
    const { index, reads } = await indexOver(tree);
    await settledEntries(index);
    index.ensure();
    await index.settled();
    expect(reads).toEqual(["root"]);
    tree["b.ts"] = "";
    index.refresh();
    await index.settled();
    expect(index.entries().map((file) => file.relative)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("file jump commands", () => {
  it("are jump commands named by relative path that open the absolute path", async () => {
    const { index } = await indexOver({ src: { "app.ts": "" } });
    const opened: string[] = [];
    const source = fileJumpSource(index, {
      openFile: (path) => opened.push(path),
      allowed: () => true,
    });
    await settledEntries(index);
    const [command] = source();
    expect(command).toMatchObject({ name: "src/app.ts", label: "src/app.ts", jump: true });
    command?.run();
    expect(opened).toEqual([join("root", "src", "app.ts")]);
    expect(source()).toBe(source());
  });

  it("stay away, index unbuilt, until the workspace is trusted", async () => {
    const { index, reads } = await indexOver({ "a.ts": "" });
    let allowed = false;
    const source = fileJumpSource(index, { openFile: () => {}, allowed: () => allowed });
    expect(source()).toEqual([]);
    await index.settled();
    expect(reads).toEqual([]);
    allowed = true;
    source();
    await index.settled();
    expect(source().map((command) => command.name)).toEqual(["a.ts"]);
  });

  it("read trust off the workspace readiness", () => {
    expect(fileJumpsAllowed(undefined)).toBe(true);
    expect(fileJumpsAllowed({ kind: "ready", root: "r", vault: "v" })).toBe(true);
    expect(fileJumpsAllowed({ kind: "undeclared", root: "r" })).toBe(true);
    expect(fileJumpsAllowed({ kind: "undecided", root: "r" })).toBe(false);
    expect(fileJumpsAllowed({ kind: "refused", root: "r" })).toBe(false);
  });
});

describe("palette file jump", () => {
  async function paletteProbe() {
    const probe = new AppProbe({ createFilePane: (id, path) => stubFilePane(id, path) });
    const { index } = await indexOver({
      src: { "app.ts": "", "app-core.ts": "" },
      docs: { "readme.md": "" },
    });
    probe.core.registry.addSource(
      fileJumpSource(index, {
        openFile: (path) => probe.core.openFile(path),
        allowed: () => true,
      }),
    );
    await settledEntries(index);
    return probe;
  }

  it("fuzzy-matches a typed path in go mode and enter opens the file pane", async () => {
    const probe = await paletteProbe();
    probe.keys("ctrl+p").type("readme");
    expect(probe.core.paletteMode).toBe("go");
    expect(probe.core.paletteMatches().map((entry) => entry.name)).toEqual(["docs/readme.md"]);
    probe.keys("enter");
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(paneIds(probe)).toEqual(["session-1", "file-1"]);
    expect(probe.snapshot().focused).toBe("file-1");
    expect(probe.snapshot().panes[1]?.title).toBe(join("root", "docs", "readme.md"));
  });

  it("ranks the closer path first and keeps files out of command mode", async () => {
    const probe = await paletteProbe();
    probe.keys("ctrl+p").type("src/app");
    expect(probe.core.paletteMatches().map((entry) => entry.name)).toEqual([
      "src/app.ts",
      "src/app-core.ts",
    ]);
    probe.keys("escape").keys("ctrl+shift+p").type("app");
    expect(probe.core.paletteMatches().some((entry) => entry.jump === true)).toBe(false);
  });
});
