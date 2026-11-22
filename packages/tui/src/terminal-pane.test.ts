import { describe, expect, it } from "vitest";
import { ConversationPane } from "./conversation-pane.ts";
import { parseChord } from "./keys.ts";
import { AppProbe } from "./probe.ts";
import { type TerminalChild, TerminalModel, type TerminalSpawner } from "./terminal-model.ts";
import {
  mirrorSourceOverPanes,
  TerminalPane,
  terminalPaneFactory,
  untrustedShellNotice,
} from "./terminal-pane.ts";
import { type FakeBackend, fakePtyBackend } from "./testing/fake-terminal-backend.ts";
import {
  describePaneTree,
  dockedIds,
  dockOf,
  mustParse,
  paneContext,
  paneIds,
} from "./testing/workflow-probe.ts";

function fakeChild(): TerminalChild & {
  written: string[];
  killed: number;
  emit: (chunk: string) => void;
} {
  const outputs = new Set<(chunk: string) => void>();
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
    onExit: () => () => {},
    kill() {
      this.killed += 1;
    },
    emit: (chunk) => {
      for (const listener of outputs) listener(chunk);
    },
  };
}

function renderedLines(pane: TerminalPane, context = paneContext()): string[] {
  const lines: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const { content, children } = node as { content?: unknown; children?: unknown[] };
    if (typeof content === "string") lines.push(content);
    for (const child of children ?? []) walk(child);
  };
  walk(describePaneTree(pane.view(context)));
  return lines;
}

function terminalProbe(options: {
  trusted: boolean;
  spawn?: TerminalSpawner;
  script?: boolean;
  pty?: FakeBackend;
}) {
  let probe: AppProbe | undefined;
  const pty = options.pty;
  const factory = terminalPaneFactory({
    cwd: "/repo",
    trusted: () => options.trusted,
    spawn: options.spawn ?? (() => fakeChild()),
    mirror: mirrorSourceOverPanes(() => probe?.core.panes ?? new Map()),
    ...(pty !== undefined && { pty: { available: true, open: pty.open }, surfaces: pty.surface }),
  });
  probe = new AppProbe({
    createTerminalPane: factory,
    ...(options.script === true && {
      script: [[{ type: "done", usage: { inputTokens: 0, outputTokens: 0 } }]],
    }),
  });
  return probe;
}

describe("TerminalPane rendering", () => {
  it("renders the mirror mode empty hint, then the mirrored command within one frame", () => {
    const probe = terminalProbe({ trusted: true, script: true }).keys("ctrl+k", "shift+t");
    const pane = probe.core.panes.get("terminal-1");
    expect(pane).toBeInstanceOf(TerminalPane);
    if (!(pane instanceof TerminalPane)) return;
    expect(renderedLines(pane)).toContain("agent shell commands appear here");
    expect(pane.title()).toBe(" terminal · mirroring ");
    const conversation = probe.core.panes.get("session-1");
    const bus =
      conversation instanceof ConversationPane ? conversation.currentAgent()?.bus : undefined;
    expect(bus).toBeDefined();
    bus?.emit("tool.started", {
      call: { type: "tool-call", callId: "c1", name: "bash", arguments: { command: "bun test" } },
    });
    bus?.emit("tool.output", { chunk: "3 passed\n", callId: "c1" });
    bus?.emit("tool.finished", { callId: "c1", output: "3 passed\n", isError: false });
    expect(renderedLines(pane)).toEqual(
      expect.arrayContaining(["$ bun test", "3 passed", "· done"]),
    );
  });
});

describe("TerminalPane over a pty", () => {
  function ptyPane(backend = fakePtyBackend()) {
    const pane = new TerminalPane("terminal-1", "shell", () => {}, { cwd: "/repo", backend });
    return { pane, backend };
  }

  it("renders the surface inside the pane chrome and describes itself as a shell", () => {
    const { pane } = ptyPane();
    expect(pane.title()).toBe(" terminal · shell · fakesh ");
    expect(renderedLines(pane)).toEqual(["<terminal surface>"]);
    expect(pane.describe()).toEqual({ kind: "terminal", mode: "shell" });
    expect(pane.model).toBeUndefined();
  });

  it("sizes the pty to the pane's content area and follows the pane geometry", () => {
    const { pane, backend } = ptyPane();
    pane.view(paneContext());
    pane.view({ ...paneContext(), width: 100, height: 40, chrome: "seams" });
    const process = backend.processes[0];
    expect(process?.resizes).toEqual([
      { cols: 56, rows: 18 },
      { cols: 98, rows: 39 },
    ]);
  });

  it("routes keys and pastes to the child and kills it on dispose", () => {
    const { pane, backend } = ptyPane();
    pane.handleKey(parseChord("escape"), "\x1b");
    pane.handlePaste("echo hi\n");
    pane.dispose();
    expect(backend.processes[0]?.written).toEqual(["<\x1b>", "[paste:echo hi\n]"]);
    expect(backend.processes[0]?.killed).toBe(1);
    expect(backend.surfaces[0]?.released).toBe(1);
  });
});

