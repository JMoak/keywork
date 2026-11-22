import { describe, expect, it } from "vitest";
import type {
  ConnectionsPort,
  ConnectionTarget,
  InferencePort,
  ModelChoice,
} from "./inference-port.ts";
import { paletteFrame, paletteRowRoom } from "./overlays/index.ts";
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
  it("opens a neutral picker on the current model, filters as you type, and switches on enter", async () => {
    const { probe, switched } = probeWithInference();
    expect(probe.command("model")).toBe(true);
    expect(probe.snapshot().overlay).toBe("model");
    expect(probe.core.modelPicker()?.selected()?.choice.reference).toBe("openai/gpt-5-mini");
    probe.type("qwen");
    expect(
      probe.core
        .modelPicker()
        ?.rows()
        .map((row) => row.choice.reference),
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

  it("selects the model under a click and closes on a click outside", async () => {
    const { probe, switched } = probeWithInference();
    probe.command("model");
    const frame = paletteFrame(probe.screen, choices.length);
    probe.hover(frame.x + 2, frame.firstRowY);
    expect(probe.core.modelPicker()?.selected()?.choice.reference).toBe("ollama/qwen3");
    probe.click(frame.x + 2, frame.firstRowY);
    await probe.settled();
    expect(switched).toEqual(["ollama/qwen3"]);
    expect(probe.snapshot().overlay).toBeUndefined();

    probe.command("model");
    probe.click(0, 0);
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(switched).toEqual(["ollama/qwen3"]);
  });

  it("routes the pointer through the visible page of a long catalogue", async () => {
    const catalogue: ModelChoice[] = Array.from({ length: 100 }, (_, at) => ({
      reference: `openrouter/model-${at}`,
      provider: "openrouter",
      model: `model-${at}`,
      available: true,
      facts: [],
    }));
    const switched: string[] = [];
    const probe = new AppProbe({
      inference: {
        choices: () => catalogue,
        describe: (reference) => ({ ok: true, message: reference }),
      },
      switchModel: async (reference) => {
        switched.push(reference);
        return `model → ${reference}`;
      },
    });
    probe.command("model");
    probe.keys("up");
    const frame = paletteFrame(probe.screen, catalogue.length);
    const shown = paletteRowRoom(frame) - 1;
    const firstShown = catalogue.length - shown;
    probe.hover(frame.x + 2, frame.firstRowY);
    expect(probe.core.modelPicker()?.selected()?.choice.reference).toBe(
      `openrouter/model-${firstShown}`,
    );
    probe.click(frame.x + 2, frame.firstRowY + shown);
    expect(probe.snapshot().overlay).toBe("model");
    probe.click(frame.x + 2, frame.firstRowY + 1);
    await probe.settled();
    expect(switched).toEqual([`openrouter/model-${firstShown + 1}`]);
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

  it("hands enter on the receipt to a model picker that stays open and takes keys", async () => {
    const probe = new AppProbe({
      inference: inference(),
      connections: {
        ...connections(),
        verify: async () => ({ ok: true, at: "t", models: ["gpt-5-mini"] }),
      },
      switchModel: async (reference) => `model → ${reference}`,
    });
    probe.core.registry.run("connect openai");
    const model = probe.core.connectModel();
    if (model === undefined) throw new Error("expected the connect editor to be open");
    const keyField = model.fields().findIndex((field) => field.id === "apiKey");
    for (let step = 0; step < keyField; step += 1) probe.keys("down");
    probe.paste("sk-live-123\n");
    probe.keys("return");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(model.stage.kind).toBe("receipt");

    probe.keys("return");
    expect(probe.snapshot().overlay).toBe("model");
    probe.type("qwen");
    expect(probe.core.modelPicker()?.query).toBe("qwen");
    expect(probe.core.modelPicker()?.selected()?.choice.reference).toBe("ollama/qwen3");
  });
});
