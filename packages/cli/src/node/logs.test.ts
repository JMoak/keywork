import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generation, RotatingLog, tailLines } from "./logs.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keywork-node-logs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function linesOf(file: string): string[] {
  return readFileSync(file, "utf8").trimEnd().split("\n");
}

describe("RotatingLog", () => {
  it("appends one JSON object per line", () => {
    const log = new RotatingLog(join(dir, "logs", "node.log"), { maxBytes: 10_000, keep: 2 });
    log.append({ at: "2026-11-05T09:00:00.000Z", unit: "core", line: "node core: running" });
    log.append({ at: "2026-11-05T09:00:01.000Z", unit: "core", line: "mesh: listening" });
    expect(linesOf(log.file).map((line) => JSON.parse(line).line)).toEqual([
      "node core: running",
      "mesh: listening",
    ]);
  });

  it("rotates by size and keeps only the newest generations", () => {
    const file = join(dir, "node.log");
    const log = new RotatingLog(file, { maxBytes: 120, keep: 2 });
    for (let index = 0; index < 12; index += 1) {
      log.append({ at: "2026-11-05T09:00:00.000Z", n: index, pad: "x".repeat(20) });
    }
    expect(existsSync(generation(file, 1))).toBe(true);
    expect(existsSync(generation(file, 2))).toBe(true);
    expect(existsSync(generation(file, 3))).toBe(false);
    for (const each of [file, generation(file, 1), generation(file, 2)]) {
      expect(readFileSync(each).byteLength).toBeLessThanOrEqual(120);
    }
    const kept = [generation(file, 2), generation(file, 1), file].flatMap((each) =>
      linesOf(each).map((line) => JSON.parse(line).n as number),
    );
    expect(kept).toEqual([...kept].sort((left, right) => left - right));
    expect(kept.at(-1)).toBe(11);
  });
});

describe("tailLines", () => {
  it("reaches into the previous generation when the current file is short", () => {
    const file = join(dir, "node.log");
    const log = new RotatingLog(file, { maxBytes: 80, keep: 3 });
    for (let index = 0; index < 6; index += 1) log.append({ at: "t", n: index });
    const tail = tailLines(file, 3).map((line) => JSON.parse(line).n);
    expect(tail).toEqual([3, 4, 5]);
  });

  it("is empty for a log that was never written", () => {
    expect(tailLines(join(dir, "absent.log"), 10)).toEqual([]);
  });
});
