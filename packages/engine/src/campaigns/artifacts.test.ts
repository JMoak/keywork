import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CampaignArtifacts } from "./artifacts.ts";

let root: string;
let source: string;
let store: CampaignArtifacts;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "keywork-campaign-artifacts-"));
  source = join(root, "source");
  await mkdir(source);
  store = new CampaignArtifacts(join(root, "store"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("campaign artifact capture and isolation", () => {
  it("captures working bytes while excluding metadata, dependencies, and known secret files", async () => {
    await writeFile(join(source, "report.md"), "Unsaved working content");
    await writeFile(join(source, ".env"), "SECRET=never-copy");
    await mkdir(join(source, ".git"));
    await writeFile(join(source, ".git", "config"), "private origin");
    await mkdir(join(source, "node_modules"));
    await writeFile(join(source, "node_modules", "dependency.js"), "dependency");
    const manifest = await store.capture({
      sourcePath: source,
      allowedRoot: source,
      ownerScope: "owner",
      title: "Baseline",
    });
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["report.md"]);
    expect(await store.readText(manifest, "report.md", 1_000)).toBe("Unsaved working content");
    const candidate = await store.materialize(manifest, "candidate");
    await writeFile(join(candidate, "report.md"), "Experimental change");
    expect(await readFile(join(source, "report.md"), "utf8")).toBe("Unsaved working content");
    expect(await store.readText(manifest, "report.md", 1_000)).toBe("Unsaved working content");
    const next = await store.snapshot({
      path: candidate,
      ownerScope: "owner",
      title: "Candidate",
      parentIds: [manifest.id],
      producerAttemptId: "attempt",
    });
    expect(next.id).not.toBe(manifest.id);
    expect(next.parentIds).toEqual([manifest.id]);
    expect(await store.readText(next, "report.md", 1_000)).toBe("Experimental change");
  });

  it("captures a single file and an empty directory", async () => {
    const file = join(source, "notes.md");
    await writeFile(file, "Notes");
    const manifest = await store.capture({
      sourcePath: file,
      allowedRoot: source,
      ownerScope: "owner",
      title: "Notes",
    });
    expect(manifest.kind).toBe("file");
    expect((await store.preview(manifest)).content).toBe("Notes");
    await mkdir(join(source, "empty"));
    const empty = await store.capture({
      sourcePath: join(source, "empty"),
      allowedRoot: source,
      ownerScope: "owner",
      title: "Empty",
    });
    expect(await store.preview(empty)).toMatchObject({ path: null, content: null, totalBytes: 0 });
  });

  it("rejects source paths outside the authorized root and unmanaged candidate snapshots", async () => {
    const outside = join(root, "outside.md");
    await writeFile(outside, "Outside");
    await expect(
      store.capture({
        sourcePath: outside,
        allowedRoot: source,
        ownerScope: "owner",
        title: "Outside",
      }),
    ).rejects.toThrow("escapes");
    await expect(
      store.snapshot({ path: source, ownerScope: "owner", title: "Not a candidate" }),
    ).rejects.toThrow("escapes");
  });

  it("rejects non-excluded directory links instead of following them", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "private.md"), "Private");
    await symlink(
      outside,
      join(source, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      store.capture({
        sourcePath: source,
        allowedRoot: source,
        ownerScope: "owner",
        title: "Linked",
      }),
    ).rejects.toThrow("Symbolic links");
  });

  it("does not overwrite an existing candidate directory", async () => {
    const artifact = await report("Original");
    const candidate = await store.materialize(artifact, "same");
    await writeFile(join(candidate, "report.md"), "User edit");
    await expect(store.materialize(artifact, "same")).rejects.toThrow();
    expect(await readFile(join(candidate, "report.md"), "utf8")).toBe("User edit");
  });
});

