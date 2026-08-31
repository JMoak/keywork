import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import { type CommandSuggestion, type EditorOutcome, PromptEditor } from "./prompt-editor.ts";

const builtIn: readonly CommandSuggestion[] = [
  { name: "cost", description: "cost" },
  { name: "context", description: "context" },
  { name: "compact", description: "compact" },
];

const commandNames = ["exit", "exit-all", "move-right"];

function editor(): PromptEditor {
  return new PromptEditor(() => {}, builtIn, {
    search: (query) =>
      commandNames
        .filter((name) => name.startsWith(query.toLowerCase()))
        .map((name) => ({ name, description: name })),
    run: () => true,
  });
}

function type(target: PromptEditor, text: string): void {
  for (const character of text) {
    target.handleKey(parseChord(character === " " ? "space" : character), character);
  }
}

function press(target: PromptEditor, key: string): EditorOutcome {
  return target.handleKey(parseChord(key), undefined);
}

describe("PromptEditor", () => {
  it("collects typed input, edits with backspace, and offers it on enter", () => {
    const prompt = editor();
    type(prompt, "hi there!");
    expect(press(prompt, "backspace")).toBe("handled");
    expect(prompt.value).toBe("hi there");
    expect(press(prompt, "return")).toEqual({ submit: "hi there", behavior: "queue" });
    expect(press(prompt, "alt+return")).toEqual({ submit: "hi there", behavior: "steer" });
    prompt.clear();
    expect(prompt.value).toBe("");
  });

  it("treats enter on an empty prompt as handled and leaves unknown keys to the caller", () => {
    const prompt = editor();
    expect(press(prompt, "return")).toBe("handled");
    expect(press(prompt, "pageup")).toBe("pass");
    expect(press(prompt, "escape")).toBe("pass");
    expect(prompt.handleKey(parseChord("ctrl+s"), "s")).toBe("pass");
  });

  it("keeps composing across shift+enter and moves the cursor between lines", () => {
    const prompt = editor();
    type(prompt, "abc");
    press(prompt, "shift+return");
    type(prompt, "z");
    expect(prompt.value).toBe("abc\nz");
    press(prompt, "up");
    type(prompt, "!");
    expect(prompt.value).toBe("a!bc\nz");
  });

  it("normalizes pasted line endings without submitting", () => {
    const prompt = editor();
    type(prompt, "err: ");
    prompt.paste("a\r\nb\rc");
    expect(prompt.value).toBe("err: a\nb\nc");
  });

  describe("history", () => {
    function conversed(...prompts: string[]): PromptEditor {
      const prompt = editor();
      for (const text of prompts) prompt.remember(text);
      return prompt;
    }

    it("recalls earlier prompts with up at an empty prompt", () => {
      const prompt = conversed("one", "two");
      press(prompt, "up");
      expect(prompt.value).toBe("two");
      press(prompt, "up");
      expect(prompt.value).toBe("one");
      press(prompt, "down");
      expect(prompt.value).toBe("two");
      press(prompt, "down");
      expect(prompt.value).toBe("");
    });

    it("stays put when the prompt has unsent text", () => {
      const prompt = conversed("one");
      type(prompt, "draft");
      expect(press(prompt, "up")).toBe("pass");
      expect(prompt.value).toBe("draft");
    });

    it("stops browsing as soon as the recalled text is edited", () => {
      const prompt = conversed("one", "two");
      press(prompt, "up");
      type(prompt, "!");
      expect(prompt.value).toBe("two!");
      press(prompt, "up");
      expect(prompt.value).toBe("two!");
    });

    it("does not store the same prompt twice in a row", () => {
      const prompt = conversed("same", "same");
      press(prompt, "up");
      press(prompt, "up");
      expect(prompt.value).toBe("same");
      press(prompt, "down");
      expect(prompt.value).toBe("");
    });
  });

  describe("slash queries", () => {
    it("suggests matching commands while typing a slash query", () => {
      const prompt = editor();
      type(prompt, "/ex");
      expect(prompt.suggestions().map((suggestion) => suggestion.name)).toEqual([
        "exit",
        "exit-all",
      ]);
    });

    it("leads with built-in commands by prefix only, never by loose fuzz", () => {
      const prompt = editor();
      type(prompt, "/co");
      expect(prompt.suggestions().map((suggestion) => suggestion.name)).toEqual([
        "cost",
        "context",
        "compact",
      ]);
    });

    it("hands the typed command and the selected suggestion back on enter", () => {
      const prompt = editor();
      type(prompt, "/ex");
      press(prompt, "down");
      expect(press(prompt, "return")).toEqual({ command: "ex", chosen: "exit-all" });
      expect(prompt.value).toBe("");
    });

    it("completes the selection with tab and clears with escape", () => {
      const prompt = editor();
      type(prompt, "/mo");
      expect(press(prompt, "tab")).toBe("handled");
      expect(prompt.value).toBe("/move-right");
      expect(press(prompt, "escape")).toBe("handled");
      expect(prompt.value).toBe("");
    });
  });
});
