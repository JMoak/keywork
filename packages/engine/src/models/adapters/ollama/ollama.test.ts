import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptMessage } from "../../../messages.ts";
import type { ProviderRequest, TurnDelta } from "../../../provider.ts";
import { eligibleClasses, missingFor, type ServerFingerprint } from "../../capabilities/index.ts";
import { probeHttp } from "../http.ts";
import { ToolChoiceUnmetError } from "../local-chat.ts";
import { FixtureServer, loadFixture, type ServerFixture } from "../testing/fixture-server.ts";
import type { ServerProbe, TurnUsageReport } from "../types.ts";
import { versionAtLeast } from "../version.ts";
import {
  contextVariant,
  createContextVariant,
  ollamaAdapter,
  ollamaDeltas,
  pinResident,
  verifyContext,
} from "./index.ts";

const fixture: ServerFixture = loadFixture("ollama-0.40.14");
const now = () => new Date("2026-11-05T12:00:00.000Z");

let server: FixtureServer;
let probe: ServerProbe;

beforeEach(async () => {
  server = new FixtureServer(fixture);
  probe = { http: probeHttp(), root: await server.listen(), now };
});

afterEach(async () => {
  await server.close();
});

describe("the Ollama adapter contract, pinned to the fixture's server version", () => {
  it("is tested against the version its delta table names", () => {
    expect(fixture.server).toEqual({ kind: "ollama", version: ollamaDeltas.versionTested });
    expect(ollamaDeltas.defaultPort).toBe(11434);
  });

  it("fingerprints by /api/version", async () => {
    expect(await ollamaAdapter.fingerprint(probe)).toEqual({
      id: "ollama@0.40.14",
      kind: "ollama",
      version: "0.40.14",
      build: null,
      routes: ["/api/version"],
    });
  });

  it("gates /v1/messages and /v1/responses on the version that added them", async () => {
    server.route("GET /api/version", { body: { version: "0.13.5" } });
    const old = await fingerprint();
    const record = await ollamaAdapter.describe(probe, "qwen3.8:27b", old);
    expect(record.protocols).toMatchObject({ known: true, value: ["chat-completions"] });
    expect(versionAtLeast("v0.40.14-rc1", "0.40.14")).toBe(true);
    expect(versionAtLeast(null, "0.1")).toBe(false);
  });

  it("tells installed from loaded models", async () => {
    const inventory = await ollamaAdapter.inventory(probe);
    expect(inventory.installed.map((model) => model.id)).toEqual(["qwen3.8:27b", "nimble:latest"]);
    expect(inventory.loaded).toEqual([
      {
        id: "qwen3.8:27b",
        state: "loaded",
        contextAllocated: 32768,
        memoryBytes: 21474836480,
        expiresAt: "2026-11-05T12:05:00.000Z",
      },
    ]);
  });

  it("describes a model from /api/show and /api/ps, never from its name", async () => {
    const record = await ollamaAdapter.describe(probe, "qwen3.8:27b", await fingerprint());
    expect(record).toMatchObject({
      endpoint: probe.root,
      model: "qwen3.8:27b",
      probedAt: "2026-11-05T12:00:00.000Z",
      protocols: { known: true, value: ["chat-completions", "responses", "anthropic-messages"] },
      tools: { known: true, value: true, evidence: { source: "native-route", route: "/api/show" } },
      toolChoice: { known: true, value: ["auto"], evidence: { rule: "MODEL-002" } },
      imageInput: { known: true, value: "base64" },
      logprobs: { known: true, value: false },
      reasoning: { known: true, value: "reasoning-effort" },
      contextAllocated: { known: true, value: 32768, evidence: { route: "/api/ps" } },
      contextTrained: { known: true, value: 262144 },
      decisionEndpoint: { known: true, value: null },
      license: { known: true, value: "apache-2.0" },
      strictSchemas: { known: false },
      responseFormat: { known: false },
    });
  });

  it("finds the decision endpoint from the decision capability and leaves unloaded context unknown", async () => {
    const record = await ollamaAdapter.describe(probe, "nimble:latest", await fingerprint());
    expect(record.decisionEndpoint).toMatchObject({ known: true, value: "/v1/systemone" });
    expect(record.modalities).toMatchObject({ known: true, value: { output: ["decisions"] } });
    expect(record.contextAllocated).toMatchObject({ known: false });
    expect(eligibleClasses(record)).toEqual(["decide"]);
  });

  it("refuses the strong class at 32K allocated and names the missing capability", async () => {
    const record = await ollamaAdapter.describe(probe, "qwen3.8:27b", await fingerprint());
    expect(missingFor(record, "strong")).toEqual([
      { capability: "contextAllocated", needs: "at least 131072 tokens of context allocated" },
    ]);
    expect(eligibleClasses(record)).toEqual(["vision"]);
  });

  it("verifies num_ctx against the agent floor and proposes a Modelfile variant", async () => {
    expect(await verifyContext(probe, "qwen3.8:27b", 65_536)).toEqual({
      kind: "short",
      allocated: 32768,
      floor: 65_536,
      remedy: contextVariant("qwen3.8:27b", 65_536),
    });
    expect(await verifyContext(probe, "qwen3.8:27b", 32_768)).toEqual({
      kind: "ok",
      allocated: 32768,
    });
    expect((await verifyContext(probe, "nimble", 65_536)).kind).toBe("not-loaded");
  });

  it("creates the variant through /api/create with num_ctx", async () => {
    const variant = contextVariant("qwen3.8:27b", 65_536);
    expect(variant.name).toBe("qwen3.8:27b-ctx64k");
    await createContextVariant(probe, variant);
    expect(server.requestsTo("POST /api/create")[0]?.body).toEqual({
      model: "qwen3.8:27b-ctx64k",
      from: "qwen3.8:27b",
      parameters: { num_ctx: 65_536 },
      stream: false,
    });
    expect(contextVariant("nimble", 131_072).name).toBe("nimble:latest-ctx128k");
  });

  it("pins a gate model resident with keep_alive -1", async () => {
    await pinResident(probe, "nimble:latest");
    expect(server.requestsTo("POST /api/generate")[0]?.body).toEqual({
      model: "nimble:latest",
      keep_alive: -1,
    });
  });

  it("reports residency in health and down when unreachable", async () => {
    expect(await ollamaAdapter.health(probe, "qwen3.8:27b")).toMatchObject({
      state: "up",
      resident: true,
    });
    expect(await ollamaAdapter.health(probe, "nimble")).toMatchObject({
      state: "up",
      resident: false,
    });
    await server.close();
    expect(await ollamaAdapter.health(probe)).toMatchObject({ state: "down" });
    server = new FixtureServer(fixture);
  });
});

