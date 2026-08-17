import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { anchorFrontmatter, checkpointAnchor, readAnchor } from "./anchors.ts";
import { MemoryStore } from "./store.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function openVault(): Promise<MemoryStore> {
  const root = await mkdtemp(join(tmpdir(), "keywork-anchors-"));
  cleanups.push(root);
  return new MemoryStore({ vaultRoot: root, trusted: true });
}

const now = new Date("2026-08-17T09:00:00.000Z");

describe("checkpointAnchor", () => {
  it("carries timestamp, commit sha, and a host-qualified checkpoint id", () => {
    const anchor = checkpointAnchor({ now, sha: "1a2b3c", checkpointId: "tree9", host: "atlas" });

    expect(anchor).toEqual({
      at: "2026-08-17T09:00:00.000Z",
      sha: "1a2b3c",
      checkpoint: "atlas:tree9",
    });
  });

  it("degrades gracefully left to right", () => {
    expect(checkpointAnchor({ now })).toEqual({ at: "2026-08-17T09:00:00.000Z" });
    expect(checkpointAnchor({ now, sha: "1a2b3c" })).toEqual({
      at: "2026-08-17T09:00:00.000Z",
      sha: "1a2b3c",
    });
  });
});

describe("readAnchor", () => {
  const full = anchorFrontmatter(
    checkpointAnchor({ now, sha: "1a2b3c", checkpointId: "tree9", host: "atlas" }),
  );

  it("returns the whole tuple on the machine that wrote it", () => {
    expect(readAnchor(full, "atlas")).toEqual({
      at: "2026-08-17T09:00:00.000Z",
      sha: "1a2b3c",
      checkpoint: "atlas:tree9",
    });
  });

  it("keeps timestamp and sha on a foreign machine and ignores the checkpoint id", () => {
    expect(readAnchor(full, "rigel")).toEqual({
      at: "2026-08-17T09:00:00.000Z",
      sha: "1a2b3c",
    });
  });

  it("reads nothing from an unanchored note", () => {
    expect(readAnchor({}, "atlas")).toBeUndefined();
  });
});

describe("anchored notes", () => {
  it("round-trips the tuple through note frontmatter", async () => {
    const store = await openVault();
    await store.writeNote({
      title: "Resize handles land in the layout pass",
      body: "Learned while fixing the dock.",
      provenance: "agent",
      anchor: checkpointAnchor({ now, sha: "1a2b3c", checkpointId: "tree9", host: "atlas" }),
    });

    const note = (await store.listNotes())[0];
    expect(note?.frontmatter.anchored_at).toBe("2026-08-17T09:00:00.000Z");
    expect(readAnchor(note?.frontmatter ?? {}, "rigel")).toEqual({
      at: "2026-08-17T09:00:00.000Z",
      sha: "1a2b3c",
    });
    expect(readAnchor(note?.frontmatter ?? {}, "atlas")?.checkpoint).toBe("atlas:tree9");
  });
});
