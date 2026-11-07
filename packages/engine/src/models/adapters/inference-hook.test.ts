import { afterEach, describe, expect, it } from "vitest";
import { resolveModel } from "../../inference/resolution.ts";
import type { InferenceBinding } from "../../inference/types.ts";
import { promptMessage } from "../../messages.ts";
import type { TurnDelta } from "../../provider.ts";
import { CapabilityCache } from "../capabilities/cache.ts";
import { probeServer } from "../capabilities/probe.ts";
import { probeHttp } from "./http.ts";
import { isTailnetEndpoint, localServerProvider, registrationFor } from "./inference-hook.ts";
import { culpritsOf, withoutFields } from "./staged-retry.ts";
import { FixtureServer, loadFixture } from "./testing/fixture-server.ts";
import type { TurnUsageReport } from "./types.ts";

const now = () => new Date("2026-11-05T12:00:00.000Z");
let server: FixtureServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function probedLlamaServer() {
  server = new FixtureServer(loadFixture("llama-server-b12122"));
  const root = await server.listen();
  const cache = new CapabilityCache(now);
  const result = await probeServer(root, { http: probeHttp(), cache, now, behaviour: true });
  if (result.status !== "recognized" || result.inventory === null) throw new Error("not probed");
  return { root, cache, result, inventory: result.inventory, fixture: server };
}

describe("registrationFor", () => {
  it("registers a probed server as a chat-completions provider with probed capabilities", async () => {
    const { root, inventory, result } = await probedLlamaServer();
    const registration = registrationFor("spark-llama", root, inventory, result.records);
    expect(registration).toMatchObject({
      name: "spark-llama",
      protocol: "chat-completions",
      endpoint: `${root}/v1`,
      credential: { kind: "none" },
      openCatalog: false,
      insecureTransport: false,
    });
    expect(registration.models).toEqual([
      {
        id: "qwen3.8-27b",
        origin: "reported",
        capabilities: { input: ["text", "image"], toolCalls: true, contextWindow: 131072 },
      },
      {
        id: "nimble-9b",
        origin: "reported",
        capabilities: { input: ["text"], toolCalls: false },
      },
    ]);
    const refused = resolveModel([registration], { selection: "spark-llama/nimble-9b" });
    expect(refused.ok === false && refused.failure.code).toBe("missing-capability");
  });

  it("trusts plain http only on loopback or the tailnet", () => {
    expect(isTailnetEndpoint("http://100.101.102.103:11434")).toBe(true);
    expect(isTailnetEndpoint("http://[fd7a:115c:a1e0::7]:9931")).toBe(true);
    expect(isTailnetEndpoint("http://spark-ad4d.tail1234.ts.net:9931")).toBe(true);
    expect(isTailnetEndpoint("http://192.168.1.20:11434")).toBe(false);
    expect(isTailnetEndpoint("not a url")).toBe(false);
  });
});

describe("localServerProvider", () => {
  it("serves a binding to a known local server through its adapter, with replay and ledger", async () => {
    const { root, cache, inventory, result, fixture } = await probedLlamaServer();
    const registration = registrationFor("spark-llama", root, inventory, result.records);
    const resolution = resolveModel([registration], { selection: "spark-llama/qwen3.8-27b" });
    if (!resolution.ok) throw new Error(resolution.failure.message);
    const reports: Array<[string, TurnUsageReport]> = [];
    const provider = localServerProvider(resolution.binding, {
      directory: cache,
      onUsage: (binding, report) => reports.push([binding.reference.model, report]),
    });
    if (provider === undefined) throw new Error("expected a local provider");
    const deltas: TurnDelta[] = [];
    for await (const delta of provider.stream({
      systemPrompt: "",
      messages: [
        promptMessage("Gate?"),
        { role: "assistant", parts: [{ type: "visible-thinking", text: "Look." }] },
        promptMessage("Now?"),
      ],
      tools: [],
    })) {
      deltas.push(delta);
    }
    expect(deltas.map((delta) => delta.type)).toEqual(["visible-thinking", "text", "done"]);
    expect(reports[0]?.[0]).toBe("qwen3.8-27b");
    const sent = fixture.requestsTo("POST /v1/chat/completions").at(-1)?.body as {
      messages: Array<Record<string, unknown>>;
    };
    expect(sent.messages[1]).toMatchObject({ role: "assistant", reasoning_content: "Look." });
  });

  it("leaves unknown servers and other protocols to the existing transport", () => {
    const cache = new CapabilityCache(now);
    const binding = {
      protocol: "chat-completions",
      reference: { provider: "p", model: "m" },
      registration: { name: "p", endpoint: "http://127.0.0.1:1/v1" },
    } as unknown as InferenceBinding;
    expect(localServerProvider(binding, { directory: cache })).toBeUndefined();
    const anthropic = { ...binding, protocol: "anthropic-messages" } as InferenceBinding;
    expect(localServerProvider(anthropic, { directory: cache })).toBeUndefined();
  });
});

describe("the staged retry", () => {
  it("blames the optional fields the refusal names, else all that were sent", () => {
    expect(culpritsOf("unknown field `reasoning_effort`", ["reasoning_effort", "top_k"])).toEqual([
      "reasoning_effort",
    ]);
    expect(culpritsOf("bad request", ["reasoning_effort", "top_k"])).toEqual([
      "reasoning_effort",
      "top_k",
    ]);
    expect(withoutFields({ a: 1, b: 2, c: 3 }, ["b"])).toEqual({ a: 1, c: 3 });
  });
});
