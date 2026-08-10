import { describe, expect, it } from "vitest";
import { InputBuffer } from "./input-buffer.ts";

function loaded(text: string): InputBuffer {
  const buffer = new InputBuffer();
  buffer.load(text);
  return buffer;
}

describe("InputBuffer", () => {
  it("inserts at the cursor, not just the end", () => {
    const buffer = loaded("hello world");
    buffer.home();
    for (let step = 0; step < 6; step += 1) buffer.right();
    buffer.insert("brave ");
    expect(buffer.value).toBe("hello brave world");
  });

  it("backspaces the character before the cursor and stops at the start", () => {
    const buffer = loaded("ab");
    buffer.left();
    buffer.backspace();
    expect(buffer.value).toBe("b");
    buffer.backspace();
    buffer.backspace();
    expect(buffer.value).toBe("b");
  });

  it("moves home and end within the current line only", () => {
    const buffer = loaded("first\nsecond");
    buffer.home();
    expect(buffer.cursorAt()).toEqual({ line: 1, column: 0 });
    buffer.end();
    expect(buffer.cursorAt()).toEqual({ line: 1, column: 6 });
  });

  it("moves between lines, clamping the column to the shorter line", () => {
    const buffer = loaded("long line here\nab");
    expect(buffer.up()).toBe(true);
    expect(buffer.cursorAt()).toEqual({ line: 0, column: 2 });
    buffer.end();
    expect(buffer.down()).toBe(true);
    expect(buffer.cursorAt()).toEqual({ line: 1, column: 2 });
  });

  it("reports boundary moves as unhandled for the caller to repurpose", () => {
    const buffer = loaded("only line");
    expect(buffer.up()).toBe(false);
    expect(buffer.down()).toBe(false);
  });

  it("keeps home at position zero when the text starts with a newline", () => {
    const buffer = loaded("\nabc");
    buffer.home();
    expect(buffer.cursorAt()).toEqual({ line: 1, column: 0 });
    while (buffer.cursorAt().line > 0) buffer.left();
    buffer.home();
    expect(buffer.cursorAt()).toEqual({ line: 0, column: 0 });
  });

  it("deletes a whole emoji with one backspace", () => {
    const buffer = loaded("hi😀");
    buffer.backspace();
    expect(buffer.value).toBe("hi");
  });

  it("deletes a joined emoji cluster as one unit", () => {
    const buffer = loaded("a👨‍👩‍👧");
    buffer.backspace();
    expect(buffer.value).toBe("a");
    buffer.backspace();
    expect(buffer.value).toBe("");
  });

  it("steps the cursor over emoji and CJK without landing mid-pair", () => {
    const buffer = loaded("我😀b");
    buffer.left();
    expect(buffer.cursorAt().column).toBe(3);
    buffer.left();
    expect(buffer.cursorAt().column).toBe(1);
    buffer.left();
    expect(buffer.cursorAt().column).toBe(0);
    buffer.right();
    expect(buffer.cursorAt().column).toBe(1);
    buffer.right();
    expect(buffer.cursorAt().column).toBe(3);
  });

  it("inserts at a cursor placed inside emoji text without splitting pairs", () => {
    const buffer = loaded("😀😀");
    buffer.left();
    buffer.insert("x");
    expect(buffer.value).toBe("😀x😀");
  });

  it("keeps vertical moves off surrogate halves", () => {
    const buffer = loaded("😀😀😀\nabc");
    expect(buffer.up()).toBe(true);
    buffer.insert("|");
    expect(Array.from(buffer.value.split("\n")[0] ?? "")).toContain("|");
    expect(buffer.value).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("splits lines with newline and rejoins them with backspace", () => {
    const buffer = loaded("ab");
    buffer.left();
    buffer.newline();
    expect(buffer.lines()).toEqual(["a", "b"]);
    buffer.backspace();
    expect(buffer.value).toBe("ab");
    expect(buffer.cursorAt()).toEqual({ line: 0, column: 1 });
  });
});
