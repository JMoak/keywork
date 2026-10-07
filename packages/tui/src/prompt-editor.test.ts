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
    expect(press(prompt, "return")).toEqual({ submit: "hi there", behavior: "queue", images: [] });
    expect(press(prompt, "alt+return")).toEqual({
      submit: "hi there",
      behavior: "steer",
      images: [],
    });
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

  describe("draft recovery", () => {
    function cleared(text: string, ...prompts: string[]): PromptEditor {
      const prompt = editor();
      for (const earlier of prompts) prompt.remember(earlier);
      type(prompt, text);
      expect(press(prompt, "ctrl+c")).toBe("handled");
      expect(prompt.value).toBe("");
      return prompt;
    }

    it("brings back the draft ctrl+c cleared on up at an empty prompt", () => {
      const prompt = cleared("half a thought");
      expect(press(prompt, "up")).toBe("handled");
      expect(prompt.value).toBe("half a thought");
    });

    it("falls through to history on the next up and returns to the draft on down", () => {
      const prompt = cleared("draft", "one", "two");
      press(prompt, "up");
      expect(prompt.value).toBe("draft");
      press(prompt, "up");
      expect(prompt.value).toBe("two");
      press(prompt, "up");
      expect(prompt.value).toBe("one");
      press(prompt, "down");
      press(prompt, "down");
      expect(prompt.value).toBe("draft");
      press(prompt, "down");
      expect(prompt.value).toBe("");
      press(prompt, "up");
      expect(prompt.value).toBe("draft");
    });

    it("keeps one draft per composer, the most recently cleared", () => {
      const prompt = cleared("first");
      type(prompt, "second");
      press(prompt, "ctrl+c");
      press(prompt, "up");
      expect(prompt.value).toBe("second");
      press(prompt, "up");
      expect(prompt.value).toBe("second");
    });

    it("does nothing with ctrl+c on an empty prompt and keeps the held draft", () => {
      const prompt = cleared("held");
      expect(press(prompt, "ctrl+c")).toBe("pass");
      press(prompt, "up");
      expect(prompt.value).toBe("held");
    });

    it("leaves up alone while the prompt has text", () => {
      const prompt = cleared("held", "one");
      type(prompt, "new");
      expect(press(prompt, "up")).toBe("pass");
      expect(prompt.value).toBe("new");
    });

    it("lets go of the draft once it is edited or sent", () => {
      const edited = cleared("held", "one");
      press(edited, "up");
      type(edited, "!");
      expect(edited.value).toBe("held!");
      edited.clear();
      press(edited, "up");
      expect(edited.value).toBe("one");

      const sent = cleared("held", "one");
      press(sent, "up");
      expect(press(sent, "return")).toEqual({ submit: "held", behavior: "queue", images: [] });
      sent.clear();
      press(sent, "up");
      expect(sent.value).toBe("one");
    });

    it("clears a slash query too", () => {
      const prompt = cleared("/ex");
      press(prompt, "up");
      expect(prompt.value).toBe("/ex");
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

describe("large-paste placeholders", () => {
  const seven = ["a", "b", "c", "d", "e", "f", "g"].join("\n");

  it("collapses a paste past six lines into a numbered placeholder and submits the full text", () => {
    const editor = new PromptEditor(() => {}, []);
    editor.paste("intro ");
    editor.paste(seven);
    expect(editor.value).toBe("intro [pasted #1, 7 lines]");
    expect(editor.handleKey(parseChord("return"), undefined)).toEqual({
      submit: `intro ${seven}`,
      behavior: "queue",
      images: [],
    });
  });

  it("numbers placeholders within a prompt and starts over after clear", () => {
    const editor = new PromptEditor(() => {}, []);
    editor.paste(seven);
    editor.paste(seven);
    expect(editor.value).toBe("[pasted #1, 7 lines][pasted #2, 7 lines]");
    editor.clear();
    editor.paste(seven);
    expect(editor.value).toBe("[pasted #1, 7 lines]");
  });

  it("expands the placeholder at the cursor and leaves other text alone", () => {
    const editor = new PromptEditor(() => {}, []);
    editor.paste(seven);
    editor.paste(" tail");
    expect(editor.expandPlaceholderAtCursor()).toBe(false);
    editor.buffer.home();
    expect(editor.expandPlaceholderAtCursor()).toBe(true);
    expect(editor.value).toBe(`${seven} tail`);
  });

  it("brings pasted text back with a draft recovered after ctrl+c", () => {
    const editor = new PromptEditor(() => {}, []);
    editor.paste("look: ");
    editor.paste(seven);
    editor.handleKey(parseChord("ctrl+c"), undefined);
    editor.paste(seven);
    editor.clear();
    editor.handleKey(parseChord("up"), undefined);
    expect(editor.value).toBe("look: [pasted #1, 7 lines]");
    expect(editor.handleKey(parseChord("return"), undefined)).toEqual({
      submit: `look: ${seven}`,
      behavior: "queue",
      images: [],
    });
  });

  it("does not expand a placeholder whose text it never held", () => {
    const editor = new PromptEditor(() => {}, []);
    editor.paste("[pasted #9, 40 lines]");
    expect(editor.expandPlaceholderAtCursor()).toBe(false);
    expect(editor.handleKey(parseChord("return"), undefined)).toEqual({
      submit: "[pasted #9, 40 lines]",
      behavior: "queue",
      images: [],
    });
  });
});

describe("PromptEditor @-mentions", () => {
  const workspace = ["src/app.ts", "src/app-core.ts", "docs/readme.md"].map((relative) => ({
    relative,
  }));

  function mentioning(): PromptEditor {
    return new PromptEditor(
      () => {},
      builtIn,
      undefined,
      () => workspace,
    );
  }

  it("opens a completion over the workspace when @ is typed and narrows as you type", () => {
    const prompt = mentioning();
    type(prompt, "fix @");
    expect(prompt.suggestions().map(({ name }) => name)).toHaveLength(3);
    type(prompt, "core");
    expect(prompt.suggestions().map(({ name }) => name)).toEqual(["src/app-core.ts"]);
    expect(prompt.completing()).toBe(true);
  });

  it("inserts the chosen path on tab and keeps the rest of the prompt", () => {
    const prompt = mentioning();
    type(prompt, "fix @app");
    press(prompt, "down");
    expect(press(prompt, "tab")).toBe("handled");
    expect(prompt.value).toBe("fix @src/app-core.ts ");
    expect(prompt.suggestions()).toEqual([]);
  });

  it("inserts on enter instead of sending while the completion is open", () => {
    const prompt = mentioning();
    type(prompt, "@readme");
    expect(press(prompt, "return")).toBe("handled");
    expect(prompt.value).toBe("@docs/readme.md ");
    expect(press(prompt, "return")).toEqual({
      submit: "@docs/readme.md",
      behavior: "queue",
      images: [],
    });
  });

  it("dismisses on esc without touching the text, and enter then sends", () => {
    const prompt = mentioning();
    type(prompt, "ping @app");
    expect(press(prompt, "escape")).toBe("handled");
    expect(prompt.value).toBe("ping @app");
    expect(prompt.suggestions()).toEqual([]);
    type(prompt, ".ts");
    expect(prompt.suggestions()).toEqual([]);
    expect(press(prompt, "return")).toEqual({
      submit: "ping @app.ts",
      behavior: "queue",
      images: [],
    });
  });

  it("sends on enter when the typed path is already complete", () => {
    const prompt = mentioning();
    type(prompt, "see @src/app.ts");
    expect(press(prompt, "return")).toEqual({
      submit: "see @src/app.ts",
      behavior: "queue",
      images: [],
    });
  });

  it("accepts a clicked tray row", () => {
    const prompt = mentioning();
    type(prompt, "@src");
    expect(prompt.acceptSuggestion(1)).toBe("handled");
    expect(prompt.value).toMatch(/^@src\/app(-core)?\.ts $/);
  });

  it("stays out of the way with no workspace source, an email, or a slash command", () => {
    const plain = editor();
    type(plain, "@app");
    expect(plain.suggestions()).toEqual([]);
    const prompt = mentioning();
    type(prompt, "me@app");
    expect(prompt.suggestions()).toEqual([]);
    expect(prompt.completing()).toBe(false);
  });
});

describe("PromptEditor send modes and chips", () => {
  const image = {
    part: { type: "image" as const, mediaType: "image/png", data: "AAAA" },
    bytes: 2048,
    format: "png",
  };

  it("sends now on ctrl+enter and carries no images by default", () => {
    const prompt = editor();
    type(prompt, "go");
    expect(press(prompt, "ctrl+return")).toEqual({ submit: "go", behavior: "now", images: [] });
  });

  it("renders an attached image as a chip and hands the part over on send", () => {
    const prompt = editor();
    type(prompt, "look");
    prompt.attachImage(image);
    expect(prompt.value).toBe("look [image #1, png 2 KB] ");
    expect(prompt.attachedImages()).toEqual([image.part]);
    type(prompt, "closely");
    expect(press(prompt, "return")).toEqual({
      submit: "look  closely",
      behavior: "queue",
      images: [image.part],
    });
    prompt.clear();
    expect(prompt.attachedImages()).toEqual([]);
  });

  it("refuses to send a chip with no words around it", () => {
    const prompt = editor();
    prompt.attachImage(image);
    expect(press(prompt, "return")).toBe("handled");
  });

  it("keeps chips through ctrl+c and up, like pastes", () => {
    const prompt = editor();
    prompt.attachImage(image);
    type(prompt, "see");
    press(prompt, "ctrl+c");
    expect(prompt.value).toBe("");
    press(prompt, "up");
    expect(prompt.value).toBe("[image #1, png 2 KB] see");
    expect(prompt.attachedImages()).toEqual([image.part]);
  });

  it("sets flushed prompts aside so up walks them back newest first", () => {
    const prompt = editor();
    prompt.remember("sent earlier");
    prompt.holdAside(["older queued", "newest queued"]);
    expect(prompt.value).toBe("");
    press(prompt, "up");
    expect(prompt.value).toBe("newest queued");
    press(prompt, "up");
    expect(prompt.value).toBe("older queued");
    press(prompt, "up");
    expect(prompt.value).toBe("sent earlier");
    press(prompt, "down");
    press(prompt, "down");
    expect(prompt.value).toBe("newest queued");
  });

  it("expands pastes for the external editor and takes the edit back whole", () => {
    const prompt = editor();
    type(prompt, "intro ");
    prompt.paste("l1\nl2\nl3\nl4\nl5\nl6\nl7");
    expect(prompt.value).toBe("intro [pasted #1, 7 lines]");
    expect(prompt.draftForEditing()).toBe("intro l1\nl2\nl3\nl4\nl5\nl6\nl7");
    prompt.replaceDraft("rewritten\noutside");
    expect(prompt.value).toBe("rewritten\noutside");
    expect(press(prompt, "return")).toEqual({
      submit: "rewritten\noutside",
      behavior: "queue",
      images: [],
    });
  });
});