describe("chat over Ollama /v1", () => {
  it("parses reasoning, tool calls and usage, reporting usage to the ledger", async () => {
    const reports: TurnUsageReport[] = [];
    const deltas = await collect(
      ollamaAdapter
        .chat({
          name: "ollama",
          root: probe.root,
          model: "qwen3.8:27b",
          onUsage: (report) => reports.push(report),
        })
        .stream(request()),
    );
    expect(deltas).toEqual([
      { type: "visible-thinking", text: "The keeper wants the time." },
      {
        type: "tool-call",
        call: { type: "tool-call", callId: "call_k1", name: "clock", arguments: { zone: "UTC" } },
      },
      { type: "done", usage: { inputTokens: 412, outputTokens: 31 } },
    ]);
    expect(reports[0]?.servedModel).toBe("qwen3.8:27b");
    expect(reports[0]?.usage).toMatchObject({
      inputUncached: 412,
      output: 31,
      costSource: "local_estimate",
    });
  });

  it("never sends tool_choice, sends images as base64, and enforces required client-side", async () => {
    server.route("POST /v1/chat/completions", {
      once: true,
      sse: [textChunk("It is noon."), usageChunk(), "[DONE]"],
    });
    const provider = ollamaAdapter.chat({
      name: "ollama",
      root: probe.root,
      model: "qwen3.8:27b",
      toolChoice: { mode: "required" },
      optionalFields: { n: 2, temperature: 0.2 },
    });
    await expect(collect(provider.stream(request({ withImage: true })))).rejects.toThrow(
      ToolChoiceUnmetError,
    );
    const wire = server.requestsTo("POST /v1/chat/completions")[0]?.body as Record<string, unknown>;
    expect(wire).not.toHaveProperty("tool_choice");
    expect(wire).not.toHaveProperty("n");
    expect(wire.temperature).toBe(0.2);
    expect(JSON.stringify(wire.messages)).toContain('"url":"data:image/png;base64,iVBORw0KGgo="');
  });

  it("drops the tool list when the caller forbids tools", async () => {
    await collect(
      ollamaAdapter
        .chat({
          name: "ollama",
          root: probe.root,
          model: "qwen3.8:27b",
          toolChoice: { mode: "none" },
        })
        .stream(request()),
    );
    expect(server.requestsTo("POST /v1/chat/completions")[0]?.body).not.toHaveProperty("tools");
  });
});

async function fingerprint(): Promise<ServerFingerprint> {
  const found = await ollamaAdapter.fingerprint(probe);
  if (found === undefined) throw new Error("fixture did not fingerprint");
  return found;
}

function request(options: { withImage?: boolean } = {}): ProviderRequest {
  const images = options.withImage
    ? [{ type: "image" as const, mediaType: "image/png", data: "iVBORw0KGgo=" }]
    : [];
  return {
    systemPrompt: "You are a ranch hand.",
    messages: [promptMessage("What time is it?", images)],
    tools: [{ name: "clock", description: "Reads the clock.", parameters: { type: "object" } }],
  };
}

async function collect(stream: AsyncIterable<TurnDelta>): Promise<TurnDelta[]> {
  const deltas: TurnDelta[] = [];
  for await (const delta of stream) deltas.push(delta);
  return deltas;
}

function textChunk(content: string): object {
  return { model: "qwen3.8:27b", choices: [{ index: 0, delta: { content } }] };
}

function usageChunk(): object {
  return { model: "qwen3.8:27b", choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } };
}
