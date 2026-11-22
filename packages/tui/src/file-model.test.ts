import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileModel } from "./file-model.ts";
import { parseChord } from "./keys.ts";
import type { FileOpenOptions } from "./pane.ts";

const tempDirs: string[] = [];

async function fileWith(content: string): Promise<{ cwd: string; name: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "keywork-file-"));
  tempDirs.push(cwd);
  await writeFile(join(cwd, "sample.ts"), content);
  return { cwd, name: "sample.ts" };
}

async function loadedModel(content: string, options?: FileOpenOptions): Promise<FileModel> {
  const { cwd, name } = await fileWith(content);
  const model = new FileModel(cwd, name, () => {}, options);
  await model.settled();
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

  it("opens at the end when asked, landing on the last page", async () => {
    const content = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`).join("\n");
    const { cwd, name } = await fileWith(content);
    const model = new FileModel(cwd, name, () => {}, { atEnd: true });
    await model.settled();

    expect(model.visibleLines(10)[0]?.number).toBe(41);
    expect(model.visibleLines(10).at(-1)?.number).toBe(50);
  });

  it("reports missing files as a readable failure", async () => {
    const { cwd } = await fileWith("irrelevant");
    const model = new FileModel(cwd, "not-there.ts", () => {});
    await model.settled();

    expect(model.state.kind).toBe("failed");
    expect(model.visibleLines(10)).toEqual([]);
  });

  it("refuses binary content", async () => {
    const { cwd } = await fileWith("irrelevant");
    await writeFile(join(cwd, "blob.bin"), Buffer.from([1, 0, 2]));
    const model = new FileModel(cwd, "blob.bin", () => {});
    await model.settled();

    expect(model.state).toEqual({ kind: "failed", reason: "binary file" });
  });
});

describe("opening at a place", () => {
  const content = "héllo\r\nworld\nthird\nfourth";

  it("scrolls to the line holding a byte offset, counting UTF-8 bytes and CRLF endings", async () => {
    const atThird = await loadedModel(content, { byteRange: { from: 14, to: 19 } });
    expect(atThird.visibleLines(2)[0]?.number).toBe(3);
    const insideSecond = await loadedModel(content, { byteRange: { from: 9, to: 12 } });
    expect(insideSecond.visibleLines(2)[0]?.number).toBe(2);
    const past = await loadedModel(content, { byteRange: { from: 10_000, to: 10_001 } });
    expect(past.visibleLines(2)[0]?.number).toBe(3);
  });

  it("scrolls to a one-based line", async () => {
    const model = await loadedModel(content, { line: 3 });
    expect(model.visibleLines(2)[0]?.number).toBe(3);
    const clamped = await loadedModel(content, { line: 0 });
    expect(clamped.visibleLines(2)[0]?.number).toBe(1);
  });
});
