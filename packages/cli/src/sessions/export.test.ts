import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { textMessage } from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { sessionsCommand } from "./command.ts";
import { exportSession, parseExportArgs, sessionExporter } from "./export.ts";
import { openOrResumeSession } from "./store.ts";

const tempDir = scratchDirs("keywork-session-export-");

async function seeded() {
  const dir = await tempDir();
  const { store } = await openOrResumeSession(dir, dir);
  const root = await store.append(textMessage("user", "start <here>"));
  await store.append(textMessage("assistant", "first branch"));
  store.branch(root.id);
  await store.append(textMessage("assistant", "second branch"));
  return { dir, store };
}

describe("exportSession", () => {
  it("writes the active path beside the session file", async () => {
    const { dir, store } = await seeded();

    const written = await exportSession(store, { scope: "path", cwd: dir });

    expect(written).toBe(store.file.replace(/\.jsonl$/, ".html"));
    const html = await readFile(written, "utf8");
    expect(html).toContain("start &lt;here&gt;");
    expect(html).toContain("second branch");
    expect(html).not.toContain("first branch");
  });

  it("names a whole-tree export apart from a path export", async () => {
    const { dir, store } = await seeded();

    const written = await exportSession(store, { scope: "tree", cwd: dir });

    expect(written).toBe(store.file.replace(/\.jsonl$/, ".tree.html"));
    expect(await readFile(written, "utf8")).toContain("first branch");
  });

  it("writes to a path the user gives, relative to their folder", async () => {
    const { dir, store } = await seeded();

    const written = await exportSession(store, { scope: "path", out: "share.html", cwd: dir });

    expect(written).toBe(join(dir, "share.html"));
    expect(await readFile(written, "utf8")).toContain("<!doctype html>");
  });

  it("drops the default file name into a folder the user gives", async () => {
    const { dir, store } = await seeded();
    await mkdir(join(dir, "exports"));

    const written = await exportSession(store, { scope: "path", out: "exports", cwd: dir });

    expect(written).toBe(
      join(dir, "exports", store.file.split(/[\\/]/).at(-1)?.replace(".jsonl", ".html") ?? ""),
    );
  });
});

describe("parseExportArgs", () => {
  it.each([
    [undefined, { scope: "path" }],
    ["", { scope: "path" }],
    ["tree", { scope: "tree" }],
    ["tree  my notes/out.html ", { scope: "tree", out: "my notes/out.html" }],
    ["trees.html", { scope: "path", out: "trees.html" }],
    ["out.html", { scope: "path", out: "out.html" }],
  ])("reads %j", (args, expected) => {
    expect(parseExportArgs(args)).toEqual(expected);
  });
});

describe("sessionExporter", () => {
  it("prefers the live store, so an undone leaf exports as the user sees it", async () => {
    const { dir, store } = await seeded();
    const root = store.activePath()[0];
    if (root === undefined) throw new Error("seeded session has no root");
    store.branch(root.id);

    const written = await sessionExporter(dir, dir, () => store)(store.header.id, undefined);

    const html = await readFile(written, "utf8");
    expect(html).not.toContain("second branch");
  });

  it("falls back to the session on disk and refuses an unknown id", async () => {
    const { dir, store } = await seeded();
    const exporter = sessionExporter(dir, dir, () => undefined);

    expect(await exporter(store.header.id, "tree")).toMatch(/\.tree\.html$/);
    await expect(exporter("nope", undefined)).rejects.toThrow("no session matches id nope");
  });
});

describe("keywork sessions export", () => {
  it("exports the latest session and prints where it landed", async () => {
    const { dir, store } = await seeded();
    const out: string[] = [];

    const code = await sessionsCommand(["export"], dir, {
      print: (line) => out.push(line),
      printError: () => undefined,
      cwd: dir,
    });

    expect(code).toBe(0);
    expect(out).toEqual([`exported → ${store.file.replace(/\.jsonl$/, ".html")}`]);
  });

  it("honors --tree and --out", async () => {
    const { dir, store } = await seeded();
    const out: string[] = [];

    const code = await sessionsCommand(["export", store.header.id.slice(0, 8)], dir, {
      print: (line) => out.push(line),
      printError: () => undefined,
      tree: true,
      out: "whole.html",
      cwd: dir,
    });

    expect(code).toBe(0);
    expect(out).toEqual([`exported → ${join(dir, "whole.html")}`]);
    expect(await readFile(join(dir, "whole.html"), "utf8")).toContain("branch 2 of 2 · active");
  });

  it("refuses an unknown session", async () => {
    const dir = await tempDir();
    const errors: string[] = [];

    const code = await sessionsCommand(["export", "zzzz"], dir, {
      print: () => undefined,
      printError: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors).toEqual(["no session matches id zzzz"]);
  });
});
