import { describe, expect, it } from "vitest";
import type { ConnectionsPort, InferencePort, ModelChoice } from "./inference-port.ts";
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

function connections(): ConnectionsPort {
  return {
    targets: () => [],
    saved: () => [],
    draftFor: () => ({
      name: "",
      endpoint: "",
      protocol: "chat-completions",
      credential: "none",
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
});
