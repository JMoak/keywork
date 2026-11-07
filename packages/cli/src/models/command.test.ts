import {
  InferenceRegistry,
  type Provider,
  type ProviderRegistration,
  type TurnDelta,
} from "@keywork/engine";
import { describe, expect, it } from "vitest";
import type { ServerFingerprint } from "../../../engine/src/models/capabilities/index.ts";
import type { Decider } from "../../../engine/src/models/decide/index.ts";
import { exitCodes } from "../dispatch.ts";
import {
  type ModelsCommandDeps,
  type ModelsCommandFlags,
  modelsCommand,
  modelsUsage,
} from "./command.ts";
import { benchDepsFrom } from "./deps.ts";

const fingerprint: ServerFingerprint = {
  id: "llama-server@spark-ad4d:9931",
  kind: "llama-server",
  version: "v0.9.0",
  build: "b12122",
  routes: ["/props", "/models"],
};

function politeProvider(): Provider {
  return {
    name: "spark",
    modelId: "gpt-oss-120b",
    stream: (): AsyncIterable<TurnDelta> =>
      (async function* () {
        yield { type: "text", text: "Nothing to call." };
        yield { type: "done", usage: { inputTokens: 1000, outputTokens: 50 } };
      })(),
  };
}

function steadyDecider(): Decider {
  return {
    reference: { provider: "spark", model: "nimble" },
    decide: async (request) => {
      const [id] = Object.keys(request.questions);
      return {
        ok: true,
        model: "nimble",
        answers: { [id ?? ""]: { type: "noul", pYes: 0.5, confidence: 0.5 } },
        usage: { inputTokens: null, questions: 1, cost: null },
        latencyMs: 1,
      };
    },
  };
}

function steppingClock(stepMs: number): () => number {
  let now = 0;
  return () => {
    now += stepMs;
    return now;
  };
}

function fakeDeps(overrides: Partial<ModelsCommandDeps> = {}): ModelsCommandDeps {
  return {
    openChat: (reference) => ({ ok: true, reference, fingerprint, subject: politeProvider() }),
    openDecider: (reference) => ({ ok: true, reference, fingerprint, subject: steadyDecider() }),
    clock: steppingClock(250),
    ...overrides,
  };
}

async function run(
  args: readonly string[],
  flags: ModelsCommandFlags = {},
  deps: ModelsCommandDeps = fakeDeps(),
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await modelsCommand(
    args,
    deps,
    { print: (line) => out.push(line), printError: (line) => err.push(line) },
    flags,
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("keywork models bench", () => {
  it("benches a chat model on the bundled trace and prints the report", async () => {
    const { code, out, err } = await run(["bench", "spark/gpt-oss-120b"]);
    expect(err).toBe("");
    expect(code).toBe(exitCodes.completed);
    expect(out.split("\n").slice(0, 3)).toEqual([
      "bench spark/gpt-oss-120b · trace keywork-core · 3 repeats of 4 turns",
      "server llama-server v0.9.0 b12122 · fingerprint llama-server@spark-ad4d:9931",
      "  valid@1                   1.00",
    ]);
    expect(out).toContain("  tool name                 0.25");
    expect(out).toContain("  decode tok/s              200.0");
  });

  it("prints the report as JSON with --json", async () => {
    const { code, out } = await run(["bench", "spark/gpt-oss-120b"], { json: true, repeats: "4" });
    expect(code).toBe(exitCodes.completed);
    expect(JSON.parse(out)).toMatchObject({ kind: "chat", repeats: 4, fingerprint });
  });

  it("benches a decision model on the labelled fixture with --decide", async () => {
    const { code, out } = await run(["bench", "spark/nimble"], { decide: true, json: true });
    expect(code).toBe(exitCodes.completed);
    expect(JSON.parse(out)).toMatchObject({
      kind: "decide",
      rows: 24,
      brier: { mean: 0.25 },
      inputTokensPerQuestion: null,
    });
  });

  it.each([
    [[], {}],
    [["bench"], {}],
    [["list"], {}],
    [["bench", "a/b", "c"], {}],
  ])("prints usage for %j", async (args, flags) => {
    const { code, err } = await run(args, flags);
    expect(code).toBe(exitCodes.usage);
    expect(err).toBe(modelsUsage);
  });

  it.each(["2", "three", "-4"])("refuses --repeats %s", async (repeats) => {
    const { code, err } = await run(["bench", "a/b"], { repeats });
    expect(code).toBe(exitCodes.usage);
    expect(err).toContain("at least 3");
  });

  it("reports a reference that does not resolve as unresolved", async () => {
    const deps = fakeDeps({ openChat: () => ({ ok: false, reason: 'no provider named "x"' }) });
    const { code, err } = await run(["bench", "x/y"], {}, deps);
    expect(code).toBe(exitCodes.unresolved);
    expect(err).toBe('keywork models bench: no provider named "x"');
  });
});

describe("benchDepsFrom an inference runtime", () => {
  const spark: ProviderRegistration = {
    name: "spark",
    protocol: "chat-completions",
    endpoint: "http://localhost:9931/v1",
    credential: { kind: "none" },
    models: [],
    openCatalog: true,
    enabled: true,
  };
  const registry = new InferenceRegistry();
  registry.register(spark);
  const opened: string[] = [];
  const deps = benchDepsFrom({
    registrations: () => registry.all(),
    resolve: (request) => registry.resolve(request),
    provider: (binding) => {
      opened.push(`provider ${binding.reference.model}`);
      return politeProvider();
    },
    decider: (binding) => {
      if (binding.reference.model.endsWith("-latest")) throw new Error("pin a version");
      opened.push(`decider ${binding.reference.model}`);
      return steadyDecider();
    },
  });

  it("opens a chat model through ordinary resolution with a declared fingerprint", () => {
    const opening = deps.openChat("spark/gpt-oss-120b");
    expect(opening).toMatchObject({
      ok: true,
      reference: "spark/gpt-oss-120b",
      fingerprint: { id: "declared:spark", kind: "openai-compatible", version: null },
    });
    expect(opened).toContain("provider gpt-oss-120b");
  });

  it("opens a decision model through the decide binding, never asking for tool calls", () => {
    expect(deps.openDecider("spark/nimble")).toMatchObject({ ok: true, reference: "spark/nimble" });
    expect(opened).toContain("decider nimble");
  });

  it("refuses a bare decision model name and an unknown provider", () => {
    expect(deps.openDecider("nimble")).toMatchObject({ ok: false });
    expect(deps.openDecider("lmstudio/nimble")).toEqual({
      ok: false,
      reason: 'no provider named "lmstudio"',
    });
  });

  it("turns a decider that refuses to open into a reason", () => {
    expect(deps.openDecider("spark/jev-latest")).toEqual({ ok: false, reason: "pin a version" });
  });
});
