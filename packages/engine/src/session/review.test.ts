import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type EngineEvents, EventBus } from "../bus.ts";
import type { Message } from "../messages.ts";
import { isJournalOnly } from "./journal.ts";
import {
  isReviewVerdict,
  latestVerdicts,
  openAsks,
  type ReviewVerdict,
  recordHunkVerdict,
  reviewVerdictType,
  type VerdictMark,
  verdictLine,
  verdictMarksOf,
} from "./review.ts";
import { SessionStore } from "./store.ts";

const first: ReviewVerdict = {
  path: "src/a.ts",
  header: "@@ -1,3 +1,4 @@",
  digest: "a1b2c3d4",
  verdict: "keep",
};

const second: ReviewVerdict = {
  path: "src/a.ts",
  header: "@@ -9,2 +10,5 @@",
  digest: "0f0f0f0f",
  verdict: "ask",
};

async function sessionFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "keywork-review-")), "session.jsonl");
}

function textMessage(role: "user" | "assistant", text: string): Message {
  return { role, parts: [{ type: "text", text }] };
}

describe("a hunk verdict on the session", () => {
  it("is a journal-only entry marked at its place among the messages and kept out of them", async () => {
    const file = await sessionFile();
    const store = await SessionStore.create(file, ".");
    await store.append(textMessage("user", "take the delivery"));
    const kept = await store.appendHunkVerdict(first);
    await store.append(textMessage("assistant", "done"));
    const asked = await store.appendHunkVerdict(second);

    const reopened = await SessionStore.open(file);

    expect(reopened.messages()).toHaveLength(2);
    expect(reopened.messageMarks().verdicts).toEqual([
      { index: 1, entryId: kept.id, at: kept.timestamp, ...first },
      { index: 2, entryId: asked.id, at: asked.timestamp, ...second },
    ]);
    expect(reopened.messageMarks().reports).toEqual([]);
    expect(isJournalOnly(kept)).toBe(true);
    expect(kept.type === "custom" && kept.customType).toBe(reviewVerdictType);
  });

  it("emits one review notice carrying the mark when recorded through the bus", async () => {
    const store = await SessionStore.create(await sessionFile(), ".");
    const bus = new EventBus<EngineEvents>();
    const notices: EngineEvents["extension.notice"][] = [];
    bus.on("extension.notice", (notice) => notices.push(notice));
    await store.append(textMessage("user", "hi"));

    const mark = await recordHunkVerdict(store, bus, first);

    expect(mark).toMatchObject({ index: 1, ...first });
    expect(notices).toEqual([
      {
        extension: "review",
        level: "info",
        message: "keep · src/a.ts @@ -1,3 +1,4 @@ · hunk a1b2c3d4",
        detail: { verdict: mark, entryId: mark.entryId },
      },
    ]);
  });

  it("lets the last word on a hunk win and lists the asks still open", () => {
    const at = "2026-11-06T10:00:00.000Z";
    const marks: VerdictMark[] = [
      { index: 0, entryId: "e1", at, ...first },
      { index: 0, entryId: "e2", at, ...second },
      { index: 1, entryId: "e3", at, ...first, verdict: "drop" },
    ];
    expect(latestVerdicts(marks).map((mark) => [mark.digest, mark.verdict])).toEqual([
      ["a1b2c3d4", "drop"],
      ["0f0f0f0f", "ask"],
    ]);
    expect(openAsks(marks).map((mark) => mark.entryId)).toEqual(["e2"]);
  });

  it("skips entries whose data is not a verdict and refuses malformed references", () => {
    const stamped = { id: "x", parentId: null, timestamp: "t" } as const;
    const entries = [
      { ...stamped, type: "custom" as const, customType: reviewVerdictType, data: { nope: 1 } },
      { ...stamped, type: "custom" as const, customType: "other", data: first },
      { ...stamped, id: "y", type: "custom" as const, customType: reviewVerdictType, data: second },
    ];
    expect(verdictMarksOf(entries).map((mark) => mark.entryId)).toEqual(["y"]);
    expect(isReviewVerdict({ ...first, header: "@@ nonsense @@" })).toBe(false);
    expect(isReviewVerdict({ ...first, digest: "xyz" })).toBe(false);
    expect(isReviewVerdict({ ...first, verdict: "maybe" })).toBe(false);
    expect(isReviewVerdict({ ...first, path: "" })).toBe(false);
    expect(isReviewVerdict(first)).toBe(true);
  });

  it("words the trail line the console draws", () => {
    expect(verdictLine(second)).toBe("ask · src/a.ts @@ -9,2 +10,5 @@ · hunk 0f0f0f0f");
  });
});
