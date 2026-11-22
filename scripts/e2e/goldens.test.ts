import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { goldenPath, pruneGoldens, verifyGolden, writeGolden } from "./goldens.ts";

describe("golden round-trip", () => {
  let root: string;
  const path = () => goldenPath(root, "demo", "step");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "keywork-goldens-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes a masked golden and verifies the same frame clean", () => {
    const frame = "booted at 12:34:56 in session 1755300000000-0001-42\n";
    writeGolden(path(), frame);
    expect(readFileSync(path(), "utf8")).not.toContain("12:34:56");
    expect(() => verifyGolden(path(), frame)).not.toThrow();
  });

  it("fails a missing golden with the update hint", () => {
    expect(() => verifyGolden(path(), "frame")).toThrow(/--update-goldens/);
  });

  it("reports the differing line and column on a mismatch", () => {
    writeGolden(path(), "line one\nline two\n");
    expect(() => verifyGolden(path(), "line one\nline TWO\n")).toThrow(/line 2, col 6/);
  });

  it("tolerates CRLF creeping into either side", () => {
    writeGolden(path(), "alpha\r\nbeta\r\n");
    expect(() => verifyGolden(path(), "alpha\nbeta\n")).not.toThrow();
  });
});

describe("golden tree maintenance", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "keywork-goldens-"));
    writeGolden(goldenPath(root, "discovery", "palette"), "palette\n");
    writeGolden(goldenPath(root, "discovery", "help-overlay"), "help\n");
    writeGolden(goldenPath(root, "discovery", "01-palette"), "stale\n");
    writeGolden(goldenPath(root, "cold-start", "no-provider-guidance"), "boot\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("prunes goldens no capture of the scenario produced and leaves other scenarios alone", () => {
    const removed = pruneGoldens(root, "discovery", ["Palette", "help-overlay"]);
    expect(removed).toEqual(["01-palette"]);
    expect(existsSync(goldenPath(root, "discovery", "01-palette"))).toBe(false);
    expect(existsSync(goldenPath(root, "discovery", "palette"))).toBe(true);
    expect(existsSync(goldenPath(root, "cold-start", "no-provider-guidance"))).toBe(true);
  });
});
