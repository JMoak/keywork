import { Agent, MockProvider, renderCommand, textTurn } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { ConversationPane } from "./conversation-pane.ts";
import {
  type ConversationTarget,
  type ExtensionCommandEntry,
  type ExtensionsPort,
  registerExtensions,
  shadowedExtensionNotice,
} from "./extension-commands.ts";
import { AppProbe } from "./probe.ts";
import { waitFor } from "./testing/index.ts";

async function armedAsk(probe: AppProbe): Promise<void> {
  await waitFor(() => expect(probe.model()?.pendingAsk).toBeDefined());
  probe.model()?.askSeen();
  await waitFor(() => expect(probe.model()?.askHoldsKeys()).toBe(true));
}

function turnRows(probe: AppProbe) {
  return probe.model()?.entries.filter((entry) => entry.kind !== "ledger");
}

function wire(
  probe: AppProbe,
  extensions: Partial<ExtensionsPort>,
  overrides: Partial<ConversationTarget> = {},
): string[] {
  const notices: string[] = [];
  registerExtensions(
    probe.core.registry,
    { commands: [], failures: [], ...extensions },
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
          bot: () => undefined,
          switchBot: () => true,
          ...overrides,
        };
      },
      notice: (text) => notices.push(text),
    },
  );
  return notices;
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

describe("palette-surfaced workspace commands", () => {
  it("runs a command through the guard and submits the rendered prompt as a turn", async () => {
    const probe = new AppProbe({ script: [textTurn("done")] });
    const ran: string[] = [];
    wire(probe, { commands: [shellCommand("ship", "ship notes: !`git log`", ran)] });

    expect(probe.command("ship")).toBe(true);
    await armedAsk(probe);
    probe.keys("y");
    await waitFor(() =>
      expect(turnRows(probe)).toEqual([
        { kind: "user", text: "ship notes: shell-output" },
        { kind: "assistant", text: "done" },
      ]),
    );
    expect(ran).toEqual(["git log"]);
  });

  it("declined shell interpolation fails the render calmly and sends no turn", async () => {
    const probe = new AppProbe({ script: [textTurn("never")] });
    const ran: string[] = [];
    const notices = wire(probe, { commands: [shellCommand("ship", "!`rm -rf /`", ran)] });

    expect(probe.command("ship")).toBe(true);
    await armedAsk(probe);
    probe.keys("n", "o", "escape");
    await waitFor(() =>
      expect(notices).toEqual(["/ship failed: you declined the shell interpolation: rm -rf /"]),
    );
    expect(ran).toEqual([]);
    expect(probe.model()?.entries.filter((entry) => entry.kind === "user")).toEqual([]);
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
    expect(turnRows(probe)?.at(-1)).toEqual({ kind: "assistant", text: "second, as scout" });
  });
});

describe("extension names that collide with built-ins", () => {
  it("reports the shadowed command and keeps the built-in for both the palette and /name", () => {
    const probe = new AppProbe();
    const shadowed = registerExtensions(
      probe.core.registry,
      { commands: [shellCommand("exit", "never runs")], failures: [] },
      { conversation: () => undefined, notice: () => {} },
    );
    expect(shadowed).toEqual([{ name: "exit", claimedBy: "exit" }]);
    expect(shadowedExtensionNotice(shadowed)).toBe(
      "/exit is taken by /exit · the extension command is skipped",
    );
    const byPalette = probe.core.registry.search("exit").filter((c) => c.name === "exit");
    expect(byPalette).toHaveLength(1);
    expect(byPalette[0]?.description).toContain("close this pane");
    probe.command("split");
    expect(probe.command("exit")).toBe(true);
    expect(probe.snapshot().panes.map((pane) => pane.id)).toEqual(["session-1"]);
  });
});
