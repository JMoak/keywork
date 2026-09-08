import { textTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { AppProbe } from "./probe.ts";

const burstWords = ["dictated", "words", "arrive", "as", "one", "long", "keystroke", "burst"];
const graphemeHeavy = "héllo 👋🏽 family 👨‍👩‍👧‍👦 flag 🇯🇵 日本語のテキスト and z̸a̸l̸g̸o̸ tail";

function burst(events: number): string {
  let text = "";
  while (text.length < events) text += `${burstWords[text.length % burstWords.length]} `;
  return text.slice(0, events);
}

function probeWithReplies(): AppProbe {
  return new AppProbe({ script: [textTurn("ok"), textTurn("ok"), textTurn("ok")] });
}

function submittedPrompts(probe: AppProbe): string[] {
  const history = probe.model()?.currentAgent()?.history() ?? [];
  return history
    .filter((message) => message.role === "user")
    .map((message) =>
      message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
    );
}

describe("injection citizenship (C34)", () => {
  it("lands a multi-hundred-event keystroke burst intact without submitting", () => {
    const probe = probeWithReplies();
    const text = burst(400);
    probe.type(text);
    expect(probe.model()?.input).toBe(text);
    expect(submittedPrompts(probe)).toEqual([]);
    expect(probe.snapshot().leaderArmed).toBe(false);
  });

  it("never submits a paste with embedded newlines; only enter sends, newlines intact", async () => {
    const probe = probeWithReplies();
    const pasted = "first line\nsecond line\n\nfourth line after a blank\n";
    probe.paste(pasted);
    expect(submittedPrompts(probe)).toEqual([]);
    probe.keys("enter");
    await probe.settled();
    expect(submittedPrompts(probe)).toEqual([pasted.trim()]);
  });

  it("keeps CRLF pastes as one edit and one submit", async () => {
    const probe = probeWithReplies();
    probe.paste("alpha\r\nbeta\r\n");
    expect(submittedPrompts(probe)).toEqual([]);
    probe.keys("enter");
    await probe.settled();
    expect(submittedPrompts(probe)).toEqual(["alpha\nbeta"]);
  });

  it("lets a burst arriving on an armed leader fall through as text after the cancel key", () => {
    const probe = probeWithReplies();
    const panesBefore = probe.snapshot().panes.length;
    probe.keys("ctrl+k");
    expect(probe.snapshot().leaderArmed).toBe(true);
    probe.type("quick brown fox jumps");
    expect(probe.snapshot().leaderArmed).toBe(false);
    expect(probe.snapshot().panes.length).toBe(panesBefore);
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(probe.model()?.input).toBe("uick brown fox jumps");
    expect(submittedPrompts(probe)).toEqual([]);
  });

  it("keeps a burst that starts with a bound leader key from swallowing the rest", () => {
    const probe = probeWithReplies();
    probe.keys("ctrl+k");
    probe.type("zoom in please");
    expect(probe.snapshot().zoomed).toBeDefined();
    expect(probe.model()?.input).toBe("oom in please");
  });

  it("lands grapheme-heavy typing intact and submits it byte-for-byte", async () => {
    const probe = probeWithReplies();
    probe.type(graphemeHeavy);
    expect(probe.model()?.input).toBe(graphemeHeavy);
    probe.keys("enter");
    await probe.settled();
    expect(submittedPrompts(probe)).toEqual([graphemeHeavy]);
  });

  it("lands grapheme-heavy pastes intact", async () => {
    const probe = probeWithReplies();
    probe.paste(graphemeHeavy);
    expect(submittedPrompts(probe)).toEqual([]);
    probe.keys("enter");
    await probe.settled();
    expect(submittedPrompts(probe)).toEqual([graphemeHeavy]);
  });

  it("survives a burst, a paste, and another burst in one prompt", async () => {
    const probe = probeWithReplies();
    probe.type("before ");
    probe.paste("pasted middle");
    probe.type(" after");
    probe.keys("enter");
    await probe.settled();
    expect(submittedPrompts(probe)).toEqual(["before pasted middle after"]);
  });
});
