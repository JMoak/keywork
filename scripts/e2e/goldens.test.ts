import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { goldenPath, verifyGolden, writeGolden } from "./goldens.ts";

describe("goldenPath", () => {
  it("nests goldens by scenario under the golden root", () => {
    expect(goldenPath("/root", "cold-start", "01-no-provider-guidance")).toBe(
      join("/root", "cold-start", "01-no-provider-guidance.txt"),
    );
  });
});

describe("golden round-trip", () => {
  let root: string;
  const path = () => goldenPath(root, "demo", "01-step");

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

  it("verifies across dynamic regions that the masks cover", () => {
    writeGolden(path(), "saved 08:00:00 · session 1755300000000-0001-42\n");
    expect(() =>
      verifyGolden(path(), "saved 23:59:59 · session 1755399999999-0002-77\n"),
    ).not.toThrow();
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
