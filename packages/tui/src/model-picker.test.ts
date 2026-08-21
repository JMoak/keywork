import { describe, expect, it } from "vitest";
import type { ModelChoice } from "./inference-port.ts";
import type { Chord } from "./keys.ts";
import { describeChoice, ModelPicker } from "./model-picker.ts";

const choices: ModelChoice[] = [
  {
    reference: "ollama/qwen3",
    provider: "ollama",
    model: "qwen3",
    available: true,
    facts: ["chat-completions", "no credential"],
  },
  {
    reference: "openai/gpt-5-mini",
    provider: "openai",
    model: "gpt-5-mini",
    available: true,
    facts: ["chat-completions", "saved key"],
  },
  {
    reference: "openrouter/openai/gpt-5-mini",
    provider: "openrouter",
    model: "openai/gpt-5-mini",
    available: false,
    facts: ["needs a key"],
  },
];

function key(name: string, sequence?: string): [Chord, string | undefined] {
  return [{ name, ctrl: false, shift: false, meta: false }, sequence];
}

describe("ModelPicker", () => {
  it("starts on the current model and marks it", () => {
    const picker = new ModelPicker(choices, "openai/gpt-5-mini");
    expect(picker.rows().map((row) => [row.choice.reference, row.selected, row.current])).toEqual([
      ["ollama/qwen3", false, false],
      ["openai/gpt-5-mini", true, true],
      ["openrouter/openai/gpt-5-mini", false, false],
    ]);
  });

  it("wraps with the arrows and chooses on enter", () => {
    const picker = new ModelPicker(choices, undefined);
    expect(picker.handleKey(...key("up"))).toBe("stay");
    expect(picker.selected()?.reference).toBe("openrouter/openai/gpt-5-mini");
    expect(picker.handleKey(...key("down"))).toBe("stay");
    expect(picker.handleKey(...key("return"))).toBe("choose");
    expect(picker.selected()?.reference).toBe("ollama/qwen3");
    expect(picker.handleKey(...key("escape"))).toBe("close");
  });

  it("filters by typed text, keeps order deterministic, and resets the cursor", () => {
    const picker = new ModelPicker(choices, "openrouter/openai/gpt-5-mini");
    for (const char of "gpt") picker.handleKey(...key(char, char));
    expect(picker.query).toBe("gpt");
    expect(picker.visible().map((choice) => choice.reference)).toEqual([
      "openai/gpt-5-mini",
      "openrouter/openai/gpt-5-mini",
    ]);
    expect(picker.selected()?.reference).toBe("openai/gpt-5-mini");
    picker.handleKey(...key("backspace"));
    expect(picker.query).toBe("gp");
  });

  it("describes a choice as reference plus its facts", () => {
    expect(describeChoice(choices[0] as ModelChoice)).toBe(
      "ollama/qwen3 · chat-completions · no credential",
    );
  });
});