describe("campaign artifact integrity and bounds", () => {
  it.each([
    "../escape.md",
    "/absolute.md",
    "C:/escape.md",
    "a\\escape.md",
    "stream:secret",
    "a/../escape.md",
    "CON.txt",
    "trailing.",
  ])("rejects unsafe output path %s", async (path) => {
    await expect(
      store.write({ files: { [path]: "Forbidden" }, ownerScope: "owner", title: "Unsafe" }),
    ).rejects.toThrow();
  });

  it("rejects secret names and portable case collisions", async () => {
    await expect(
      store.write({ files: { ".env.local": "SECRET" }, ownerScope: "owner", title: "Secret" }),
    ).rejects.toThrow("excluded");
    await expect(
      store.write({ files: { "A.md": "A", "a.md": "a" }, ownerScope: "owner", title: "Collision" }),
    ).rejects.toThrow("collide");
  });

  it("enforces file count and byte limits before publishing", async () => {
    const bounded = new CampaignArtifacts(join(root, "bounded"), {
      maxFiles: 1,
      maxFileBytes: 4,
      maxTotalBytes: 4,
    });
    await expect(
      bounded.write({ files: { "one.md": "12345" }, ownerScope: "owner", title: "Too large" }),
    ).rejects.toThrow("byte limit");
    await expect(
      bounded.write({
        files: { "one.md": "1", "two.md": "2" },
        ownerScope: "owner",
        title: "Too many",
      }),
    ).rejects.toThrow("file-count");
    const valid = await bounded.write({
      files: { "one.md": "1234" },
      ownerScope: "owner",
      title: "Fits",
    });
    expect(valid.entries).toHaveLength(1);
  });

  it("removes incomplete staging when manifest validation fails", async () => {
    await expect(
      store.write({ files: { "report.md": "Report" }, ownerScope: "owner", title: "" }),
    ).rejects.toThrow();
    expect(await readdir(join(store.root, "staging"))).toEqual([]);
    expect(await readdir(join(store.root, "objects"))).toEqual([]);
  });

  it("detects content and manifest substitution", async () => {
    const manifest = await report("Trusted");
    await expect(store.preview({ ...manifest, ownerScope: "another-owner" })).rejects.toThrow(
      "differs",
    );
    await expect(store.preview({ ...manifest, storageRef: "../source" })).rejects.toThrow(
      "storage reference",
    );
    await writeFile(join(store.root, manifest.storageRef, "files", "report.md"), "Tampered");
    await expect(store.preview(manifest)).rejects.toThrow("digest mismatch");
  });

  it("returns bounded UTF-8 previews and requires explicit full-read capacity", async () => {
    const bounded = new CampaignArtifacts(join(root, "preview"), { previewBytes: 3 });
    const manifest = await bounded.write({
      files: { "report.md": "a😸more" },
      ownerScope: "owner",
      title: "Unicode",
    });
    expect(await bounded.preview(manifest)).toMatchObject({
      content: "a",
      truncated: true,
      totalBytes: 9,
    });
    await expect(bounded.readText(manifest, "report.md", 3)).rejects.toThrow("exceeds");
    expect(await bounded.readText(manifest, "report.md", 9)).toBe("a😸more");
    await expect(bounded.preview(manifest, "../report.md")).rejects.toThrow();
  });

  it("does not serialize binary file bytes as text", async () => {
    const file = join(source, "image.png");
    await writeFile(file, Buffer.from([0, 255, 1, 2]));
    const manifest = await store.capture({
      sourcePath: file,
      allowedRoot: source,
      ownerScope: "owner",
      title: "Binary",
    });
    expect(await store.preview(manifest)).toMatchObject({
      content: null,
      mimeType: "image/png",
      totalBytes: 4,
    });
    await expect(store.readText(manifest, "image.png", 100)).rejects.toThrow("not UTF-8");
  });

  it("exports only to a new explicit destination and never overwrites user content", async () => {
    const manifest = await report("Exported");
    const destination = join(root, "export");
    expect(await store.export(manifest, destination)).toBe(destination);
    expect(await readFile(join(destination, "report.md"), "utf8")).toBe("Exported");
    await writeFile(join(destination, "report.md"), "User edit");
    await expect(store.export(manifest, destination)).rejects.toThrow();
    expect(await readFile(join(destination, "report.md"), "utf8")).toBe("User edit");
  });
});

function report(content: string) {
  return store.write({
    files: { "report.md": content },
    ownerScope: "owner",
    title: "Report",
    kind: "report",
    parentIds: [],
    producerAttemptId: null,
  });
}
