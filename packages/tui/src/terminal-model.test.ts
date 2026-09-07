import { EventBus } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import {
  type MirrorSource,
  type TerminalChild,
  TerminalModel,
  TerminalScrollback,
} from "./terminal-model.ts";

function fakeChild(): TerminalChild & {
  written: string[];
  killed: number;
  emit: (chunk: string) => void;
  exit: (code: number | null) => void;
} {
  const outputs = new Set<(chunk: string) => void>();
  const exits = new Set<(code: number | null) => void>();
  return {
    shellName: "fakesh",
    written: [],
    killed: 0,
    write(text) {
      this.written.push(text);
    },
    onOutput: (listener) => {
      outputs.add(listener);
      return () => outputs.delete(listener);
    },
    onExit: (listener) => {
      exits.add(listener);
      return () => exits.delete(listener);
    },
    kill() {
      this.killed += 1;
    },
    emit: (chunk) => {
      for (const listener of outputs) listener(chunk);
    },
    exit: (code) => {
      for (const listener of exits) listener(code);
    },
  };
}

function mirrorOver(bus: EventBus, sessionId?: string): MirrorSource {
  return { locate: () => ({ bus, ...(sessionId !== undefined && { sessionId }) }) };
}

const texts = (model: TerminalModel, rows = 20) =>
  model.visibleLines(rows, 80).map((line) => `${line.tone}:${line.text}`);

describe("TerminalModel mirror mode", () => {
  it("shows the started command, streamed chunks, and the finished marker", () => {
    const bus = new EventBus();
    let notified = 0;
    const model = new TerminalModel({
      mode: "mirror",
      notify: () => {
        notified += 1;
      },
      mirror: mirrorOver(bus, "sess-1"),
    });
    expect(model.following()).toBe(false);
    expect(texts(model)).toEqual([]);
    expect(model.following()).toBe(true);
    expect(model.sessionId).toBe("sess-1");

    bus.emit("tool.started", {
      call: { type: "tool-call", callId: "c1", name: "bash", arguments: { command: "ls -1" } },
    });
    bus.emit("tool.output", { chunk: "a.ts\nb.", callId: "c1" });
    bus.emit("tool.output", { chunk: "ts\n", callId: "c1" });
    bus.emit("tool.finished", { callId: "c1", output: "a.ts\nb.ts\n", isError: false });
    expect(texts(model)).toEqual([
      "command:$ ls -1",
      "output:a.ts",
      "output:b.ts",
      "marker:· done",
    ]);
    expect(notified).toBe(4);
  });

  it("falls back to the finished output when nothing streamed and marks failures", () => {
    const bus = new EventBus();
    const model = new TerminalModel({ mode: "mirror", notify: () => {}, mirror: mirrorOver(bus) });
    texts(model);
    bus.emit("tool.started", {
      call: { type: "tool-call", callId: "c1", name: "bash", arguments: { command: "false" } },
    });
    bus.emit("tool.finished", { callId: "c1", output: "exit 1", isError: true });
    expect(texts(model)).toEqual(["command:$ false", "output:exit 1", "failure:· failed"]);
  });

  it("ignores tools that are not shells and output for unknown calls", () => {
    const bus = new EventBus();
    const model = new TerminalModel({ mode: "mirror", notify: () => {}, mirror: mirrorOver(bus) });
    texts(model);
    bus.emit("tool.started", {
      call: { type: "tool-call", callId: "w1", name: "write", arguments: { path: "x" } },
    });
    bus.emit("tool.output", { chunk: "noise\n", callId: "w1" });
    bus.emit("tool.finished", { callId: "w1", output: "", isError: false });
    expect(texts(model)).toEqual([]);
    expect(model.status()).toBe("mirroring");
  });

  it("keeps trying to locate a bus until one exists and unsubscribes on dispose", () => {
    const bus = new EventBus();
    let available = false;
    const model = new TerminalModel({
      mode: "mirror",
      notify: () => {},
      mirror: { locate: () => (available ? { bus } : undefined) },
    });
    texts(model);
    expect(model.status()).toBe("waiting for a session to mirror");
    available = true;
    texts(model);
    expect(model.following()).toBe(true);
    expect(bus.listenerCount()).toBe(3);
    model.dispose();
    expect(bus.listenerCount()).toBe(0);
  });

  it("scrolls with j/k and pages, pinned to the end by default", () => {
    const bus = new EventBus();
    const model = new TerminalModel({ mode: "mirror", notify: () => {}, mirror: mirrorOver(bus) });
    texts(model);
    bus.emit("tool.started", {
      call: { type: "tool-call", callId: "c1", name: "bash", arguments: { command: "seq" } },
    });
    bus.emit("tool.output", { chunk: "1\n2\n3\n4\n5\n", callId: "c1" });
    expect(texts(model, 2)).toEqual(["output:4", "output:5"]);
    expect(model.handleKey(parseChord("k"), 2)).toBe(true);
    expect(texts(model, 2)).toEqual(["output:3", "output:4"]);
    expect(model.handleKey(parseChord("pageup"), 2)).toBe(true);
    expect(texts(model, 2)).toEqual(["output:1", "output:2"]);
    expect(model.handleKey(parseChord("shift+g"), 2)).toBe(true);
    expect(model.atEnd()).toBe(true);
    expect(model.handleKey(parseChord("x"), 2)).toBe(false);
  });
});

