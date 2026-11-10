import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CampaignArtifacts } from "./artifacts.ts";
import { CampaignSources } from "./sources.ts";

let root: string;
let artifacts: CampaignArtifacts;
let sources: CampaignSources;
let allowed: boolean;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "keywork-campaign-sources-"));
  artifacts = new CampaignArtifacts(join(root, "artifacts"));
  allowed = true;
  sources = new CampaignSources(join(root, "sources"), artifacts, () => allowed);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("campaign evidence source registry", () => {
  it("returns exact source ranges with stable identity, offsets, and digests", async () => {
    const text = "First source line\r\nSecond 😸 line\r\nThird line";
    const source = await sources.register({
      ownerScope: "owner",
      title: "Source",
      reference: "provided:source",
      text,
    });
    const excerpt = await sources.excerpt({
      ownerScope: "owner",
      sourceId: source.id,
      startLine: 2,
      endLine: 2,
    });
    expect(excerpt.text).toBe("Second 😸 line\r\n");
    expect(text.slice(excerpt.startOffset, excerpt.endOffset)).toBe(excerpt.text);
    expect(excerpt.sourceDigest).toBe(source.contentDigest);
    expect(excerpt.excerptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(excerpt.artifactId).toBe(source.artifact.id);
  });

  it("rechecks scope and revocation on every read and search", async () => {
    const source = await sources.register({
      ownerScope: "owner",
      title: "Secret source",
      reference: "provided:source",
      text: "A supported claim.",
    });
    expect((await sources.search({ ownerScope: "owner", query: "supported" })).hits).toHaveLength(
      1,
    );
    await expect(sources.get("another-owner", source.id)).rejects.toThrow("access denied");
    allowed = false;
    await expect(
      sources.excerpt({ ownerScope: "owner", sourceId: source.id, startLine: 1, endLine: 1 }),
    ).rejects.toThrow("access denied");
    expect((await sources.search({ ownerScope: "owner", query: "supported" })).hits).toEqual([]);
    await expect(
      sources.register({
        ownerScope: "owner",
        title: "Denied",
        reference: "provided:denied",
        text: "Text",
      }),
    ).rejects.toThrow("access denied");
  });

  it("keeps contradictory sources independently retrievable", async () => {
    const first = await sources.register({
      ownerScope: "owner",
      title: "First",
      reference: "provided:first",
      text: "The result improved.",
    });
    const second = await sources.register({
      ownerScope: "owner",
      title: "Second",
      reference: "provided:second",
      text: "The result regressed.",
    });
    const found = await sources.search({ ownerScope: "owner", query: "result" });
    expect(new Set(found.hits.map((hit) => hit.sourceId))).toEqual(new Set([first.id, second.id]));
    expect(first.contentDigest).not.toBe(second.contentDigest);
  });

  it("rejects invalid ranges and oversized excerpts rather than silently clipping them", async () => {
    const source = await sources.register({
      ownerScope: "owner",
      title: "Source",
      reference: "provided:source",
      text: "A complete line.\nAnother complete line.",
    });
    await expect(
      sources.excerpt({ ownerScope: "owner", sourceId: source.id, startLine: 0, endLine: 1 }),
    ).rejects.toThrow("line range");
    await expect(
      sources.excerpt({ ownerScope: "owner", sourceId: source.id, startLine: 1, endLine: 8 }),
    ).rejects.toThrow("line range");
    await expect(
      sources.excerpt({
        ownerScope: "owner",
        sourceId: source.id,
        startLine: 1,
        endLine: 1,
        maxBytes: 3,
      }),
    ).rejects.toThrow("exceeds");
    await expect(sources.get("owner", "../source")).rejects.toThrow("identifier");
  });

  it("detects snapshot tampering before returning evidence", async () => {
    const source = await sources.register({
      ownerScope: "owner",
      title: "Source",
      reference: "provided:source",
      text: "Original evidence",
    });
    await writeFile(
      join(artifacts.root, source.artifact.storageRef, "files", "source.txt"),
      "Altered evidence",
    );
    await expect(
      sources.excerpt({ ownerScope: "owner", sourceId: source.id, startLine: 1, endLine: 1 }),
    ).rejects.toThrow("digest mismatch");
  });
});
