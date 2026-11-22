import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { checkpointAnchor, readAnchor } from "./anchors.ts";
import { MemoryStore } from "./store.ts";

const scratch = scratchDirs("keywork-anchors-");

async function openVault(): Promise<MemoryStore> {
  const root = await scratch();
  return new MemoryStore({ vaultRoot: root, trusted: true });
}

const now = new Date("2026-08-17T09:00:00.000Z");

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
