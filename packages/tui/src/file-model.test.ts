import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileModel } from "./file-model.ts";
import { parseChord } from "./keys.ts";

const tempDirs: string[] = [];

async function fileWith(content: string): Promise<{ cwd: string; name: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "keywork-file-"));
  tempDirs.push(cwd);
  await writeFile(join(cwd, "sample.ts"), content);
  return { cwd, name: "sample.ts" };
}

async function loadedModel(content: string): Promise<FileModel> {
  const { cwd, name } = await fileWith(content);
  const model = new FileModel(cwd, name, () => {});
  await model.lastLoad;
  return model;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileModel", () => {
  it("loads a file into numbered visible lines", async () => {
    const model = await loadedModel("one\ntwo\nthree");

    expect(model.visibleLines(10)).toEqual([
      { number: 1, text: "one" },
      { number: 2, text: "two" },
      { number: 3, text: "three" },
    ]);
  });

  it("scrolls with arrows and pages, clamped to the content", async () => {
    const content = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`).join("\n");
    const model = await loadedModel(content);

    model.handleKey(parseChord("down"), 10);
    model.handleKey(parseChord("down"), 10);
    expect(model.visibleLines(10)[0]).toEqual({ number: 3, text: "line-3" });

    model.handleKey(parseChord("pagedown"), 10);
    expect(model.visibleLines(10)[0]?.number).toBe(13);

    model.handleKey(parseChord("pageup"), 10);
    model.handleKey(parseChord("pageup"), 10);
    expect(model.visibleLines(10)[0]?.number).toBe(1);
  });

  it("never scrolls past the end", async () => {
    const model = await loadedModel("a\nb\nc");
    for (let press = 0; press < 20; press += 1) model.handleKey(parseChord("pagedown"), 2);
    expect(model.visibleLines(2)[0]?.number).toBe(2);
  });

  it("ignores non-scroll keys so typing stays available to the app", async () => {
    const model = await loadedModel("a");
    expect(model.handleKey(parseChord("x"), 10)).toBe(false);
  });

  it("reports missing files as a readable failure", async () => {
    const { cwd } = await fileWith("irrelevant");
    const model = new FileModel(cwd, "not-there.ts", () => {});
    await model.lastLoad;

    expect(model.state.kind).toBe("failed");
    expect(model.visibleLines(10)).toEqual([]);
  });

  it("refuses binary content", async () => {
    const { cwd } = await fileWith("irrelevant");
    await writeFile(join(cwd, "blob.bin"), Buffer.from([1, 0, 2]));
    const model = new FileModel(cwd, "blob.bin", () => {});
    await model.lastLoad;

    expect(model.state).toEqual({ kind: "failed", reason: "binary file" });
  });
});
