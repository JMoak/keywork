import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../../../messages.ts";
import type { ProviderRequest, TurnDelta } from "../../../provider.ts";
import { eligibleClasses, type ServerFingerprint } from "../../capabilities/index.ts";
import { probeToolCalls, withToolCallProbe } from "../behaviour.ts";
import { probeHttp } from "../http.ts";
import { inMemoryFieldMemory } from "../staged-retry.ts";
import { FixtureServer, loadFixture, type ServerFixture } from "../testing/fixture-server.ts";
import type { ServerProbe, TurnUsageReport } from "../types.ts";
import { llamaServerAdapter, llamaServerDeltas } from "./index.ts";

const fixture: ServerFixture = loadFixture("llama-server-b12122");
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

describe("the llama-server adapter contract, pinned to the fixture's build", () => {
  it("is tested against the build its delta table names, on port 9931", () => {
    expect(fixture.server).toEqual({
      kind: "llama-server",
      version: llamaServerDeltas.versionTested,
    });
    expect(llamaServerDeltas.defaultPort).toBe(9931);
  });

  it("fingerprints by /props build_info", async () => {
    expect(await llamaServerAdapter.fingerprint(probe)).toEqual({
      id: "llama-server@b12122",
      kind: "llama-server",
      version: "b12122",
      build: "b12122-4f1e2a7",
      routes: ["/props"],
    });
  });

  it("reads router-mode residency from /models status", async () => {
    const inventory = await llamaServerAdapter.inventory(probe);
    expect(inventory.installed.map((model) => model.id)).toEqual(["qwen3.8-27b", "nimble-9b"]);
    expect(inventory.loaded.map((model) => [model.id, model.state])).toEqual([
      ["qwen3.8-27b", "loaded"],
    ]);
  });

  it("falls back to the single-model listing with the slot context", async () => {
    server.route("GET /models", { status: 404, body: { error: "not found" } });
    const inventory = await llamaServerAdapter.inventory(probe);
    expect(inventory.loaded).toEqual([
      {
        id: "qwen3.8-27b",
        state: "loaded",
        contextAllocated: 131072,
        memoryBytes: null,
        expiresAt: null,
      },
    ]);
    expect(inventory.installed[0]?.parameterSize).toBe("27.8B");
  });

  it("describes a model from /props, /models and /v1/models", async () => {
    const record = await llamaServerAdapter.describe(probe, "qwen3.8-27b", await fingerprint());
    expect(record).toMatchObject({
      tools: { known: false },
      parallelTools: { known: true, value: true },
      responseFormat: { known: true, value: ["json_object", "json_schema"] },
      imageInput: { known: true, value: "base64", evidence: { route: "/models" } },
      reasoning: { known: true, value: "chat-template-kwargs" },
      reasoningReplay: { known: true, value: true },
      contextAllocated: { known: true, value: 131072, evidence: { route: "/props" } },
      contextTrained: { known: true, value: 262144 },
      decisionEndpoint: { known: true, value: null },
      license: { known: false },
    });
    expect(server.requestsTo("GET /props").map((seen) => seen.search)).toContain(
      "?model=qwen3.8-27b",
    );
  });

  it("detects a native decision model from output_modalities", async () => {
    const record = await llamaServerAdapter.describe(probe, "nimble-9b", await fingerprint());
    expect(record.decisionEndpoint).toMatchObject({ known: true, value: "/v1/systemone" });
    expect(eligibleClasses(record)).toContain("decide");
  });

  it("admits a model to tool classes only after tool calls arrive in tool_calls", async () => {
    const record = await llamaServerAdapter.describe(probe, "qwen3.8-27b", await fingerprint());
    expect(eligibleClasses(record)).toEqual(["decide", "vision"]);
    const outcome = await probeToolCalls(probe, "qwen3.8-27b");
    expect(outcome).toEqual({ kind: "tool_calls" });
    const probed = withToolCallProbe(record, outcome);
    expect(probed.tools).toEqual({
      known: true,
      value: true,
      evidence: { source: "behaviour-probe", probe: "tool_calls" },
    });
    expect(eligibleClasses(probed)).toEqual(["strong", "decide", "vision"]);
  });

  it("refuses tool classes when calls arrive as content", async () => {
    server.route("POST /v1/chat/completions", {
      once: true,
      body: {
        choices: [
          { message: { role: "assistant", content: '<tool_call>{"name":"keywork_probe_ping"}' } },
        ],
      },
    });
    const outcome = await probeToolCalls(probe, "qwen3.8-27b");
    expect(outcome.kind).toBe("content");
    const record = await llamaServerAdapter.describe(probe, "qwen3.8-27b", await fingerprint());
    expect(withToolCallProbe(record, outcome).tools).toMatchObject({ known: true, value: false });
  });

  it("classifies health from /health, /slots and router status", async () => {
    expect(await llamaServerAdapter.health(probe, "qwen3.8-27b")).toMatchObject({
      state: "up",
      resident: true,
    });
    server.route("GET /slots?fail_on_no_slot=1", { once: true, status: 503, body: {} });
    expect(await llamaServerAdapter.health(probe)).toMatchObject({ state: "saturated" });
    server.route("GET /health", {
      once: true,
      status: 503,
      body: { error: { code: 503, message: "Loading model", type: "unavailable_error" } },
    });
    expect(await llamaServerAdapter.health(probe)).toEqual({
      state: "loading",
      resident: false,
      detail: "Loading model",
      checkedAt: "2026-11-05T12:00:00.000Z",
    });
    server.route("GET /models", {
      once: true,
      body: { data: [{ id: "qwen3.8-27b", status: { value: "loading" } }] },
    });
    expect(await llamaServerAdapter.health(probe, "qwen3.8-27b")).toMatchObject({
      state: "loading",
    });
  });
});

