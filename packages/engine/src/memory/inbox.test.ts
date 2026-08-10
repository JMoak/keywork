import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MalformedInboxError, ReviewInbox, ReviewItemNotFoundError, reviewKey } from "./inbox.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function inboxFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "keywork-inbox-"));
  cleanups.push(root);
  return join(root, ".staging", "inbox.json");
}

const clock = () => new Date("2026-08-10T18:00:00.000Z");

describe("ReviewInbox", () => {
  it("adds items, dedupes by key, and orders by insertion", async () => {
    const inbox = new ReviewInbox({ now: clock });
    const added = await inbox.add([
      {
        kind: "borderline-promotion",
        title: "Prefer pnpm",
        body: "b",
        confidence: 0.6,
        source: "d#0",
      },
      { kind: "link-proposal", note: "Setup", target: "Bun runtime", mention: "bun" },
      {
        kind: "borderline-promotion",
        title: "prefer PNPM",
        body: "b2",
        confidence: 0.7,
        source: "d#1",
      },
    ]);
    expect(added.map((item) => item.kind)).toEqual(["borderline-promotion", "link-proposal"]);
    expect((await inbox.list()).map((item) => item.key)).toEqual([
      "promotion:prefer pnpm",
      "link:setup->bun runtime",
    ]);
  });

  it("treats contradiction and merge keys as unordered pairs", () => {
    const forward = reviewKey({
      kind: "contradiction",
      a: "Uses npm",
      b: "Uses pnpm",
      aProvenance: "user",
      bProvenance: "agent",
      confidence: 0.9,
    });
    const backward = reviewKey({
      kind: "contradiction",
      a: "Uses pnpm",
      b: "Uses npm",
      aProvenance: "agent",
      bProvenance: "user",
      confidence: 0.9,
    });
    expect(forward).toBe(backward);
  });

  it("persists across instances and resolves items", async () => {
    const filePath = await inboxFile();
    const first = new ReviewInbox({ filePath, now: clock });
    const [item] = await first.add([
      { kind: "supersession-proposal", winner: "New rule", loser: "Old rule", confidence: 0.7 },
    ]);
    expect(item).toBeDefined();
    const second = new ReviewInbox({ filePath, now: clock });
    expect((await second.list()).map((entry) => entry.id)).toEqual([item?.id]);
    if (item !== undefined) await second.resolve(item.id);
    expect(await second.list()).toEqual([]);
    const third = new ReviewInbox({ filePath, now: clock });
    expect(await third.list()).toEqual([]);
  });

  it("throws for an unknown resolve id", async () => {
    const inbox = new ReviewInbox({ now: clock });
    await expect(inbox.resolve("nope")).rejects.toBeInstanceOf(ReviewItemNotFoundError);
  });

  it("rejects a malformed inbox file with a typed error naming the file", async () => {
    const filePath = await inboxFile();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "not json", "utf8");
    const inbox = new ReviewInbox({ filePath, now: clock });
    await expect(inbox.list()).rejects.toBeInstanceOf(MalformedInboxError);
  });

  it("starts empty when the file does not exist yet", async () => {
    const inbox = new ReviewInbox({ filePath: await inboxFile(), now: clock });
    expect(await inbox.list()).toEqual([]);
  });
});
