import { describe, expect, it } from "vitest";
import { helpFrame, paletteFrame } from "./app-core.ts";
import type {
  ConnectionsPort,
  ConnectionTarget,
  InferencePort,
  ModelChoice,
} from "./inference-port.ts";
import { AppProbe } from "./probe.ts";

const choices: ModelChoice[] = [
  {
    reference: "ollama/qwen3",
    provider: "ollama",
    model: "qwen3",
    available: true,
    facts: ["chat-completions"],
  },
  {
    reference: "openai/gpt-5-mini",
    provider: "openai",
    model: "gpt-5-mini",
    available: true,
    facts: ["chat-completions"],
  },
];

function inference(): InferencePort {
  return {
    choices: () => choices,
    describe: (reference) =>
      choices.some((choice) => choice.reference === reference)
        ? { ok: true, message: `${reference} · chat-completions` }
        : {
            ok: false,
            code: "unknown-model",
            message: `nobody knows ${reference}`,
            nextAction: "pick one with /model",
          },
  };
}

const openai: ConnectionTarget = {
  id: "openai",
  label: "OpenAI",
  kind: "built-in",
  name: "openai",
  endpoint: "https://api.openai.com/v1",
  protocol: "chat-completions",
  credential: "api-key",
  endpointEditable: false,
  nameEditable: false,
};

function connections(): ConnectionsPort {
  return {
    targets: () => [openai],
    saved: () => [],
    draftFor: (pick) => ({
      name: pick.name,
      endpoint: pick.endpoint,
      protocol: "chat-completions",
      credential: "kind" in pick ? pick.credential : "none",
      apiKey: "",
      insecureTransport: false,
    }),
    verify: async () => ({ ok: false, at: "t", reason: "unused" }),
    save: async () => {},
    remove: async () => ({ removed: [], retained: [] }),
  };
}

function probeWithInference() {
  const switched: string[] = [];
  const probe = new AppProbe({
    inference: inference(),
    connections: connections(),
    currentModel: () => "openai/gpt-5-mini",
    switchModel: async (reference) => {
      switched.push(reference);
      return `model → ${reference}`;
    },
  });
  return { probe, switched };
}

describe("/model", () => {
  it("is registered with /connect and its aliases only when the ports exist", () => {
    const bare = new AppProbe();
    expect(bare.core.registry.search("model").map((entry) => entry.name)).not.toContain("model");
    const { probe } = probeWithInference();
    const names = probe.core.registry.all().map((command) => command.name);
    expect(names).toEqual(expect.arrayContaining(["model", "connect"]));
    expect(probe.core.registry.run("setup")).toBe(true);
    expect(probe.snapshot().overlay).toBe("connect");
  });

  it("opens a neutral picker on the current model, filters as you type, and switches on enter", async () => {
    const { probe, switched } = probeWithInference();
    expect(probe.command("model")).toBe(true);
    expect(probe.snapshot().overlay).toBe("model");
    expect(probe.core.modelPicker()?.selected()?.reference).toBe("openai/gpt-5-mini");
    probe.type("qwen");
    expect(
      probe.core
        .modelPicker()
        ?.visible()
        .map((choice) => choice.reference),
    ).toEqual(["ollama/qwen3"]);
    probe.keys("return");
    await probe.settled();
    expect(switched).toEqual(["ollama/qwen3"]);
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(probe.snapshot().notice).toBe("model → ollama/qwen3");
  });

  it("takes a reference argument straight to the switch and reports typed failures without switching", async () => {
    const { probe, switched } = probeWithInference();
    probe.core.registry.run("model ollama/qwen3");
    await probe.settled();
    expect(switched).toEqual(["ollama/qwen3"]);
    probe.core.registry.run("model nope/x");
    await probe.settled();
    expect(switched).toEqual(["ollama/qwen3"]);
    expect(probe.snapshot().notice).toBe("nobody knows nope/x · pick one with /model");
  });

  it("closes the picker on escape without switching", async () => {
    const { probe, switched } = probeWithInference();
    probe.command("model");
    probe.keys("escape");
    await probe.settled();
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(switched).toEqual([]);
  });

  it("selects the model under a click and closes on a click outside", async () => {
    const { probe, switched } = probeWithInference();
    probe.command("model");
    const frame = paletteFrame(probe.screen, choices.length);
    probe.hover(frame.x + 2, frame.firstRowY);
    expect(probe.core.modelPicker()?.selected()?.reference).toBe("ollama/qwen3");
    probe.click(frame.x + 2, frame.firstRowY);
    await probe.settled();
    expect(switched).toEqual(["ollama/qwen3"]);
    expect(probe.snapshot().overlay).toBeUndefined();

    probe.command("model");
    probe.click(0, 0);
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(switched).toEqual(["ollama/qwen3"]);
  });

  it("pastes into the picker's query", () => {
    const { probe } = probeWithInference();
    probe.command("model");
    probe.paste("qwen\n");
    expect(probe.core.modelPicker()?.query).toBe("qwen");
    expect(probe.core.modelPicker()?.selected()?.reference).toBe("ollama/qwen3");
  });
});

describe("/connect", () => {
  function connectEditor() {
    const { probe } = probeWithInference();
    probe.core.registry.run("connect openai");
    const model = probe.core.connectModel();
    if (model === undefined) throw new Error("expected the connect editor to be open");
    return { probe, model };
  }

  it("pastes an API key into the secret field", () => {
    const { probe, model } = connectEditor();
    const keyField = model.fields().findIndex((field) => field.id === "apiKey");
    for (let step = 0; step < keyField; step += 1) probe.keys("down");
    probe.paste("sk-live-123\n");
    expect(model.stage.kind === "editor" && model.stage.draft.apiKey).toBe("sk-live-123");
    expect(probe.snapshot().overlay).toBe("connect");
  });

  it("keeps the draft on a click inside the editor and focuses the clicked field", () => {
    const { probe, model } = connectEditor();
    probe.keys("down", "down").type("x");
    const frame = helpFrame(probe.screen, model.rowCount());
    probe.click(frame.x + 2, frame.firstRowY);
    expect(probe.snapshot().overlay).toBe("connect");
    expect(model.stage.kind === "editor" && model.stage.field).toBe(0);
    expect(model.stage.kind === "editor" && model.stage.draft.apiKey).toBe("x");
  });

  it("discards the editor on a click outside, like escape", () => {
    const { probe } = connectEditor();
    probe.click(0, 0);
    expect(probe.snapshot().overlay).toBeUndefined();
  });

  it("opens the clicked target from the target list", () => {
    const { probe } = probeWithInference();
    probe.command("connect");
    const model = probe.core.connectModel();
    const frame = helpFrame(probe.screen, model?.rowCount() ?? 0);
    probe.click(frame.x + 2, frame.firstRowY);
    expect(model?.stage.kind).toBe("editor");
    expect(probe.snapshot().overlay).toBe("connect");
  });
});
