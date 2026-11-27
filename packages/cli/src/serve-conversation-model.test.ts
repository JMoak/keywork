import {
  blankRecord,
  type CapabilityRecord,
  known,
  memoryLicenseBook,
  type PolicyEnvironment,
  type Provider,
  type ProviderRegistration,
  type ProviderRequest,
  type TurnDelta,
  toolGuidance,
  unacknowledgedLicense,
  unknownCapability,
  workingManner,
} from "@keywork/engine";
import { describe, expect, it, vi } from "vitest";
import {
  conversationModel,
  conversationProvider,
  requireProjectModel,
} from "./serve-conversation-model.ts";

describe("conversation model suitability", () => {
  it("keeps a local model that cannot call tools in the conversation-only lane, whatever its context", () => {
    expect(conversationModel(choice, environment(silent))).toEqual({
      ...choice,
      mode: "chat",
      detail:
        "local/small answered without calling a tool when it was asked to, so it can talk but cannot use tools.",
    });
    expect(conversationModel(choice, environment())).toEqual({ ...choice, mode: "tools" });
    expect(
      conversationModel(choice, environment({ contextAllocated: known(131_072, evidence) })),
    ).toEqual({ ...choice, mode: "tools" });
    expect(conversationModel({ provider: "missing", model: "small" }, environment())).toMatchObject(
      { refused: "unknown-provider" },
    );
  });

  it("enforces licenses before allowing the weaker conversation requirements", () => {
    const policy = environment({ license: known("qwen-community-1.0", evidence) });
    policy.refusalOf = unacknowledgedLicense(memoryLicenseBook());
    expect(conversationModel(choice, policy)).toMatchObject({
      refused: "missing-capability",
      detail: expect.stringContaining("acknowledgement"),
    });
  });

  it("offers an explicit tool check only for the selected local model with sufficient measured context", () => {
    const policy = environment({
      tools: unknownCapability("not tested"),
      contextAllocated: known(131_072, evidence),
    });
    expect(conversationModel(choice, policy)).toEqual({
      ...choice,
      mode: "chat",
      detail:
        "local/small could not be asked whether it calls tools, so it can talk but cannot use tools.",
      projectCheck: { endpoint: "http://localhost:1234/v1", model: "small" },
    });
    expect(
      conversationModel(choice, environment({ tools: unknownCapability("not tested") })),
    ).not.toHaveProperty("projectCheck");
    expect(
      conversationModel(
        choice,
        environment({ tools: known(false, evidence), contextAllocated: known(131_072, evidence) }),
      ),
    ).not.toHaveProperty("projectCheck");
  });

  it("does not offer a known embedding-only model for conversation", () => {
    expect(
      conversationModel(
        choice,
        environment({
          modalities: known({ input: ["text"], output: ["embedding"] }, evidence),
        }),
      ),
    ).toMatchObject({
      refused: "missing-capability",
      detail: expect.stringContaining("text output"),
    });
  });

  it("removes tool inputs and every paragraph naming a tool, preserving all other request controls", async () => {
    let received: ProviderRequest | undefined;
    const underlying: Provider = {
      name: "local",
      modelId: "small",
      requestSupport: { maxOutputTokens: true, singleAttempt: true },
      async *stream(request) {
        received = request;
        yield { type: "text", text: "hello" };
      },
    };
    const provider = conversationProvider(choice, environment(silent), () => underlying);
    const request: ProviderRequest = {
      systemPrompt: `You are Pip.\n\n${toolGuidance}\n\n${workingManner}\n\nBe concise`,
      messages: [],
      tools: [tool],
      toolAdditions: [{ before: 0, tools: [tool] }],
      maxOutputTokens: 32,
      retry: "never",
      thinking: false,
    };
    expect(await collect(provider.stream(request))).toEqual([{ type: "text", text: "hello" }]);
    expect(received).toEqual({
      ...request,
      tools: [],
      toolAdditions: [],
      systemPrompt: expect.stringMatching(
        /^You are Pip\.\n\nBe concise\n\nlocal\/small answered without calling a tool[^\n]*You have no tools in this conversation/,
      ),
    });
    expect(provider.requestSupport).toEqual(underlying.requestSupport);
    await expect(requireProjectModel(provider)).rejects.toThrow(/before assigning project work/);
  });

  it("rejects an unsolicited tool call before the agent can receive it", async () => {
    const execute = vi.fn();
    const provider = conversationProvider(choice, environment(silent), () => ({
      name: "local",
      modelId: "small",
      async *stream() {
        yield {
          type: "tool-call",
          call: { type: "tool-call", callId: "bad", name: "write", arguments: { path: "oops" } },
        };
      },
    }));
    const run = async () => {
      for await (const delta of provider.stream({
        systemPrompt: "",
        messages: [],
        tools: [tool],
      })) {
        if (delta.type === "tool-call") execute(delta.call);
      }
    };
    await expect(run()).rejects.toThrow(/tool calls are disabled/);
    expect(execute).not.toHaveBeenCalled();
  });
});

const choice = { provider: "local", model: "small" };
const evidence = { source: "native-route", route: "/api/v1/models" } as const;
const silent = { tools: known(false, { source: "behaviour-probe", probe: "tool_calls" } as const) };
const tool = { name: "write", description: "write a file", parameters: {} };

function environment(overrides: Partial<CapabilityRecord> = {}): PolicyEnvironment {
  const registration: ProviderRegistration = {
    name: "local",
    endpoint: "http://localhost:1234/v1",
    protocol: "chat-completions",
    enabled: true,
    openCatalog: false,
    credential: { kind: "none" },
    models: [{ id: "small", origin: "reported" }],
  };
  return {
    registrations: [registration],
    capabilityOf: () => ({
      ...blankRecord(
        "http://localhost:1234",
        "small",
        {
          id: "local",
          kind: "lm-studio",
          version: null,
          build: null,
          routes: ["/api/v1/models"],
        },
        "2026-11-10",
      ),
      tools: known(true, evidence),
      contextAllocated: known(4096, evidence),
      ...overrides,
    }),
  };
}

async function collect(stream: AsyncIterable<TurnDelta>): Promise<TurnDelta[]> {
  const deltas: TurnDelta[] = [];
  for await (const delta of stream) deltas.push(delta);
  return deltas;
}
