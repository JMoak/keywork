import { Agent, MockProvider, renderCommand, textTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { ConversationPane } from "./conversation-pane.ts";
import {
  type ConversationTarget,
  type ExtensionCommandEntry,
  type ExtensionsPort,
  extensionFailureNotice,
  registerExtensions,
} from "./extension-commands.ts";
import { AppProbe } from "./probe.ts";

interface Recorded {
  notices: string[];
  switched: (string | undefined)[];
}

function wire(
  probe: AppProbe,
  extensions: Partial<ExtensionsPort>,
  overrides: Partial<ConversationTarget> = {},
): Recorded {
  const recorded: Recorded = { notices: [], switched: [] };
  registerExtensions(
    probe.core.registry,
    { commands: [], agents: [], failures: [], ...extensions },
    {
      conversation: () => {
        const pane = probe.core.panes.get("session-1");
        if (!(pane instanceof ConversationPane)) return undefined;
        return {
          confirmShell: (command) =>
            pane.confirmMutation({
              type: "tool-call",
              callId: "shell-1",
              name: "bash",
              arguments: { command },
            }),
          submitPrompt: (text) => pane.submitPrompt(text),
          switchAgent: (name) => {
            recorded.switched.push(name);
            return true;
          },
          ...overrides,
        };
      },
      notice: (text) => recorded.notices.push(text),
    },
  );
  return recorded;
}

function shellCommand(name: string, template: string, ran: string[] = []): ExtensionCommandEntry {
  return {
    name,
    needsArgs: false,
    render: (args, confirmShell) =>
      renderCommand(template, args, {
        runShell: async (command) => {
          if (!(await confirmShell(command))) {
            throw new Error(`you declined the shell interpolation: ${command}`);
          }
          ran.push(command);
          return "shell-output";
        },
        embedFile: async () => undefined,
      }),
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      assertion();
      return;
    } catch (cause) {
      if (Date.now() > deadline) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe("palette-surfaced workspace commands", () => {
  it("runs a command through the guard and submits the rendered prompt as a turn", async () => {
    const probe = new AppProbe({ script: [textTurn("done")] });
    const ran: string[] = [];
    wire(probe, { commands: [shellCommand("ship", "ship notes: !`git log`", ran)] });

    expect(probe.command("ship")).toBe(true);
    await waitFor(() => expect(probe.model()?.pendingAsk).toBeDefined());
    probe.keys("y");
    await waitFor(() =>
      expect(probe.model()?.entries).toEqual([
        { kind: "user", text: "ship notes: shell-output" },
        { kind: "assistant", text: "done" },
      ]),
    );
    expect(ran).toEqual(["git log"]);
  });

  it("declined shell interpolation fails the render calmly and sends no turn", async () => {
    const probe = new AppProbe({ script: [textTurn("never")] });
    const ran: string[] = [];
    const recorded = wire(probe, { commands: [shellCommand("ship", "!`rm -rf /`", ran)] });

    expect(probe.command("ship")).toBe(true);
    await waitFor(() => expect(probe.model()?.pendingAsk).toBeDefined());
    probe.keys("n");
    await waitFor(() =>
      expect(recorded.notices).toEqual([
        "/ship failed: you declined the shell interpolation: rm -rf /",
      ]),
    );
    expect(ran).toEqual([]);
    expect(probe.model()?.entries.filter((entry) => entry.kind === "user")).toEqual([]);
  });

  it("appears in pane slash suggestions and in the palette, except args-only commands", () => {
    const probe = new AppProbe();
    wire(probe, {
      commands: [
        { name: "plain", needsArgs: false, render: async () => "p" },
        { name: "wants-args", needsArgs: true, render: async (args) => args },
      ],
    });
    probe.keys("ctrl+p").type("plain");
    expect(probe.core.paletteMatches().map((entry) => entry.name)).toContain("plain");
    probe.keys("escape").keys("ctrl+p").type("wants");
    expect(probe.core.paletteMatches().map((entry) => entry.name)).not.toContain("wants-args");
    probe.keys("escape");
    expect(probe.core.registry.search("wants-args")[0]?.name).toBe("wants-args");
  });

  it("notices instead of crashing when no conversation pane exists", async () => {
    const probe = new AppProbe();
    const recorded: Recorded = { notices: [], switched: [] };
    registerExtensions(
      probe.core.registry,
      { commands: [shellCommand("ship", "hi")], agents: [], failures: [] },
      { conversation: () => undefined, notice: (text) => recorded.notices.push(text) },
    );
    expect(probe.command("ship")).toBe(true);
    expect(recorded.notices).toEqual(["/ship: no conversation pane to run in"]);
  });
});

describe("palette-surfaced workspace agents", () => {
  it("registers one entry per agent plus a reset entry, and switches the focused pane", () => {
    const probe = new AppProbe({ script: [] });
    const recorded = wire(probe, {
      agents: [{ name: "scout", description: "reads before writing" }],
    });

    expect(probe.command("agent-scout")).toBe(true);
    expect(probe.command("agent-none")).toBe(true);
    expect(recorded.switched).toEqual(["scout", undefined]);
    expect(recorded.notices).toEqual(["agent → scout", "agent → default"]);
  });

  it("says so when the switch is refused instead of pretending", () => {
    const probe = new AppProbe({ script: [] });
    const recorded = wire(probe, { agents: [{ name: "scout" }] }, { switchAgent: () => false });
    expect(probe.command("agent-scout")).toBe(true);
    expect(recorded.notices).toEqual(["agent busy · finish the turn first"]);
  });

  it("registers no agent entries when none are defined", () => {
    const probe = new AppProbe();
    wire(probe, {});
    expect(probe.command("agent-none")).toBe(false);
  });
});

describe("extensionFailureNotice", () => {
  it("collapses failures into one calm line", () => {
    expect(extensionFailureNotice([])).toBeUndefined();
    expect(extensionFailureNotice(["a.md: bad frontmatter"])).toBe(
      "skipped extension a.md: bad frontmatter",
    );
    expect(extensionFailureNotice(["a.md: x", "b.md: y", "c.md: z"])).toBe(
      "skipped extension a.md: x (+2 more)",
    );
  });
});

describe("pane agent swap keeps the transcript wired", () => {
  it("a swapped-in agent on the shared bus keeps streaming into the same pane", async () => {
    const probe = new AppProbe({ script: [textTurn("first")] });
    probe.type("one").keys("enter");
    await probe.settled();

    const pane = probe.core.panes.get("session-1") as ConversationPane;
    const previous = pane.currentAgent();
    expect(previous).toBeDefined();
    if (previous === undefined) return;
    const next = new Agent({
      provider: new MockProvider([textTurn("second, as scout")]),
      history: previous.history(),
      bus: previous.bus,
    });
    pane.swapAgent(next);

    probe.type("two").keys("enter");
    await probe.settled();
    expect(pane.currentAgent()).toBe(next);
    expect(probe.model()?.entries.at(-1)).toEqual({
      kind: "assistant",
      text: "second, as scout",
    });
  });
});
