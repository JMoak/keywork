import { Agent, MockProvider, textTurn, toolCallTurn } from "@keywork/engine";
import type { ActivePreset } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import { ConversationPane } from "./conversation-pane.ts";
import { helpFrame, type PresetsPort } from "./overlays/index.ts";
import { AppProbe } from "./probe.ts";
import { waitFor } from "./testing/index.ts";

describe("preset overlay", () => {
  function presetProbe(overrides?: Partial<PresetsPort>) {
    const applied: string[] = [];
    let active: ActivePreset = "standard";
    const port: PresetsPort = {
      names: () => ["careful", "standard", "open"],
      active: () => active,
      requiresConfirmation: (name) => name === "open",
      apply: async (name) => {
        applied.push(name);
        active = name;
      },
      ...overrides,
    };
    const probe = new AppProbe({ presets: port });
    return { probe, applied, setActive: (name: ActivePreset) => (active = name) };
  }

  it("/preset opens the picker with the active preset marked", () => {
    const { probe } = presetProbe();
    probe.type("/preset").keys("enter");
    expect(probe.snapshot().overlay).toBe("preset");
    expect(probe.core.presetPicker()).toEqual({
      names: ["careful", "standard", "open"],
      active: "standard",
      index: 1,
    });
  });

  it("choosing the active preset just closes with a notice", () => {
    const { probe, applied } = presetProbe();
    probe.command("preset");
    probe.keys("enter");
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(probe.snapshot().notice).toBe("already on standard");
    expect(applied).toEqual([]);
  });

  it("tightening applies without confirmation", async () => {
    const { probe, applied } = presetProbe();
    probe.command("preset");
    probe.keys("up", "enter");
    await waitFor(() => expect(probe.snapshot().notice).toBe("permissions preset → careful"));
    expect(applied).toEqual(["careful"]);
    expect(probe.snapshot().overlay).toBeUndefined();
  });

  it("loosening asks first; declining leaves the matrix untouched and closes", () => {
    const { probe, applied } = presetProbe();
    probe.command("preset");
    probe.keys("down", "enter");
    expect(probe.snapshot().overlay).toBe("preset-confirm");
    expect(probe.core.presetConfirmation()).toEqual({ from: "standard", to: "open" });
    probe.keys("n");
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(applied).toEqual([]);
  });

  it("loosening applies after an explicit y", async () => {
    const { probe, applied } = presetProbe();
    probe.command("preset");
    probe.keys("down", "enter", "y");
    await waitFor(() => expect(probe.snapshot().notice).toBe("permissions preset → open"));
    expect(applied).toEqual(["open"]);
  });

  it("chooses the preset under a click, follows hover, and closes on a click outside", async () => {
    const { probe, applied } = presetProbe();
    probe.command("preset");
    const frame = helpFrame(probe.screen, 3);
    probe.hover(frame.x + 2, frame.firstRowY + 2);
    expect(probe.core.presetPicker()?.index).toBe(2);
    probe.click(frame.x + 2, frame.firstRowY);
    await waitFor(() => expect(probe.snapshot().notice).toBe("permissions preset → careful"));
    expect(applied).toEqual(["careful"]);

    probe.command("preset");
    probe.click(0, 0);
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(applied).toEqual(["careful"]);
  });

  it("keeps the confirmation up on a click inside it and cancels on a click outside", () => {
    const { probe, applied } = presetProbe();
    probe.command("preset");
    probe.keys("down", "enter");
    const frame = helpFrame(probe.screen, 2);
    probe.click(frame.x + 1, frame.y + 1);
    expect(probe.snapshot().overlay).toBe("preset-confirm");
    probe.click(0, 0);
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(applied).toEqual([]);
  });

  it("derives the active preset live instead of caching it", () => {
    const { probe, setActive } = presetProbe();
    probe.command("preset");
    expect(probe.core.presetPicker()?.active).toBe("standard");
    setActive("open");
    expect(probe.core.presetPicker()?.active).toBe("open");
  });

  it("marks a custom matrix that matches no preset", () => {
    const { probe, setActive } = presetProbe();
    setActive("custom");
    probe.command("preset");
    const picker = probe.core.presetPicker();
    expect(picker?.active).toBe("custom");
    expect(picker?.names).not.toContain("custom");
    expect(picker?.index).toBe(0);
  });

  it("takes key precedence over a pending ask and hands keys back afterwards", async () => {
    const executed: string[] = [];
    const applied: string[] = [];
    const port: PresetsPort = {
      names: () => ["careful", "standard", "open"],
      active: () => "standard",
      requiresConfirmation: (name) => name === "open",
      apply: async (name) => {
        applied.push(name);
      },
    };
    const probe = new AppProbe({
      presets: port,
      createPane: (id, notify, commands) => {
        let pane: ConversationPane | undefined;
        const agent = new Agent({
          provider: new MockProvider([
            toolCallTurn({ type: "tool-call", callId: "c1", name: "scribble", arguments: {} }),
            textTurn("done"),
          ]),
          tools: [
            {
              name: "scribble",
              description: "writes",
              parameters: { type: "object" },
              mutates: true,
              execute: async () => {
                executed.push("scribble");
                return "wrote";
              },
            },
          ],
          guard: { confirm: (call) => pane?.confirmMutation(call) ?? Promise.resolve(true) },
        });
        pane = new ConversationPane(id, agent, notify, undefined, commands);
        return pane;
      },
    });

    probe.type("go").keys("enter");
    await waitFor(() => expect(probe.model()?.pendingAsk).toBeDefined());

    probe.command("preset");
    probe.keys("down", "enter", "y");
    await waitFor(() => expect(applied).toEqual(["open"]));
    expect(probe.model()?.pendingAsk).toBeDefined();
    expect(executed).toEqual([]);

    probe.keys("y");
    await probe.settled();
    expect(executed).toEqual(["scribble"]);
  });

  it("preset is absent when no port is wired", () => {
    expect(new AppProbe().command("preset")).toBe(false);
  });
});
