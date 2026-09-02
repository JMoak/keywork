import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArcRegistry } from "./arcs/registry.ts";
import type { AuditEntry } from "./audit.ts";
import type { Note } from "./notes.ts";
import { gatherReturnDelta, returnDelta } from "./return-delta.ts";
import { MemoryStore } from "./store.ts";

const since = "2026-08-20T00:00:00.000Z";

function noteOf(name: string, created?: string, supersededBy?: string): Note {
  return {
    name,
    path: `${name}.md`,
    title: name,
    provenance: "agent",
    pinned: false,
    aliases: [],
    body: "b\n",
    links: [],
    tokens: 1,
    frontmatter: {},
    ...(created !== undefined && { created }),
    ...(supersededBy !== undefined && { supersededBy }),
  };
}

function closeEntry(slug: string, timestamp: string): AuditEntry {
  return { timestamp, event: `arc ${slug} closed: delivered 2, left 0 archived, questions 0` };
}

describe("returnDelta", () => {
  it("is silent when nothing changed", () => {
    expect(
      returnDelta({
        since,
        workspaceNotes: [noteOf("Old", "2026-08-01T00:00:00.000Z")],
        arc: { slug: "dock-v2", notes: [noteOf("Settled", "2026-08-02T00:00:00.000Z")] },
        audit: [closeEntry("earlier", "2026-08-10T00:00:00.000Z")],
      }),
    ).toEqual([]);
  });

  it("is byte-stable for a fixed ledger", () => {
    const inputs = {
      since,
      workspaceNotes: [
        noteOf("Zeta Rule", "2026-08-21T10:00:00.000Z"),
        noteOf("Alpha Rule", "2026-08-21T10:00:00.000Z"),
        noteOf("Old Way", "2026-08-01T00:00:00.000Z", "New Way"),
        noteOf("New Way", "2026-08-22T00:00:00.000Z"),
        noteOf("Delta Rule", "2026-08-21T09:00:00.000Z"),
        noteOf("Echo Rule", "2026-08-23T00:00:00.000Z"),
      ],
      arc: {
        slug: "dock-v2",
        notes: [noteOf("Arc Find", "2026-08-21T11:00:00.000Z")],
      },
      audit: [closeEntry("infra", "2026-08-22T00:00:00.000Z")],
    };
    const first = returnDelta(inputs);
    expect(first).toEqual([
      "1 new in #dock-v2: [[Arc Find]]",
      "5 new in the workspace: [[Delta Rule]], [[Alpha Rule]], [[Zeta Rule]] +2 more",
      "1 superseded: [[Old Way]] now [[New Way]]",
      "arcs delivered: infra",
    ]);
    expect(returnDelta(inputs)).toEqual(first);
  });

  it("counts a supersession only when the successor arrived after the absence", () => {
    const stale = returnDelta({
      since,
      workspaceNotes: [
        noteOf("Old Way", "2026-08-01T00:00:00.000Z", "New Way"),
        noteOf("New Way", "2026-08-02T00:00:00.000Z"),
      ],
    });
    expect(stale).toEqual([]);
  });

  it("names each delivered arc once", () => {
    const lines = returnDelta({
      since,
      workspaceNotes: [],
      audit: [
        closeEntry("infra", "2026-08-21T00:00:00.000Z"),
        closeEntry("dock-v2", "2026-08-22T00:00:00.000Z"),
        closeEntry("infra", "2026-08-23T00:00:00.000Z"),
      ],
    });
    expect(lines).toEqual(["arcs delivered: dock-v2, infra"]);
  });
});

describe("gatherReturnDelta", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function vaultRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "keywork-return-delta-"));
    dirs.push(root);
    return root;
  }

  it("reads the workspace and the arc layer and stays quiet on a same-day return", async () => {
    const root = await vaultRoot();
    const late = new MemoryStore({
      vaultRoot: root,
      trusted: true,
      now: () => new Date("2026-08-25T09:00:00.000Z"),
    });
    await late.writeNote({ title: "Fresh Rule", body: "f\n", provenance: "agent" });
    const registry = new ArcRegistry({
      vaultRoot: root,
      trusted: true,
      now: () => new Date("2026-08-25T09:00:00.000Z"),
    });
    await registry.createArc("dock-v2");
    await registry
      .arcStore("dock-v2")
      .writeNote({ title: "Arc Find", body: "a\n", provenance: "agent" });

    const away = await gatherReturnDelta({
      since,
      workspace: late,
      registry,
      arc: "dock-v2",
    });
    expect(away).toEqual([
      "1 new in #dock-v2: [[Arc Find]]",
      "1 new in the workspace: [[Fresh Rule]]",
    ]);

    const back = await gatherReturnDelta({
      since: "2026-08-25T10:00:00.000Z",
      workspace: late,
      registry,
      arc: "dock-v2",
    });
    expect(back).toEqual([]);
  });

  it("stays quiet for an untrusted vault", async () => {
    const root = await vaultRoot();
    await mkdir(join(root, "daily"), { recursive: true });
    await writeFile(
      join(root, "Fresh Rule.md"),
      "---\ncreated: 2026-08-25T09:00:00.000Z\n---\nf\n",
    );
    const untrusted = new MemoryStore({ vaultRoot: root, trusted: false });
    expect(await gatherReturnDelta({ since, workspace: untrusted })).toEqual([]);
  });
});
