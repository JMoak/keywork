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

const bashCall = (command: string): ToolCallPart => ({
  type: "tool-call",
  callId: `call-${command}`,
  name: "bash",
  arguments: { command },
});

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

  it("forgets a remembered session rule so the next call asks again", async () => {
    const gate = new MutationAsk(() => {});
    const first = gate.confirm(bashCall("git push origin main"));
    gate.handleKey(parseChord("a"), askRows);
    expect(await first).toBe(true);
    expect(gate.sessionRules).toEqual([
      { action: "bash", resource: "git push *", effect: "allow" },
    ]);

    expect(
      gate.forgetSessionRule({ action: "bash", resource: "git push *", effect: "allow" }),
    ).toBe(true);
    expect(gate.sessionRules).toEqual([]);
    const again = gate.confirm(bashCall("git push origin dev"));
    expect(gate.pending?.remembers).toEqual([
      { action: "bash", resource: "git push *", effect: "allow" },
    ]);
    gate.handleKey(parseChord("n"), askRows);
    gate.handleKey(parseChord("o"), askRows);
    expect(await again).toBe(false);
  });

  it("denies on n and on escape", async () => {
    const gate = new MutationAsk(() => {});
    const first = gate.confirm(writeCall);
    gate.handleKey(parseChord("n"), askRows);
    gate.handleKey(parseChord("o"), askRows);
    expect(await first).toBe(false);

    const second = gate.confirm(writeCall);
    gate.handleKey(parseChord("escape"), askRows);
    gate.handleKey(parseChord("escape"), askRows);
    expect(await second).toBe(false);
  });

  it("asks why after a deny and tells the gate the reason", async () => {
    const gate = new MutationAsk(() => {});
    const unsafe = gate.confirmation(writeCall);
    gate.handleKey(parseChord("n"), askRows);
    expect(gate.pending?.stage).toBe("reason");
    expect(gate.handleKey(parseChord("y"), askRows)).toBe(true);
    expect(gate.pending?.stage).toBe("reason");
    gate.handleKey(parseChord("u"), askRows);
    expect(await unsafe).toEqual({ approved: false, gate: "user", reason: "unsafe" });

    const notNow = gate.confirmation(writeCall);
    gate.handleKey(parseChord("n"), askRows);
    gate.handleKey(parseChord("n"), askRows);
    expect(await notNow).toEqual({ approved: false, gate: "user", reason: "not-now" });

    const other = gate.confirmation(writeCall);
    gate.handleKey(parseChord("escape"), askRows);
    gate.handleKey(parseChord("enter"), askRows);
    expect(await other).toEqual({ approved: false, gate: "user", reason: "other" });

    const allowed = gate.confirmation(writeCall);
    gate.handleKey(parseChord("y"), askRows);
    expect(await allowed).toEqual({ approved: true, gate: "user" });
  });

  it("answers not now for every ask a closing pane leaves behind", async () => {
    const gate = new MutationAsk(() => {});
    const pending = gate.confirmation(writeCall);
    gate.close();
    expect(await pending).toEqual({ approved: false, gate: "user", reason: "not-now" });
  });

  it("remembers a as the call's derived rule for the rest of the session", async () => {
    const gate = new MutationAsk(() => {});
    const first = gate.confirm(bashCall("git push origin main"));
    expect(gate.pending?.remembers).toEqual([
      { action: "bash", resource: "git push *", effect: "allow" },
    ]);
    gate.handleKey(parseChord("a"), askRows);
    expect(await first).toBe(true);
    expect(gate.sessionRules).toEqual([
      { action: "bash", resource: "git push *", effect: "allow" },
    ]);
    expect(await gate.confirm(bashCall("git push origin dev"))).toBe(true);
    expect(gate.pending).toBeUndefined();

    const other = gate.confirm(bashCall("rm -rf build"));
    expect(gate.pending?.summary).toContain("rm -rf build");
    gate.handleKey(parseChord("n"), askRows);
    gate.handleKey(parseChord("o"), askRows);
    expect(await other).toBe(false);
  });

  it("tells the gate a session grant let a covered call through, and asks for the rest", async () => {
    const gate = new MutationAsk(() => {});
    const first = gate.confirmation(bashCall("git push origin main"));
    gate.handleKey(parseChord("a"), askRows);
    expect(await first).toEqual({ approved: true, gate: "user" });

    expect(await gate.confirmation(bashCall("git push origin dev"))).toEqual({
      approved: true,
      gate: "user",
      scope: "session",
    });
    const other = gate.confirmation(bashCall("rm -rf build"));
    expect(gate.pending?.summary).toContain("rm -rf build");
    gate.handleKey(parseChord("n"), askRows);
    gate.handleKey(parseChord("u"), askRows);
    expect(await other).toEqual({ approved: false, gate: "user", reason: "unsafe" });
  });

  it("approves write once on a and keeps asking, since writes never persist", async () => {
    const gate = new MutationAsk(() => {});
    const first = gate.confirm(writeCall);
    expect(gate.pending?.remembers).toEqual([]);
    gate.handleKey(parseChord("a"), askRows);
    expect(await first).toBe(true);
    expect(gate.sessionRules).toEqual([]);
    const second = gate.confirm(writeCall);
    expect(gate.pending).toBeDefined();
    gate.handleKey(parseChord("n"), askRows);
    gate.handleKey(parseChord("o"), askRows);
    expect(await second).toBe(false);
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
    gate.handleKey(parseChord("o"), askRows);
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
    gate.handleKey(parseChord("o"), askRows);
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
    gate.handleKey(parseChord("o"), 4);
    expect(await verdict).toBe(false);
  });
});
