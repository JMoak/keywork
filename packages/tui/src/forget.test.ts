import { type Message, textMessage } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { forgetInSession, forgetTargetOf, isForgettable } from "./forget.ts";
import type { ForgetTarget, SessionAttachment } from "./session-attachment.ts";

function attachmentWith(forget: SessionAttachment["forget"]): SessionAttachment {
  return {
    id: "s1",
    history: [],
    replay: () => {},
    append: async () => undefined,
    ...(forget !== undefined && { forget }),
  };
}

describe("forgetInSession", () => {
  it("is absent when the attachment cannot edit context", () => {
    const hook = forgetInSession({ attachment: attachmentWith(undefined), adopt: () => true });
    expect(hook).toBeUndefined();
  });

  it("records the edit, rebuilds the live agent, and says what changed", async () => {
    const edits: [ForgetTarget, string | null][] = [];
    const adopted: Message[][] = [];
    const edited = [textMessage("assistant", "still here")];
    const hook = forgetInSession({
      attachment: attachmentWith(async (target, replacement) => {
        edits.push([target, replacement]);
        return edited;
      }),
      adopt: (history) => {
        adopted.push([...history]);
        return true;
      },
    });

    const forgot = await hook?.({ kind: "prompt", promptId: "u1" }, null);
    const rewrote = await hook?.({ kind: "tool", callId: "c1" }, "[redacted]");

    expect(edits).toEqual([
      [{ kind: "prompt", promptId: "u1" }, null],
      [{ kind: "tool", callId: "c1" }, "[redacted]"],
    ]);
    expect(adopted).toEqual([edited, edited]);
    expect(forgot).toEqual({
      forgotten: true,
      note: "forgot that prompt · out of the model's context · the transcript keeps the original",
    });
    expect(rewrote?.note).toBe(
      "rewrote that tool call and its result · the model sees your line instead · the transcript keeps the original",
    );
  });

  it("says when the edit only reaches the model on reopen, and when nothing was there", async () => {
    const hook = forgetInSession({
      attachment: attachmentWith(async (target) => (target.kind === "prompt" ? [] : undefined)),
      adopt: () => false,
    });
    expect((await hook?.({ kind: "prompt", promptId: "u1" }, null))?.note).toBe(
      "forgot that prompt · out of the model's context · takes effect when the session reopens",
    );
    expect(await hook?.({ kind: "tool", callId: "missing" }, null)).toEqual({
      forgotten: false,
      note: "nothing to forget there · it isn't on this session's path",
    });
  });
});

describe("forgetTargetOf", () => {
  it("maps saved prompts and tool rows to their session identities and nothing else", () => {
    expect(forgetTargetOf({ kind: "user", text: "hi", entryId: "u1" })).toEqual({
      kind: "prompt",
      promptId: "u1",
    });
    expect(forgetTargetOf({ kind: "user", text: "unsaved" })).toBeUndefined();
    const run = {
      name: "read",
      callId: "c1",
      subject: "",
      args: "",
      replay: false,
      startedAtMs: 0,
      folded: true,
    };
    expect(forgetTargetOf({ kind: "tool", text: "read", failed: false, run })).toEqual({
      kind: "tool",
      callId: "c1",
    });
    expect(isForgettable({ kind: "assistant", text: "reply" })).toBe(false);
    expect(isForgettable({ kind: "info", text: "notice" })).toBe(false);
  });
});
