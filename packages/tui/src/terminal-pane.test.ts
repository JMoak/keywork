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
import {
  describePaneTree,
  dockedIds,
  dockOf,
  mustParse,
  paneContext,
  paneIds,
} from "./testing/workflow-probe.ts";
import { parseWorkspaceState } from "./workspace-state.ts";

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

function terminalProbe(options: { trusted: boolean; spawn?: TerminalSpawner; script?: boolean }) {
  let probe: AppProbe | undefined;
  const factory = terminalPaneFactory({
    cwd: "/repo",
    trusted: () => options.trusted,
    spawn: options.spawn ?? (() => fakeChild()),
    mirror: mirrorSourceOverPanes(() => probe?.core.panes ?? new Map()),
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

  it("renders the shell prompt with the typed line and the child's output", () => {
    const child = fakeChild();
    const pane = new TerminalPane("terminal-1", "shell", () => {}, {
      cwd: "/repo",
      spawn: () => child,
    });
    expect(renderedLines(pane).at(-1)).toBe("❯ ▌");
    for (const character of "pwd") pane.handleKey(parseChord(character), character);
    expect(renderedLines(pane).at(-1)).toBe("❯ pwd▌");
    pane.handleKey(parseChord("enter"));
    child.emit("/repo\n");
    expect(child.written).toEqual(["pwd\n"]);
    expect(pane.title()).toBe(" terminal · shell · fakesh ");
    expect(renderedLines(pane)).toEqual(["❯ pwd", "/repo", "❯ ▌"]);
    expect(renderedLines(pane, { ...paneContext(), focused: false }).at(-1)).toBe("❯ ");
  });

  it("bounds scrollback and keeps the newest lines in view", () => {
    const child = fakeChild();
    const pane = new TerminalPane("terminal-1", "shell", () => {}, {
      spawn: () => child,
      scrollbackLimit: 5,
    });
    child.emit(
      Array.from({ length: 50 }, (_, index) => `line ${index}`)
        .join("\n")
        .concat("\n"),
    );
    expect(pane.model.lineCount()).toBe(5);
    expect(renderedLines(pane, { ...paneContext(), height: 6 })).toEqual(
      expect.arrayContaining(["line 48", "line 49"]),
    );
  });

  it("kills the child on dispose", () => {
    const child = fakeChild();
    const pane = new TerminalPane("terminal-1", "shell", () => {}, { spawn: () => child });
    pane.dispose();
    expect(child.killed).toBe(1);
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

  it("leader shift+t summons the terminal and refocuses it instead of duplicating", () => {
    const probe = terminalProbe({ trusted: true }).keys("ctrl+k", "shift+t");
    expect(paneIds(probe)).toEqual(["session-1", "terminal-1"]);
    probe.keys("ctrl+k", "h");
    expect(probe.snapshot().focused).toBe("session-1");
    probe.keys("shift+t");
    expect(probe.snapshot().focused).toBe("terminal-1");
    expect(paneIds(probe)).toEqual(["session-1", "terminal-1"]);
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

  it("terminal is absent when no terminal factory is wired", () => {
    expect(new AppProbe().command("terminal")).toBe(false);
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

  it("round-trips a mirror descriptor with its session id and rejects bad modes", () => {
    const saved = terminalProbe({ trusted: true }).type("/terminal").keys("enter").workspaceState();
    const withSession = {
      ...saved,
      panes: saved.panes.map((pane) =>
        pane.id === "terminal-1" ? { ...pane, sessionId: "sess-9" } : pane,
      ),
    };
    expect(parseWorkspaceState(withSession)?.panes).toContainEqual({
      id: "terminal-1",
      kind: "terminal",
      mode: "mirror",
      sessionId: "sess-9",
    });
    const badMode = {
      ...saved,
      panes: saved.panes.map((pane) =>
        pane.id === "terminal-1" ? { ...pane, mode: "pty" } : pane,
      ),
    };
    expect(parseWorkspaceState(badMode)).toBeUndefined();
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