describe("terminal pane key policy with a pty (keywork keeps its chords, the pty gets the rest)", () => {
  function focusedShell() {
    const pty = fakePtyBackend();
    const probe = terminalProbe({ trusted: true, pty });
    expect(probe.command("terminal shell")).toBe(true);
    expect(probe.snapshot().focused).toBe("terminal-1");
    const written = () => pty.processes[0]?.written ?? [];
    return { probe, pty, written };
  }

  it("sends plain keys, escape, ctrl+c and arrows to the pty", () => {
    const { probe, written } = focusedShell();
    probe.keys("a", "escape", "ctrl+c", "up");
    expect(written()).toEqual(["<a>", "<escape>", "<ctrl+c>", "<up>"]);
  });

  it("keeps the leader chord and the pane-navigation verbs under it", () => {
    const { probe, written } = focusedShell();
    probe.keys("ctrl+k", "h");
    expect(probe.snapshot().focused).toBe("session-1");
    expect(written()).toEqual([]);
    probe.keys("l");
    expect(probe.snapshot().focused).toBe("terminal-1");
    probe.keys("shift+t");
    expect(written()).toEqual([]);
    probe.keys("l");
    expect(written()).toEqual(["<l>"]);
  });

  it("stops routing keys to a closed pane's pty and kills its child", () => {
    const { probe, pty, written } = focusedShell();
    probe.keys("ctrl+k", "x");
    expect(pty.processes[0]?.killed).toBe(1);
    probe.keys("a");
    expect(written()).toEqual([]);
  });
});

describe("terminal pane workflows", () => {
  it("/terminal opens a mirror pane docked right and focused", () => {
    const probe = terminalProbe({ trusted: true }).type("/terminal").keys("enter");
    expect(paneIds(probe)).toEqual(["session-1", "terminal-1"]);
    expect(dockedIds(probe)).toEqual(["terminal-1"]);
    expect(dockOf(probe, "terminal-1")).toBe("right");
    expect(probe.snapshot().focused).toBe("terminal-1");
  });

  it("/term shell opens a shell pane beside the mirror and refocuses by mode", () => {
    const probe = terminalProbe({ trusted: true }).type("/terminal").keys("enter");
    expect(probe.command("term shell")).toBe(true);
    expect(paneIds(probe)).toEqual(["session-1", "terminal-1", "terminal-2"]);
    expect(probe.snapshot().focused).toBe("terminal-2");
    expect(probe.command("terminal mirror")).toBe(true);
    expect(probe.snapshot().focused).toBe("terminal-1");
    expect(paneIds(probe)).toEqual(["session-1", "terminal-1", "terminal-2"]);
  });

  it("refuses shell mode in an untrusted workspace with a notice", () => {
    const probe = terminalProbe({ trusted: false }).type("/terminal shell").keys("enter");
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.snapshot().notice).toBe(untrustedShellNotice);
    probe.type("/terminal").keys("enter");
    expect(paneIds(probe)).toEqual(["session-1", "terminal-1"]);
  });

  it("describes both modes and revives them from the saved workspace", () => {
    const spawned: string[] = [];
    const probe = terminalProbe({
      trusted: true,
      spawn: (cwd) => {
        spawned.push(cwd);
        return fakeChild();
      },
    })
      .type("/terminal")
      .keys("enter");
    probe.command("terminal shell");
    const state = mustParse(probe.workspaceState());
    expect(state.panes).toEqual([
      { id: "session-1", kind: "conversation" },
      { id: "terminal-1", kind: "terminal", mode: "mirror" },
      { id: "terminal-2", kind: "terminal", mode: "shell" },
    ]);
    expect(spawned).toEqual(["/repo"]);
    const restored = new AppProbe({
      createTerminalPane: terminalPaneFactory({
        cwd: "/repo",
        trusted: () => true,
        spawn: (cwd) => {
          spawned.push(cwd);
          return fakeChild();
        },
        mirror: { locate: () => undefined },
      }),
      restoreWorkspace: state,
    });
    expect(paneIds(restored)).toEqual(["session-1", "terminal-1", "terminal-2"]);
    expect(spawned).toEqual(["/repo", "/repo"]);
    expect(restored.core.panes.get("terminal-1")?.describe?.()).toEqual({
      kind: "terminal",
      mode: "mirror",
    });
  });

  it("revived mirrors find their session by id once its pane has an agent", () => {
    const probe = terminalProbe({ trusted: true, script: true });
    const model = new TerminalModel({
      mode: "mirror",
      notify: () => {},
      mirror: mirrorSourceOverPanes(() => probe.core.panes),
      target: { sessionId: "sess-1" },
    });
    model.visibleLines(5, 40);
    expect(model.following()).toBe(false);
    const conversation = probe.core.panes.get("session-1");
    if (conversation instanceof ConversationPane) conversation.sessionId = "sess-1";
    model.visibleLines(5, 40);
    expect(model.following()).toBe(true);
    expect(model.sessionId).toBe("sess-1");
  });
});
