import type { ToolCallPart } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import { MutationAsk } from "./mutation-ask.ts";

const writeCall: ToolCallPart = {
  type: "tool-call",
  callId: "call-1",
  name: "write",
  arguments: { path: "notes.txt" },
};

const askRows = 8;

describe("MutationAsk", () => {
  it("holds the ask open, swallowing unrelated keys until answered", async () => {
    const gate = new MutationAsk(() => {});
    const verdict = gate.confirm(writeCall);
    expect(gate.pending?.summary).toContain("write");
    expect(gate.handleKey(parseChord("z"), askRows)).toBe(true);
    expect(gate.pending).toBeDefined();

    gate.handleKey(parseChord("y"), askRows);
    expect(await verdict).toBe(true);
    expect(gate.pending).toBeUndefined();
  });

  it("denies on n and on escape", async () => {
    const gate = new MutationAsk(() => {});
    const first = gate.confirm(writeCall);
    gate.handleKey(parseChord("n"), askRows);
    expect(await first).toBe(false);

    const second = gate.confirm(writeCall);
    gate.handleKey(parseChord("escape"), askRows);
    expect(await second).toBe(false);
  });

  it("remembers a for the rest of the session", async () => {
    const gate = new MutationAsk(() => {});
    const first = gate.confirm(writeCall);
    gate.handleKey(parseChord("a"), askRows);
    expect(await first).toBe(true);
    expect(await gate.confirm(writeCall)).toBe(true);
    expect(gate.pending).toBeUndefined();
  });

  it("ignores modified chords so ctrl+a and meta+y neither approve nor remember", async () => {
    const gate = new MutationAsk(() => {});
    const verdict = gate.confirm(writeCall);
    expect(gate.handleKey({ name: "a", ctrl: true, shift: false, meta: false }, askRows)).toBe(
      true,
    );
    expect(gate.handleKey({ name: "y", ctrl: false, shift: false, meta: true }, askRows)).toBe(
      true,
    );
    expect(gate.pending).toBeDefined();
    gate.handleKey(parseChord("n"), askRows);
    expect(await verdict).toBe(false);

    const next = gate.confirm(writeCall);
    expect(gate.pending).toBeDefined();
    gate.handleKey(parseChord("y"), askRows);
    expect(await next).toBe(true);
  });

  it("queues a second ask behind the first instead of orphaning either", async () => {
    const gate = new MutationAsk(() => {});
    const first = gate.confirm(writeCall);
    const second = gate.confirm({ ...writeCall, callId: "call-2", name: "edit" });
    expect(gate.pending?.summary).toContain("write");
    gate.handleKey(parseChord("y"), askRows);
    expect(await first).toBe(true);
    expect(gate.pending?.summary).toContain("edit");
    gate.handleKey(parseChord("n"), askRows);
    expect(await second).toBe(false);
    expect(gate.pending).toBeUndefined();
  });

  it("denies every pending ask when closed and refuses new ones", async () => {
    const gate = new MutationAsk(() => {});
    const pending = gate.confirm(writeCall);
    gate.close();
    expect(await pending).toBe(false);
    expect(await gate.confirm(writeCall)).toBe(false);
    expect(gate.pending).toBeUndefined();
  });

  it("scrolls a diff with the arrows and pages by the rows it was given", async () => {
    const lines = Array.from({ length: 30 }, (_, at) => `line ${at + 1}`);
    const files: Record<string, string> = { "notes.txt": lines.join("\n") };
    const gate = new MutationAsk(
      () => {},
      (path) => files[path],
    );
    const verdict = gate.confirm({
      ...writeCall,
      arguments: { path: "notes.txt", content: [...lines].reverse().join("\n") },
    });
    expect(gate.pending?.diff?.length).toBeGreaterThan(8);
    const before = gate.diffWindow(4).above;
    gate.handleKey(parseChord("down"), 4);
    expect(gate.diffWindow(4).above).toBe(before + 1);
    gate.handleKey(parseChord("pagedown"), 4);
    expect(gate.diffWindow(4).above).toBeGreaterThanOrEqual(before + 1);
    gate.handleKey(parseChord("pageup"), 4);
    gate.handleKey(parseChord("up"), 4);
    expect(gate.diffWindow(4).above).toBe(before);
    gate.handleKey(parseChord("n"), 4);
    expect(await verdict).toBe(false);
  });
});
