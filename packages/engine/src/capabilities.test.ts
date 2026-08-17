import { describe, expect, it } from "vitest";
import {
  declaredCapabilitiesFor,
  UndeclaredCapabilityError,
  undeclaredCapabilities,
  withDeclaredCapabilities,
} from "./capabilities.ts";
import type { Message } from "./messages.ts";
import { MockProvider, textTurn } from "./mock-provider.ts";
import type { ProviderRequest, TurnDelta } from "./provider.ts";

const imageMessage: Message = {
  role: "user",
  parts: [{ type: "image", mediaType: "image/png", data: "aGk=" }],
};

const textRequest: ProviderRequest = {
  systemPrompt: "",
  messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
  tools: [],
};

const echoTool = { name: "echo", description: "echoes", parameters: {} };

describe("declaredCapabilitiesFor", () => {
  it("treats an undeclared model as text-only with tool support", () => {
    expect(declaredCapabilitiesFor(undefined, "mystery-model")).toEqual(undeclaredCapabilities);
    expect(declaredCapabilitiesFor({ "gpt-5*": { input: ["text", "image"] } }, "other")).toEqual(
      undeclaredCapabilities,
    );
  });

  it("merges a declaration over the text-only defaults", () => {
    expect(
      declaredCapabilitiesFor(
        { "gpt-5*": { input: ["text", "image"], contextWindow: 400_000 } },
        "gpt-5-mini",
      ),
    ).toEqual({ input: ["text", "image"], toolCalls: true, contextWindow: 400_000 });
  });

  it("picks the most specific matching pattern", () => {
    const declarations = {
      "gpt-5*": { toolCalls: false },
      "gpt-5-mini": { toolCalls: true, contextWindow: 128_000 },
    };
    expect(declaredCapabilitiesFor(declarations, "gpt-5-mini")).toEqual({
      input: ["text"],
      toolCalls: true,
      contextWindow: 128_000,
    });
  });
});

describe("withDeclaredCapabilities", () => {
  it("fails fast when an image reaches a text-declared model, naming the declaration", () => {
    const gated = withDeclaredCapabilities(new MockProvider([textTurn("ok")], "plain-model"));

    const attempt = () =>
      gated.stream({ ...textRequest, messages: [...textRequest.messages, imageMessage] });

    expect(attempt).toThrow(UndeclaredCapabilityError);
    expect(attempt).toThrow('add "image" to models["plain-model"].input in keywork.json');
    try {
      attempt();
    } catch (error) {
      expect((error as UndeclaredCapabilityError).declaration).toBe('models["plain-model"].input');
    }
  });

  it("streams untouched once image input is declared", async () => {
    const gated = withDeclaredCapabilities(new MockProvider([textTurn("saw it")], "vision-model"), {
      input: ["text", "image"],
      toolCalls: true,
    });

    const deltas: TurnDelta[] = [];
    for await (const delta of gated.stream({
      ...textRequest,
      messages: [...textRequest.messages, imageMessage],
    })) {
      deltas.push(delta);
    }

    expect(deltas[0]).toEqual({ type: "text", text: "saw it" });
  });

  it("fails fast when tools are mounted on a model declared without tool calls", () => {
    const gated = withDeclaredCapabilities(new MockProvider([textTurn("ok")], "no-tools-model"), {
      input: ["text"],
      toolCalls: false,
    });

    const attempt = () => gated.stream({ ...textRequest, tools: [echoTool] });

    expect(attempt).toThrow(UndeclaredCapabilityError);
    expect(attempt).toThrow('models["no-tools-model"].toolCalls');
  });

  it("keeps the wrapped provider's name and model id", () => {
    const gated = withDeclaredCapabilities(new MockProvider([], "gpt-5-mini"));

    expect(gated.name).toBe("mock");
    expect(gated.modelId).toBe("gpt-5-mini");
  });
});
