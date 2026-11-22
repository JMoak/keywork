import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import {
  hostToken,
  isMultiHostVault,
  markMultiHostVault,
  mergeAuditSegments,
  mergeDailySegments,
  segmentIndexes,
  vaultHost,
} from "./hosts.ts";
import type { DailyEntry } from "./notes.ts";

const scratch = scratchDirs("keywork-hosts-");

function entry(time: string, text: string): DailyEntry {
  return { time, provenance: "user", text };
}

describe("host tokens", () => {
  it("lowers, dashes and bounds a hostname so it can live in a filename", () => {
    expect(hostToken("Jordan's MacBook Pro.local")).toBe("jordan-s-macbook-pro-local");
    expect(hostToken("DESKTOP-ABC123")).toBe("desktop-abc123");
    expect(hostToken("---")).toBe("host");
    expect(hostToken("x".repeat(40))).toHaveLength(32);
  });
});

describe("segment merging", () => {
  it("keeps a single segment in file order even when its clock ran backwards", () => {
    const placed = mergeDailySegments([
      { path: "daily/d.md", entries: [entry("10:00", "later"), entry("09:00", "earlier")] },
    ]);
    expect(placed.map((item) => item.entry.text)).toEqual(["later", "earlier"]);
  });

  it("interleaves several segments by time, stable within a segment", () => {
    const placed = mergeDailySegments([
      { path: "daily/d.alpha.md", entries: [entry("09:00", "a1"), entry("11:00", "a2")] },
      { path: "daily/d.beta.md", entries: [entry("09:00", "b1"), entry("10:00", "b2")] },
    ]);
    expect(placed.map((item) => `${item.path}#${item.index} ${item.entry.text}`)).toEqual([
      "daily/d.alpha.md#0 a1",
      "daily/d.beta.md#0 b1",
      "daily/d.beta.md#1 b2",
      "daily/d.alpha.md#1 a2",
    ]);
    expect(segmentIndexes(placed, new Set([1, 3]))).toEqual(
      new Map([
        ["daily/d.beta.md", new Set([0])],
        ["daily/d.alpha.md", new Set([1])],
      ]),
    );
  });

  it("orders audit segments by timestamp only when there is more than one", () => {
    const a = { timestamp: "2026-08-10T10:00:00.000Z", event: "a" };
    const b = { timestamp: "2026-08-10T09:00:00.000Z", event: "b" };
    expect(mergeAuditSegments([[a, b]])).toEqual([a, b]);
    expect(mergeAuditSegments([[a], [b]])).toEqual([b, a]);
  });
});

describe("the multi-host marker", () => {
  it("turns on once, keeps the lease out of git, and names the local host", async () => {
    const root = await scratch();
    expect(isMultiHostVault(root)).toBe(false);
    expect(vaultHost(root)).toBeUndefined();
    expect(await markMultiHostVault(root)).toBe(true);
    expect(await markMultiHostVault(root)).toBe(false);
    expect(isMultiHostVault(root)).toBe(true);
    expect(vaultHost(root)).toMatch(/^[a-z0-9-]+$/);
    expect(JSON.parse(await readFile(join(root, ".sync", "layout.json"), "utf8"))).toEqual({
      version: 1,
      layout: "per-host",
    });
    expect(await readFile(join(root, ".sync", ".gitignore"), "utf8")).toBe("lease.json\n");
  });
});