describe("chat over llama-server", () => {
  it("parses reasoning_content and reads usage from timings", async () => {
    const reports: TurnUsageReport[] = [];
    const deltas = await collect(
      llamaServerAdapter
        .chat({
          name: "llama",
          root: probe.root,
          model: "qwen3.8-27b",
          onUsage: (report) => reports.push(report),
        })
        .stream(request([user("What time is it?")])),
    );
    expect(deltas).toEqual([
      { type: "visible-thinking", text: "Read the clock first." },
      { type: "text", text: "It is noon." },
      { type: "done", usage: { inputTokens: 100, outputTokens: 12, cacheReadInputTokens: 4000 } },
    ]);
    expect(reports[0]?.usage).toMatchObject({ tokS: 74.95, cacheRead: 4000 });
  });

  it("replays reasoning_content on earlier assistant turns when the template asks for it", async () => {
    const history: Message[] = [
      user("Is the gate open?"),
      {
        role: "assistant",
        parts: [
          { type: "visible-thinking", text: "Check the latch." },
          { type: "text", text: "It is latched." },
        ],
      },
      user("And now?"),
    ];
    await collect(
      llamaServerAdapter
        .chat({ name: "llama", root: probe.root, model: "qwen3.8-27b", replayReasoning: true })
        .stream(request(history)),
    );
    const wire = server.requestsTo("POST /v1/chat/completions")[0]?.body as {
      messages: Record<string, unknown>[];
    };
    expect(wire.messages[1]).toEqual({
      role: "assistant",
      content: "It is latched.",
      reasoning_content: "Check the latch.",
    });
  });

  it("retries once without a refused optional field and remembers the refusal", async () => {
    server.route("POST /v1/chat/completions", {
      once: true,
      status: 400,
      body: { error: { code: 400, message: "Unsupported param: reasoning_effort" } },
    });
    const memory = inMemoryFieldMemory();
    const provider = llamaServerAdapter.chat({
      name: "llama",
      root: probe.root,
      model: "qwen3.8-27b",
      optionalFields: {
        reasoning_effort: "low",
        chat_template_kwargs: { enable_thinking: false },
      },
      fieldMemory: memory,
    });
    const deltas = await collect(provider.stream(request([user("Hi")])));
    expect(deltas.at(-1)?.type).toBe("done");
    expect(memory.rejected()).toEqual(["reasoning_effort"]);
    const [refused, retried] = server
      .requestsTo("POST /v1/chat/completions")
      .map((seen) => seen.body as Record<string, unknown>);
    expect(refused).toHaveProperty("reasoning_effort", "low");
    expect(retried).not.toHaveProperty("reasoning_effort");
    expect(retried).toHaveProperty("chat_template_kwargs", { enable_thinking: false });

    await collect(provider.stream(request([user("Again")])));
    expect(server.requestsTo("POST /v1/chat/completions")[2]?.body).not.toHaveProperty(
      "reasoning_effort",
    );
  });

  it("does not retry a refusal when no optional field was sent", async () => {
    server.route("POST /v1/chat/completions", {
      once: true,
      status: 400,
      body: { error: { message: "context overflow" } },
    });
    await expect(
      collect(
        llamaServerAdapter
          .chat({ name: "llama", root: probe.root, model: "qwen3.8-27b" })
          .stream(request([user("Hi")])),
      ),
    ).rejects.toThrow(/400/);
    expect(server.requestsTo("POST /v1/chat/completions")).toHaveLength(1);
  });
});

async function fingerprint(): Promise<ServerFingerprint> {
  const found = await llamaServerAdapter.fingerprint(probe);
  if (found === undefined) throw new Error("fixture did not fingerprint");
  return found;
}

function user(text: string): Message {
  return { role: "user", parts: [{ type: "text", text }] };
}

function request(messages: Message[]): ProviderRequest {
  return { systemPrompt: "", messages, tools: [] };
}

async function collect(stream: AsyncIterable<TurnDelta>): Promise<TurnDelta[]> {
  const deltas: TurnDelta[] = [];
  for await (const delta of stream) deltas.push(delta);
  return deltas;
}
