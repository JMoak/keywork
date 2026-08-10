import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./prompt.ts";

const base = "You are keywork";

describe("buildSystemPrompt", () => {
  it("returns only the base prompt with no inputs", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(base);
    expect(prompt).not.toContain("Project instructions:");
  });

  it("appends project instructions after the base prompt", () => {
    const prompt = buildSystemPrompt({ projectInstructions: "use tabs" });
    expect(prompt.indexOf(base)).toBeLessThan(prompt.indexOf("Project instructions:\nuse tabs"));
  });

  it("ignores blank project instructions", () => {
    expect(buildSystemPrompt({ projectInstructions: "  \n " })).toBe(buildSystemPrompt());
  });

  it("places the global user prompt after project instructions", () => {
    const prompt = buildSystemPrompt({
      projectInstructions: "use tabs",
      prompts: { system: "always answer tersely" },
    });
    expect(prompt.indexOf("use tabs")).toBeLessThan(prompt.indexOf("always answer tersely"));
  });

  it("applies the global prompt when no model id is known", () => {
    const prompt = buildSystemPrompt({
      prompts: { system: "be terse", models: { "gpt-5*": { prompt: "x", mode: "append" } } },
    });
    expect(prompt).toContain("be terse");
    expect(prompt).not.toContain("\n\nx");
  });

  it("appends a matching override after the global prompt", () => {
    const prompt = buildSystemPrompt({
      modelId: "gpt-5-mini",
      prompts: {
        system: "be terse",
        models: { "gpt-5*": { prompt: "think stepwise", mode: "append" } },
      },
    });
    expect(prompt.indexOf(base)).toBeLessThan(prompt.indexOf("be terse"));
    expect(prompt.indexOf("be terse")).toBeLessThan(prompt.indexOf("think stepwise"));
  });

  it("replace mode substitutes the global prompt but never the base or project sections", () => {
    const prompt = buildSystemPrompt({
      modelId: "gpt-5-mini",
      projectInstructions: "use tabs",
      prompts: {
        system: "be terse",
        models: { "gpt-5*": { prompt: "verbose reasoning welcome", mode: "replace" } },
      },
    });
    expect(prompt).toContain(base);
    expect(prompt).toContain("use tabs");
    expect(prompt).toContain("verbose reasoning welcome");
    expect(prompt).not.toContain("be terse");
  });

  it("skips overrides whose pattern does not match", () => {
    const prompt = buildSystemPrompt({
      modelId: "claude-x",
      prompts: { system: "be terse", models: { "gpt-5*": { prompt: "x", mode: "replace" } } },
    });
    expect(prompt).toContain("be terse");
    expect(prompt).not.toContain("\n\nx");
  });

  it("picks the most specific matching pattern by literal character count", () => {
    const prompt = buildSystemPrompt({
      modelId: "gpt-5-mini",
      prompts: {
        models: {
          "*": { prompt: "generic", mode: "append" },
          "gpt-5-mini": { prompt: "exact", mode: "append" },
          "gpt-5*": { prompt: "family", mode: "append" },
        },
      },
    });
    expect(prompt).toContain("exact");
    expect(prompt).not.toContain("generic");
    expect(prompt).not.toContain("family");
  });

  it("breaks specificity ties in favor of the first declared pattern", () => {
    const prompt = buildSystemPrompt({
      modelId: "abc",
      prompts: {
        models: {
          "a*c": { prompt: "first", mode: "append" },
          "ab*": { prompt: "second", mode: "append" },
        },
      },
    });
    expect(prompt).toContain("first");
    expect(prompt).not.toContain("second");
  });

  it("treats regex metacharacters in patterns as literals", () => {
    const prompt = buildSystemPrompt({
      modelId: "gpt-5x1",
      prompts: { models: { "gpt-5.1": { prompt: "dot is literal", mode: "append" } } },
    });
    expect(prompt).not.toContain("dot is literal");
  });
});
