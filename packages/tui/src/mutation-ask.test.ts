import type { ToolCallPart } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import type { FileReader } from "./diff-render.ts";
import { parseChord } from "./keys.ts";
import { askArmingMs, MutationAsk } from "./mutation-ask.ts";

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

function askGate(readFile?: FileReader): { gate: MutationAsk; arm: () => void } {
  let nowMs = 0;
  const gate = new MutationAsk(
    () => {},
    readFile,
    () => nowMs,
  );
  const arm = () => {
    gate.seen();
    nowMs += askArmingMs;
  };
  return { gate, arm };
}

describe("MutationAsk", () => {
  it("answers nothing until it has been seen for the arming time", async () => {
    const { gate, arm } = askGate();
    const verdict = gate.confirm(writeCall);
    expect(gate.pending?.summary).toContain("write");
    expect(gate.handleKey(parseChord("y"), askRows)).toBe(false);
    expect(gate.pending).toBeDefined();
    gate.seen();
    expect(gate.armed()).toBe(false);
    expect(gate.handleKey(parseChord("y"), askRows)).toBe(false);

    arm();
    expect(gate.armed()).toBe(true);
    expect(gate.handleKey(parseChord("z"), askRows)).toBe(false);
    expect(gate.pending).toBeDefined();
    gate.handleKey(parseChord("y"), askRows);
    expect(await verdict).toBe(true);
    expect(gate.pending).toBeUndefined();
  });

  it("holds the arming again whenever asked to", () => {
    const { gate, arm } = askGate();
    void gate.confirm(writeCall);
    arm();
    gate.holdArming();
    expect(gate.armed()).toBe(false);
    expect(gate.handleKey(parseChord("y"), askRows)).toBe(false);
    gate.close();
  });

  it("forgets a remembered session rule so the next call asks again", async () => {
    const { gate, arm } = askGate();
    const first = gate.confirm(bashCall("git push origin main"));
    arm();
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
    arm();
    gate.handleKey(parseChord("n"), askRows);
    gate.handleKey(parseChord("n"), askRows);
    expect(await again).toBe(false);
  });

  it("denies on n and on escape", async () => {
    const { gate, arm } = askGate();
    const first = gate.confirm(writeCall);
    arm();
    gate.handleKey(parseChord("n"), askRows);
    gate.handleKey(parseChord("n"), askRows);
    expect(await first).toBe(false);

    const second = gate.confirm(writeCall);
    arm();
    gate.handleKey(parseChord("escape"), askRows);
    gate.handleKey(parseChord("escape"), askRows);
    expect(await second).toBe(false);
  });

  it("asks why after a deny and tells the gate the reason", async () => {
    const { gate, arm } = askGate();
    const unsafe = gate.confirmation(writeCall);
    arm();
    gate.handleKey(parseChord("n"), askRows);
    expect(gate.pending?.stage).toBe("reason");
    expect(gate.handleKey(parseChord("y"), askRows)).toBe(false);
    expect(gate.pending?.stage).toBe("reason");
    gate.handleKey(parseChord("u"), askRows);
    expect(await unsafe).toEqual({ approved: false, gate: "user", reason: "unsafe" });

    const notNow = gate.confirmation(writeCall);
    arm();
    gate.handleKey(parseChord("n"), askRows);
    gate.handleKey(parseChord("n"), askRows);
    expect(await notNow).toEqual({ approved: false, gate: "user", reason: "not-now" });

    const other = gate.confirmation(writeCall);
    arm();
    gate.handleKey(parseChord("escape"), askRows);
    gate.handleKey(parseChord("enter"), askRows);
    expect(await other).toEqual({ approved: false, gate: "user", reason: "other" });

    const allowed = gate.confirmation(writeCall);
    arm();
    gate.handleKey(parseChord("y"), askRows);
    expect(await allowed).toEqual({ approved: true, gate: "user" });
  });

  it("opens a line for the person's own words on o and sends them as the note", async () => {
    const { gate, arm } = askGate();
    const noted = gate.confirmation(writeCall);
    arm();
    gate.handleKey(parseChord("n"), askRows);
    gate.handleKey(parseChord("o"), askRows);
    expect(gate.pending?.stage).toBe("note");
    gate.handleKey(parseChord("y"), askRows, "y");
    gate.handleKey(parseChord("y"), askRows, "y");
    gate.handleKey(parseChord("backspace"), askRows);
    expect(gate.takesPaste("es,  wrong file")).toBe(true);
    expect(gate.pending?.note).toBe("yes, wrong file");
    gate.handleKey(parseChord("enter"), askRows);
    expect(await noted).toEqual({
      approved: false,
      gate: "user",
      reason: "other",
      note: "yes, wrong file",
    });

    const skipped = gate.confirmation(writeCall);
    arm();
    gate.handleKey(parseChord("n"), askRows);
    gate.handleKey(parseChord("o"), askRows);
    gate.handleKey(parseChord("escape"), askRows);
    expect(await skipped).toEqual({ approved: false, gate: "user", reason: "other" });
  });

  it("answers not now for every ask a closing pane leaves behind", async () => {
    const { gate } = askGate();
    const pending = gate.confirmation(writeCall);
    gate.close();
    expect(await pending).toEqual({ approved: false, gate: "user", reason: "not-now" });
  });

  it("remembers a as the call's derived rule for the rest of the session", async () => {
    const { gate, arm } = askGate();
    const first = gate.confirm(bashCall("git push origin main"));
    expect(gate.pending?.remembers).toEqual([
      { action: "bash", resource: "git push *", effect: "allow" },
    ]);
    arm();
    gate.handleKey(parseChord("a"), askRows);
    expect(await first).toBe(true);
    expect(gate.sessionRules).toEqual([
      { action: "bash", resource: "git push *", effect: "allow" },
    ]);
    expect(await gate.confirm(bashCall("git push origin dev"))).toBe(true);
    expect(gate.pending).toBeUndefined();

    const other = gate.confirm(bashCall("rm -rf build"));
    expect(gate.pending?.summary).toContain("rm -rf build");
    arm();
    gate.handleKey(parseChord("n"), askRows);
    gate.handleKey(parseChord("n"), askRows);
    expect(await other).toBe(false);
  });

  it("answers a as a session grant and lets the covered calls through as one", async () => {
    const { gate, arm } = askGate();
    const first = gate.confirmation(bashCall("git push origin main"));
    arm();
    gate.handleKey(parseChord("a"), askRows);
    expect(await first).toEqual({ approved: true, gate: "user", scope: "session" });

    expect(await gate.confirmation(bashCall("git push origin dev"))).toEqual({
      approved: true,
      gate: "user",
      scope: "session",
      asked: false,
    });
    const other = gate.confirmation(bashCall("rm -rf build"));
    expect(gate.pending?.summary).toContain("rm -rf build");
    arm();
    gate.handleKey(parseChord("n"), askRows);
    gate.handleKey(parseChord("u"), askRows);
    expect(await other).toEqual({ approved: false, gate: "user", reason: "unsafe" });
  });

  it("approves write once on a and keeps asking, since writes never persist", async () => {
    const { gate, arm } = askGate();
    const first = gate.confirm(writeCall);
    expect(gate.pending?.remembers).toEqual([]);
    arm();
    gate.handleKey(parseChord("a"), askRows);
    expect(await first).toBe(true);
    expect(gate.sessionRules).toEqual([]);
    const second = gate.confirm(writeCall);
    expect(gate.pending).toBeDefined();
    arm();
    gate.handleKey(parseChord("n"), askRows);
    gate.handleKey(parseChord("n"), askRows);
    expect(await second).toBe(false);
  });

  it("ignores modified chords so ctrl+a and meta+y neither approve nor remember", async () => {
    const { gate, arm } = askGate();
    const verdict = gate.confirm(writeCall);
    arm();
    expect(gate.handleKey({ name: "a", ctrl: true, shift: false, meta: false }, askRows)).toBe(
      false,
    );
    expect(gate.handleKey({ name: "y", ctrl: false, shift: false, meta: true }, askRows)).toBe(
      false,
    );
    expect(gate.pending).toBeDefined();
    gate.handleKey(parseChord("n"), askRows);
    gate.handleKey(parseChord("n"), askRows);
    expect(await verdict).toBe(false);

    const next = gate.confirm(writeCall);
    expect(gate.pending).toBeDefined();
    arm();
    gate.handleKey(parseChord("y"), askRows);
    expect(await next).toBe(true);
  });

  it("queues a second ask behind the first and arms each in turn", async () => {
    const { gate, arm } = askGate();
    const first = gate.confirm(writeCall);
    const second = gate.confirm({ ...writeCall, callId: "call-2", name: "edit" });
    expect(gate.pending?.summary).toContain("write");
    arm();
    gate.handleKey(parseChord("y"), askRows);
    expect(await first).toBe(true);
    expect(gate.pending?.summary).toContain("edit");
    expect(gate.handleKey(parseChord("y"), askRows)).toBe(false);
    arm();
    gate.handleKey(parseChord("n"), askRows);
    gate.handleKey(parseChord("n"), askRows);
    expect(await second).toBe(false);
    expect(gate.pending).toBeUndefined();
  });

  it("denies every pending ask when closed and refuses new ones", async () => {
    const { gate } = askGate();
    const pending = gate.confirm(writeCall);
    gate.close();
    expect(await pending).toBe(false);
    expect(await gate.confirm(writeCall)).toBe(false);
    expect(gate.pending).toBeUndefined();
  });

  it("reads a call as its subject and the diff's facts instead of raw json", () => {
    const files: Record<string, string> = { "notes.txt": "alpha\nbeta\n" };
    const edited = askGate((path) => files[path]);
    void edited.gate.confirm({
      ...writeCall,
      arguments: { path: "notes.txt", content: "alpha\nBETA\n" },
    });
    expect(edited.gate.pending?.summary).toBe("write notes.txt · +1 -1");
    edited.gate.close();

    const created = askGate((path) => files[path]);
    void created.gate.confirm({ ...writeCall, arguments: { path: "new.txt", content: "a\nb\n" } });
    expect(created.gate.pending?.summary).toBe("write new.txt · new · 2 lines");
    created.gate.close();

    const { gate } = askGate();
    void gate.confirm(bashCall("npm   test"));
    expect(gate.pending?.summary).toBe("bash npm test");
    gate.close();
  });

  it("scrolls a diff with the arrows and pages by the rows it was given", async () => {
    const lines = Array.from({ length: 30 }, (_, at) => `line ${at + 1}`);
    const files: Record<string, string> = { "notes.txt": lines.join("\n") };
    const { gate, arm } = askGate((path) => files[path]);
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
    arm();
    gate.handleKey(parseChord("n"), 4);
    gate.handleKey(parseChord("n"), 4);
    expect(await verdict).toBe(false);
  });
});
