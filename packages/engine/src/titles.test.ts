import { describe, expect, it } from "vitest";
import { textMessage } from "./messages.ts";
import { MockProvider, textTurn } from "./mock-provider.ts";
import type { Provider, ProviderRequest, TurnDelta } from "./provider.ts";
import { fitTitle, kebabTitle, suggestTitle } from "./titles.ts";

describe("kebabTitle", () => {
  it("normalizes model replies into kebab-case", () => {
    expect(kebabTitle("Fix Auth Tests")).toBe("fix-auth-tests");
    expect(kebabTitle('"debug-flaky-ci"\n')).toBe("debug-flaky-ci");
    expect(kebabTitle("Refactor the session store layer now")).toBe("refactor-the-session-store");
  });

  it("rejects empty or too-short replies", () => {
    expect(kebabTitle("")).toBeUndefined();
    expect(kebabTitle("ok")).toBeUndefined();
  });

  it("accepts a single meaningful word", () => {
    expect(kebabTitle("fizzbuzz")).toBe("fizzbuzz");
  });
});

describe("suggestTitle", () => {
  it("asks the provider and sanitizes the reply", async () => {
    const provider = new MockProvider([textTurn("Build Tiny Todo App")]);
    const title = await suggestTitle(provider, [
      textMessage("user", "make me a todo app"),
      textMessage("assistant", "done"),
    ]);
    expect(title).toBe("build-tiny-todo-app");
  });

  it("returns undefined for an empty conversation", async () => {
    const provider = new MockProvider([textTurn("anything")]);
    expect(await suggestTitle(provider, [])).toBeUndefined();
  });

  it("swallows provider failures", async () => {
    const provider = new MockProvider([]);
    const title = await suggestTitle(provider, [textMessage("user", "hi")]);
    expect(title).toBeUndefined();
  });

  it("hands sibling titles and the arc to the prompt as distinctness constraints", async () => {
    const provider = new RecordingProvider("Sleep Wake Repair");
    await suggestTitle(provider, [textMessage("user", "the server drops after sleep")], {
      arc: "mcp-hardening",
      avoid: ["timeout-retry", "handshake-abort"],
    });
    const prompt = provider.request?.systemPrompt ?? "";
    expect(prompt).toContain('arc "mcp-hardening"');
    expect(prompt).toContain("timeout-retry, handshake-abort");
  });

  it("leaves the prompt bare without context", async () => {
    const provider = new RecordingProvider("Build Tiny Todo App");
    await suggestTitle(provider, [textMessage("user", "make me a todo app")]);
    const prompt = provider.request?.systemPrompt ?? "";
    expect(prompt).not.toContain("arc");
    expect(prompt).not.toContain("Sibling");
  });
});

class RecordingProvider implements Provider {
  readonly name = "recording";
  readonly modelId = undefined;
  request: ProviderRequest | undefined;

  constructor(private readonly reply: string) {}

  async *stream(request: ProviderRequest): AsyncIterable<TurnDelta> {
    this.request = request;
    yield { type: "text", text: this.reply };
    yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

describe("fitTitle", () => {
  it("returns a fitting slug untouched", () => {
    expect(fitTitle("fix-mcp-reconnect", 20)).toBe("fix-mcp-reconnect");
  });

  it("sheds the arc prefix first because the border hue already carries it", () => {
    expect(fitTitle("mcp-hardening:sleep-wake", 12)).toBe("sleep-wake");
  });

  it("drops the most common sibling words before rare ones", () => {
    const siblings = ["fix-timeout-retry", "fix-handshake-abort"];
    expect(fitTitle("fix-mcp-reconnect", 13, siblings)).toBe("mcp-reconnect");
  });

  it("drops front-loaded words first when no sibling makes a word generic", () => {
    expect(fitTitle("fix-mcp-reconnect", 13)).toBe("mcp-reconnect");
  });

  it("never drops below one word, ellipsizing the survivor instead", () => {
    expect(fitTitle("fix-mcp-reconnect", 8)).toBe("reconne…");
  });

  it("survives degenerate widths", () => {
    expect(fitTitle("fix-mcp-reconnect", 1)).toBe("…");
    expect(fitTitle("fix-mcp-reconnect", 0)).toBe("");
    expect(fitTitle("fix-mcp-reconnect", -3)).toBe("");
  });

  it("never renders wider than asked, at any width", () => {
    const slug = "mcp-hardening:fix-the-sleep-wake-reconnect";
    for (let width = 0; width <= slug.length + 2; width += 1) {
      expect(fitTitle(slug, width).length).toBeLessThanOrEqual(Math.max(0, width));
    }
  });

  it("narrower widths never surface words that wider widths dropped", () => {
    const slug = "fix-mcp-reconnect-loop";
    const siblings = ["fix-retry-gate"];
    let previous = new Set(fitTitle(slug, slug.length, siblings).split("-"));
    for (let width = slug.length - 1; width >= 4; width -= 1) {
      const words = fitTitle(slug, width, siblings)
        .split("-")
        .map((word) => word.replace("…", ""));
      for (const word of words) {
        expect([...previous].some((kept) => kept.startsWith(word))).toBe(true);
      }
      previous = new Set(fitTitle(slug, width, siblings).split("-"));
    }
  });
});
