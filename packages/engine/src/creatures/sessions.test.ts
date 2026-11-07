import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../session/store.ts";
import {
  childTagOf,
  claimSession,
  creatureSessionType,
  creatureTagOf,
  isCreatureTag,
  SessionClaimedError,
} from "./sessions.ts";

const scratch = scratchDirs("keywork-creature-sessions-");

const at = new Date("2026-11-05T09:00:00.000Z");

async function store(name: string): Promise<SessionStore> {
  const dir = await scratch();
  return SessionStore.create(join(dir, `${name}.jsonl`), dir, at);
}

describe("claiming a session for a creature", () => {
  it("writes the same bot binding a bot session writes, plus one tag entry", async () => {
    const plain = await store("plain");
    await plain.appendBotBinding("pip");
    const claimed = await store("claimed");
    await claimSession(claimed, { creature: "pip", kind: "conversation" });
    const [binding, tag, ...rest] = claimed.entries();
    const [plainBinding] = plain.entries();
    expect(rest).toEqual([]);
    expect(binding).toMatchObject({ type: "binding", bot: "pip", parentId: null });
    expect(Object.keys(binding ?? {}).sort()).toEqual(Object.keys(plainBinding ?? {}).sort());
    expect(tag).toMatchObject({
      type: "custom",
      customType: creatureSessionType,
      data: { creature: "pip", kind: "conversation" },
    });
    expect(claimed.botBinding()).toBe("pip");
    expect(claimed.binding()).toEqual(plain.binding());
  });

  it("adds only the tag to a session already bound to the bot", async () => {
    const bound = await store("bound");
    await bound.appendBotBinding("pip");
    await claimSession(bound, { creature: "pip", kind: "thread" });
    expect(bound.entries().map((entry) => entry.type)).toEqual(["binding", "custom"]);
  });

  it("is idempotent for the same tag and refuses another claim", async () => {
    const claimed = await store("claimed");
    const tag = { creature: "pip", kind: "thread" } as const;
    await claimSession(claimed, tag);
    await claimSession(claimed, tag);
    expect(claimed.entries()).toHaveLength(2);
    await expect(
      claimSession(claimed, { creature: "pip", kind: "routine" }),
    ).rejects.toBeInstanceOf(SessionClaimedError);
    await expect(claimSession(claimed, { creature: "mo", kind: "thread" })).rejects.toThrow(
      /already belongs to pip as its thread/,
    );
  });

  it("survives reopening the log", async () => {
    const claimed = await store("claimed");
    await claimSession(claimed, { creature: "pip", kind: "routine" });
    const reopened = await SessionStore.open(claimed.file);
    expect(creatureTagOf(reopened.entries())).toEqual({ creature: "pip", kind: "routine" });
    expect(reopened.botBinding()).toBe("pip");
  });

  it("reads no tag from an untagged or a malformed entry", async () => {
    const untagged = await store("untagged");
    expect(creatureTagOf(untagged.entries())).toBeUndefined();
    await untagged.appendCustom(creatureSessionType, { creature: "pip", kind: "parade" });
    expect(creatureTagOf(untagged.entries())).toBeUndefined();
    expect(isCreatureTag({ creature: "", kind: "thread" })).toBe(false);
    expect(isCreatureTag(null)).toBe(false);
  });

  it("derives a child tag that keeps the creature and says child", () => {
    expect(childTagOf({ creature: "pip", kind: "thread" })).toEqual({
      creature: "pip",
      kind: "child",
    });
  });
});
