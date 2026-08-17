import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AskGateLedger, toolShape } from "./ask-gate.ts";
import { ReviewInbox } from "./inbox.ts";
import { MemoryStore } from "./store.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function scratchDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "keywork-askgate-"));
  cleanups.push(root);
  return root;
}

async function openVault(): Promise<MemoryStore> {
  return new MemoryStore({ vaultRoot: await scratchDir(), trusted: true });
}

describe("toolShape", () => {
  it("normalizes tool name and command head into a stable shape", () => {
    expect(toolShape("Bash", "git status")).toBe("bash git");
    expect(toolShape("write")).toBe("write");
    expect(toolShape("bash", "./run.sh --all")).toBe("bash ./run.sh");
  });
});

describe("AskGateLedger", () => {
  it("turns three same-shape approvals into exactly one inbox proposal and a preference note", async () => {
    const ledger = new AskGateLedger();
    const inbox = new ReviewInbox();
    const store = await openVault();
    await ledger.record("bash git", "yes");
    await ledger.record("bash git", "yes");
    await ledger.record("bash git", "always");

    const proposed = await ledger.proposePreferences(inbox, store);

    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ kind: "preference-proposal", toolShape: "bash git" });
    const items = await inbox.list();
    expect(items).toHaveLength(1);
    const notes = await store.listNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ provenance: "user" });
    expect(notes[0]?.title).toContain("bash git");
  });

  it("never proposes the same shape twice, even after the item is resolved", async () => {
    const ledger = new AskGateLedger();
    const inbox = new ReviewInbox();
    for (const _ of [1, 2, 3]) await ledger.record("bash git", "yes");
    const [first] = await ledger.proposePreferences(inbox);
    await inbox.resolve(first?.id ?? "");
    await ledger.record("bash git", "yes");

    expect(await ledger.proposePreferences(inbox)).toHaveLength(0);
    expect(await inbox.list()).toHaveLength(0);
  });

  it("stays quiet below the threshold", async () => {
    const ledger = new AskGateLedger();
    const inbox = new ReviewInbox();
    await ledger.record("bash git", "yes");
    await ledger.record("bash git", "yes");

    expect(await ledger.proposePreferences(inbox)).toHaveLength(0);
  });

  it("resets the streak when an ask is denied", async () => {
    const ledger = new AskGateLedger();
    const inbox = new ReviewInbox();
    await ledger.record("bash git", "yes");
    await ledger.record("bash git", "yes");
    await ledger.record("bash git", "no");
    await ledger.record("bash git", "yes");
    await ledger.record("bash git", "yes");

    expect(await ledger.proposePreferences(inbox)).toHaveLength(0);

    await ledger.record("bash git", "yes");
    expect(await ledger.proposePreferences(inbox)).toHaveLength(1);
  });

  it("tracks shapes independently", async () => {
    const ledger = new AskGateLedger();
    const inbox = new ReviewInbox();
    for (const _ of [1, 2, 3]) await ledger.record("bash git", "yes");
    await ledger.record("write", "yes");

    const proposed = await ledger.proposePreferences(inbox);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ toolShape: "bash git" });
  });

  it("persists events and proposal fingerprints across restarts", async () => {
    const file = join(await scratchDir(), "ask-gate.json");
    const first = new AskGateLedger({ filePath: file });
    for (const _ of [1, 2, 3]) await first.record("bash git", "yes");
    await first.proposePreferences(new ReviewInbox());

    const reopened = new AskGateLedger({ filePath: file });
    expect(await reopened.events()).toHaveLength(3);
    expect(await reopened.proposePreferences(new ReviewInbox())).toHaveLength(0);
  });
});