describe("TerminalModel shell mode", () => {
  it("spawns on construction, sends typed lines to the child, and renders its output", () => {
    const child = fakeChild();
    const model = new TerminalModel({
      mode: "shell",
      notify: () => {},
      cwd: "/repo",
      spawn: (cwd) => {
        expect(cwd).toBe("/repo");
        return child;
      },
    });
    expect(model.shellRunning()).toBe(true);
    expect(model.status()).toBe("shell · fakesh");
    for (const character of "echo hi") {
      expect(
        model.handleKey(parseChord(character === " " ? "space" : character), 5, character),
      ).toBe(true);
    }
    expect(model.handleKey(parseChord("backspace"), 5)).toBe(true);
    model.handleKey(parseChord("i"), 5, "i");
    expect(model.input).toBe("echo hi");
    expect(model.handleKey(parseChord("enter"), 5)).toBe(true);
    expect(child.written).toEqual(["echo hi\n"]);
    expect(model.input).toBe("");
    child.emit("hi\r\n");
    expect(texts(model)).toEqual(["input:❯ echo hi", "output:hi"]);
  });

  it("does not steer scrollback with plain letters while a shell is live", () => {
    const child = fakeChild();
    const model = new TerminalModel({ mode: "shell", notify: () => {}, spawn: () => child });
    model.handleKey(parseChord("j"), 5, "j");
    model.handleKey(parseChord("k"), 5, "k");
    expect(model.input).toBe("jk");
  });

  it("marks a child exit and restarts the shell on the next enter", () => {
    const children = [fakeChild(), fakeChild()];
    let spawned = 0;
    const model = new TerminalModel({
      mode: "shell",
      notify: () => {},
      spawn: () => children[spawned++] as TerminalChild,
    });
    children[0]?.exit(2);
    expect(model.shellRunning()).toBe(false);
    expect(model.status()).toBe("shell exited · enter restarts it");
    expect(texts(model)).toEqual(["marker:· shell exited (2)"]);
    model.handleKey(parseChord("enter"), 5);
    expect(spawned).toBe(2);
    expect(children[1]?.written).toEqual(["\n"]);
  });

  it("kills the child on dispose and ignores its later output", () => {
    const child = fakeChild();
    let notified = 0;
    const model = new TerminalModel({
      mode: "shell",
      notify: () => {
        notified += 1;
      },
      spawn: () => child,
    });
    model.dispose();
    expect(child.killed).toBe(1);
    child.emit("late\n");
    expect(notified).toBe(0);
    expect(model.shellRunning()).toBe(false);
  });

  it("stays without a shell when no spawner is wired", () => {
    const model = new TerminalModel({ mode: "shell", notify: () => {} });
    expect(model.shellRunning()).toBe(false);
    expect(model.status()).toBe("no shell");
  });
});

describe("TerminalScrollback", () => {
  it("strips ANSI, honors carriage returns, and drops control bytes", () => {
    const scrollback = new TerminalScrollback(100);
    scrollback.push("\u001b[32mgreen\u001b[0m\n", "output");
    scrollback.push("progress 10%\rprogress 100%\n", "output");
    scrollback.push("bell\ttab\n", "output");
    expect(scrollback.visible(10, 80).map((line) => line.text)).toEqual([
      "green",
      "progress 100%",
      "belltab",
    ]);
  });

  it("keeps a partial line open across chunks and clips to the width", () => {
    const scrollback = new TerminalScrollback(100);
    scrollback.push("abc", "output");
    scrollback.push("def\n", "output");
    expect(scrollback.visible(10, 4).map((line) => line.text)).toEqual(["abcd"]);
    expect(scrollback.lineCount()).toBe(1);
  });

  it("is bounded to the configured line limit", () => {
    const scrollback = new TerminalScrollback(3);
    scrollback.push("1\n2\n3\n4\n5\n", "output");
    expect(scrollback.lineCount()).toBe(3);
    expect(scrollback.visible(10, 80).map((line) => line.text)).toEqual(["3", "4", "5"]);
    scrollback.scrollBy(-10);
    expect(scrollback.visible(2, 80).map((line) => line.text)).toEqual(["3", "4"]);
  });
});
