import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryInertError, MemoryStore, type Provenance } from "./store.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

const secretValue = "Sup3r-Secret-Walk-Value-Omega77";
const titles = ["Concept A", "Concept B", "Concept C", "Concept D", "Concept E"];

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

async function scratchVault(trusted: boolean): Promise<{ store: MemoryStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "keywork-gating-"));
  cleanups.push(root);
  const store = new MemoryStore({
    vaultRoot: root,
    trusted,
    now: () => new Date("2026-08-10T14:30:00.000Z"),
    secrets: { WALK_SECRET: secretValue },
  });
  return { store, root };
}

async function visibleSurfaceText(store: MemoryStore): Promise<string> {
  const parts: string[] = [];
  for (const note of await store.listNotes()) {
    parts.push(note.name, note.body, JSON.stringify(note.frontmatter));
  }
  parts.push(...(await store.readMoc()));
  for (const entry of await store.readDaily()) parts.push(`${entry.provenance} ${entry.text}`);
  for (const note of (await store.bootstrap(1_000_000)).notes) parts.push(note.body);
  return parts.join("\n");
}

async function diskContents(root: string, dir = ""): Promise<string[]> {
  const contents: string[] = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) contents.push(...(await diskContents(root, rel)));
    else contents.push(await readFile(join(root, rel), "utf8"));
  }
  return contents;
}

describe("write-gating property", () => {
  it("no operation sequence makes an untrusted write load-bearing without approve", async () => {
    const { store, root } = await scratchVault(true);
    const random = seededRandom(1337);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const sentinelApproved = new Map<string, boolean>();
    const sentinelByStagedId = new Map<string, string>();
    let sentinelCount = 0;

    const trackNewStaged = async (sentinel: string): Promise<void> => {
      for (const item of await store.listStaged()) {
        if (item.content.includes(sentinel)) sentinelByStagedId.set(item.id, sentinel);
      }
    };

    for (let step = 0; step < 120; step += 1) {
      const roll = random();
      if (roll < 0.3) {
        sentinelCount += 1;
        const sentinel = `UNTRUSTED_PAYLOAD_${String(sentinelCount).padStart(4, "0")}`;
        sentinelApproved.set(sentinel, false);
        const shape = random();
        if (shape < 0.6) {
          await store.writeNote({
            title: pick(titles),
            body: `injected ${sentinel} with ${secretValue}\n`,
            provenance: "untrusted",
          });
        } else if (shape < 0.9) {
          await store.appendDaily(`saw ${sentinel} in tool output`, "untrusted");
        } else {
          await store.writeMoc([sentinel, ...titles], "untrusted");
        }
        await trackNewStaged(sentinel);
      } else if (roll < 0.55) {
        const provenance: Provenance = random() < 0.5 ? "user" : "agent";
        if (random() < 0.5) {
          await store.writeNote({
            title: pick(titles),
            body: `trusted revision at step ${step}, secret ${secretValue}\n`,
            provenance,
          });
        } else {
          await store.appendDaily(`trusted entry at step ${step}`, provenance);
        }
      } else if (roll < 0.65) {
        await store.writeMoc(titles, "user");
      } else if (roll < 0.8) {
        const staged = await store.listStaged();
        if (staged.length > 0) {
          const victim = pick(staged);
          await store.approve(victim.id);
          const sentinel = sentinelByStagedId.get(victim.id);
          if (sentinel !== undefined) sentinelApproved.set(sentinel, true);
        }
      } else if (roll < 0.9) {
        const staged = await store.listStaged();
        if (staged.length > 0) await store.discard(pick(staged).id);
      } else {
        const ledger = store.ledger();
        if (ledger.length > 0) await store.revert(pick(ledger).id);
      }

      const visible = await visibleSurfaceText(store);
      for (const [sentinel, approved] of sentinelApproved) {
        if (!approved) expect(visible).not.toContain(sentinel);
      }
      for (const content of await diskContents(root)) {
        expect(content).not.toContain(secretValue);
      }
    }

    expect(sentinelCount).toBeGreaterThan(10);
    expect([...sentinelApproved.values()].some((approved) => approved)).toBe(true);
  }, 60_000);

  it("an untrusted workspace stays fully inert under the same walk", async () => {
    const { store, root } = await scratchVault(false);
    const random = seededRandom(4242);
    for (let step = 0; step < 40; step += 1) {
      const roll = random();
      const write =
        roll < 0.4
          ? store.writeNote({ title: "Concept A", body: "x\n", provenance: "untrusted" })
          : roll < 0.7
            ? store.appendDaily("x", "user")
            : store.approve("any");
      await expect(write).rejects.toBeInstanceOf(MemoryInertError);
      expect(await store.listNotes()).toEqual([]);
      expect(await store.readMoc()).toEqual([]);
      expect((await store.bootstrap(1_000_000)).notes).toEqual([]);
    }
    expect(await readdir(root)).toEqual([]);
  });
});
