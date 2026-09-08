import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import {
  boundToolOutput,
  defaultToolOutputBudget,
  elisionMarker,
  removeSessionFiles,
  SpillStore,
  spillDirFor,
} from "./spill.ts";

const tempDir = scratchDirs("keywork-spill-");

const bytes = (text: string) => Buffer.byteLength(text);

describe("boundToolOutput", () => {
  it("pins the budget at 64 KiB and leaves anything at or under it untouched", () => {
    expect(defaultToolOutputBudget).toBe(65_536);
    const exact = "x".repeat(defaultToolOutputBudget);

    expect(boundToolOutput(exact, "id")).toEqual({ output: exact });
  });

  it("keeps head plus tail under budget with the marker and a spill reference", () => {
    const full = `${"head-".repeat(20_000)}${"tail-".repeat(20_000)}`;

    const { output, spill } = boundToolOutput(full, "spill-1");

    expect(bytes(output)).toBeLessThanOrEqual(defaultToolOutputBudget);
    expect(output.startsWith("head-head-")).toBe(true);
    expect(output.endsWith("tail-tail-")).toBe(true);
    expect(spill).toEqual({
      id: "spill-1",
      bytes: bytes(full),
      elidedFrom: expect.any(Number),
      elidedTo: expect.any(Number),
    });
    expect(output).toContain(elisionMarker(spill as NonNullable<typeof spill>));
    const kept = output.split(`\n${elisionMarker(spill as NonNullable<typeof spill>)}\n`);
    expect(bytes(kept[0] ?? "")).toBe(spill?.elidedFrom);
    expect(bytes(full) - bytes(kept[1] ?? "")).toBe(spill?.elidedTo);
    expect(full.startsWith(kept[0] ?? "")).toBe(true);
    expect(full.endsWith(kept[1] ?? "")).toBe(true);
  });

  it("never splits a multi-byte character at either boundary", () => {
    const full = "😀é".repeat(30_000);

    const { output, spill } = boundToolOutput(full, "id", 1000);

    expect(bytes(output)).toBeLessThanOrEqual(1000);
    expect(output.includes("�")).toBe(false);
    expect(Buffer.from(output, "utf8").toString("utf8")).toBe(output);
    const marker = elisionMarker(spill as NonNullable<typeof spill>);
    const [head = "", tail = ""] = output.split(`\n${marker}\n`);
    expect(full.startsWith(head)).toBe(true);
    expect(full.endsWith(tail)).toBe(true);
    expect(bytes(head)).toBe(spill?.elidedFrom);
    expect(bytes(full) - bytes(tail)).toBe(spill?.elidedTo);
  });
});

describe("SpillStore", () => {
  it("lives beside the session JSONL under a matching .spills directory", () => {
    const dir = spillDirFor(join("sessions", "ws", "1725600000-0001-42.jsonl"));

    expect(dir).toBe(join("sessions", "ws", "1725600000-0001-42.spills"));
  });

  it("returns small outputs as they are and writes nothing", async () => {
    const store = SpillStore.beside(join(await tempDir(), "s.jsonl"));

    expect(await store.keep("small")).toEqual({ output: "small" });
    expect(existsSync(store.dir)).toBe(false);
  });

  it("spills one file for an oversized output and hands back the bounded form", async () => {
    const store = SpillStore.beside(join(await tempDir(), "s.jsonl"));
    const full = "line\n".repeat(600_000);

    const { output, spill } = await store.keep(full);

    expect(bytes(output)).toBeLessThanOrEqual(defaultToolOutputBudget);
    expect(spill).toBeDefined();
    const files = await readdir(store.dir);
    expect(files).toEqual([`${spill?.id}.txt`]);
    expect(await readFile(store.path(spill?.id ?? ""), "utf8")).toBe(full);
  });

  it("reads exact bytes at a range, including both ends and past the end", async () => {
    const store = SpillStore.beside(join(await tempDir(), "s.jsonl"));
    const full = "0123456789";
    const { spill } = await store.keep(full, 4);
    const id = spill?.id ?? "";
    const text = (chunk: Uint8Array) => Buffer.from(chunk).toString("utf8");

    expect(text(await store.readRange(id, { offset: 0, length: 3 }))).toBe("012");
    expect(text(await store.readRange(id, { offset: 7, length: 3 }))).toBe("789");
    expect(text(await store.readRange(id, { offset: 8, length: 10 }))).toBe("89");
    expect(text(await store.readRange(id, { offset: 10, length: 5 }))).toBe("");
    expect(
      text(
        await store.readRange(id, {
          offset: spill?.elidedFrom ?? 0,
          length: (spill?.elidedTo ?? 0) - (spill?.elidedFrom ?? 0),
        }),
      ),
    ).toBe(full.slice(spill?.elidedFrom, spill?.elidedTo));
  });

  it("removing a session removes its JSONL and its spills together", async () => {
    const file = join(await tempDir(), "s.jsonl");
    await writeFile(file, "{}\n", "utf8");
    const store = SpillStore.beside(file);
    await store.keep("x".repeat(defaultToolOutputBudget + 1));
    expect(existsSync(store.dir)).toBe(true);

    await removeSessionFiles(file);

    expect(existsSync(file)).toBe(false);
    expect(existsSync(store.dir)).toBe(false);
  });
});
