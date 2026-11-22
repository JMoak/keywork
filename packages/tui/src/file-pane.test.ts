import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilePane } from "./file-pane.ts";
import { resolvePalette } from "./palette.ts";

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
  return { theme: resolvePalette(), focused: true, width: 40, height };
}

function lines(pane: FilePane, height = 8): string[] {
  const view = pane.view(context(height)) as unknown as {
    children?: { children?: { props?: { content?: unknown } }[] }[];
  };
  const [body] = view.children ?? [];
  return (body?.children ?? []).map((child) => String(child.props?.content ?? ""));
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
});
