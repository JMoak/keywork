import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilePane } from "./file-pane.ts";
import { parseChord } from "./keys.ts";
import { resolveTheme } from "./theme.ts";

const tempDirs: string[] = [];

async function fileWith(content: string): Promise<{ cwd: string; name: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "keywork-file-pane-"));
  tempDirs.push(cwd);
  await writeFile(join(cwd, "sample.ts"), content);
  return { cwd, name: "sample.ts" };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function context(height = 8) {
  return { theme: resolveTheme(), focused: true, width: 40, height };
}

function lines(pane: FilePane, height = 8): string[] {
  const view = pane.view(context(height)) as unknown as {
    children?: { props?: { content?: unknown } }[];
  };
  return (view.children ?? []).map((child) => String(child.props?.content ?? ""));
}

describe("FilePane", () => {
  it("titles itself with the line count and renders numbered lines in a padded gutter", async () => {
    const content = Array.from({ length: 12 }, (_, at) => `line-${at + 1}`).join("\n");
    const { cwd, name } = await fileWith(content);
    const pane = new FilePane("file-1", cwd, name, () => {});
    await pane.settled();
    expect(pane.title()).toBe(" sample.ts · 12 lines ");
    expect(pane.describe()).toEqual({ kind: "file", path: name });
    expect(lines(pane).slice(0, 2)).toEqual([" 1 line-1", " 2 line-2"]);
    expect(lines(pane)).toHaveLength(6);
  });

  it("scrolls through its own key path and opens at the end when asked", async () => {
    const content = Array.from({ length: 30 }, (_, at) => `line-${at + 1}`).join("\n");
    const { cwd, name } = await fileWith(content);
    const pane = new FilePane("file-1", cwd, name, () => {});
    await pane.settled();
    lines(pane);
    expect(pane.handleKey(parseChord("pagedown"))).toBe(true);
    expect(lines(pane)[0]).toBe(" 7 line-7");
    expect(pane.handleKey(parseChord("x"))).toBe(false);

    const tail = new FilePane("file-2", cwd, name, () => {}, { atEnd: true });
    await tail.settled();
    expect(lines(tail).at(-1)).toBe("30 line-30");
  });

  it("shows loading before the read lands and the failure after a bad path", async () => {
    const { cwd } = await fileWith("irrelevant");
    const pane = new FilePane("file-1", cwd, "missing.ts", () => {});
    expect(lines(pane)).toEqual(["loading…"]);
    await pane.settled();
    expect(pane.title()).toBe(" missing.ts ");
    expect(lines(pane)[0]).toContain("missing.ts: ");
  });

  it("stays silent once disposed", async () => {
    const { cwd, name } = await fileWith("a\nb");
    let notified = 0;
    const pane = new FilePane("file-1", cwd, name, () => {
      notified += 1;
    });
    pane.dispose();
    await pane.settled();
    expect(notified).toBe(0);
  });
});
