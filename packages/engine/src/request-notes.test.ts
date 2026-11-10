import { describe, expect, it } from "vitest";
import type { Message } from "./messages.ts";
import { promptMessage, textMessage } from "./messages.ts";
import { ConversationNotes, carriesNotes } from "./request-notes.ts";

const prompt = promptMessage("Now the tests.");
const results: Message = {
  role: "tool",
  parts: [
    { type: "tool-result", callId: "a", output: "first", isError: false },
    { type: "tool-result", callId: "b", output: "second", isError: false },
  ],
};
const reply = textMessage("assistant", "Done.");

describe("what can carry a note", () => {
  it("is a prompt or a tool result", () => {
    expect(carriesNotes(prompt)).toBe(true);
    expect(carriesNotes(results)).toBe(true);
    expect(carriesNotes(reply)).toBe(false);
    expect(carriesNotes(undefined)).toBe(false);
    expect(carriesNotes({ role: "tool", parts: [] })).toBe(false);
  });
});

describe("a laid note", () => {
  it("goes ahead of the keeper's words on a prompt, images kept", () => {
    const notes = new ConversationNotes();
    const withImage: Message = {
      role: "user",
      parts: [
        { type: "text", text: "Look." },
        { type: "image", mediaType: "image/png", data: "AA" },
      ],
    };

    notes.lay("A note.", 0);

    expect(notes.layInto([withImage])).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: "A note.\n\n" },
          { type: "text", text: "Look." },
          { type: "image", mediaType: "image/png", data: "AA" },
        ],
      },
    ]);
    expect(withImage.parts).toHaveLength(2);
  });

  it("goes at the end of the last tool result of a message", () => {
    const notes = new ConversationNotes();

    notes.lay("A note.", 0);

    expect(notes.layInto([results])[0]?.parts).toEqual([
      { type: "tool-result", callId: "a", output: "first", isError: false },
      { type: "tool-result", callId: "b", output: "second\n\nA note.", isError: false },
    ]);
  });

  it("stays on its message and leaves the others, and the given messages, as they were", () => {
    const notes = new ConversationNotes();
    const history = [prompt, reply, results];

    notes.lay("A note.", 2);

    const laid = notes.layInto(history);
    expect(laid[0]).toBe(prompt);
    expect(laid[1]).toBe(reply);
    expect(history[2]).toBe(results);
    expect(notes.layInto(history)).toEqual(laid);
  });

  it("joins a second note laid on the same message", () => {
    const notes = new ConversationNotes();
    notes.lay("One.", 0);
    notes.lay("Two.", 0);
    expect(notes.layInto([prompt])[0]?.parts[0]).toEqual({
      type: "text",
      text: "One.\n\nTwo.\n\n",
    });
  });

  it("follows retained messages across an agent replacement without attaching to rebuilt history", () => {
    const previous = new ConversationNotes();
    previous.lay("Dropped.", 0);
    previous.lay("Kept.", 2);
    const notes = new ConversationNotes();
    const rebuilt = { ...prompt };
    const next = promptMessage("Next.");

    notes.inherit(previous, [prompt, reply, results], [results, rebuilt, next]);

    expect(notes.layInto([results, rebuilt, next])).toEqual([
      {
        ...results,
        parts: [
          results.parts[0],
          { type: "tool-result", callId: "b", output: "second\n\nKept.", isError: false },
        ],
      },
      rebuilt,
      next,
    ]);
    expect(results.parts[1]).toEqual({
      type: "tool-result",
      callId: "b",
      output: "second",
      isError: false,
    });
  });

  it("is gone once cleared", () => {
    const notes = new ConversationNotes();
    notes.lay("A note.", 0);
    notes.clear();
    expect(notes.layInto([prompt])).toEqual([prompt]);
  });
});
