import { describe, expect, it } from "vitest";
import { type LinkCell, markLinkTargets } from "../terminal-links.ts";
import { assertReferenceLinks } from "./file-links.ts";

const expected = "file:///workspace/packages/engine/src/providers/messages-wire.ts#L210";
const other = expected.replace("#L210", "#L211");
const open = `\x1b]8;id=42;${expected}\x1b\\`;
const close = "\x1b]8;;\x1b\\";
const first = "packages/";
const rest = "engine/src/providers/messages-wire.ts:210";

function cells(text: string, target: LinkCell["target"] = "none"): LinkCell[] {
  return [...text].map((text) => ({ text, target }));
}

function referenceRows({
  wrap = true,
  next = cells(rest, "expected"),
  beside = cells("│ "),
  suffix = cells(" today. "),
  chrome = cells("Keywork"),
} = {}): LinkCell[][] {
  const firstRow = [...cells("│ The fault sits in "), ...cells(first, "expected")];
  if (!wrap) return [chrome, [...firstRow, ...next, ...suffix]];
  return [chrome, firstRow, [...beside, ...next, ...suffix]];
}

describe("OSC 8 replay markers", () => {
  it("preserves cursor, erase and screen commands while an open link survives SGR resets", () => {
    const screen = "\x1b[?1049h";
    const row = "\x1b[9;18H";
    const erase = "\x1b[K";
    expect(
      markLinkTargets(
        `${screen}${open}\x1b[0m${row}\x1b[38:2::1:2:3mpac${erase}\x1b[2;18Hkages/${close}\x1b[m today.`,
        expected,
      ),
    ).toEqual({
      marked: `${screen}\x1b[0;1m${row}pac${erase}\x1b[2;18Hkages/\x1b[0m today.`,
      activeTarget: "",
    });
  });

  it("switches targets directly, honors BEL, and records an open final target", () => {
    expect(markLinkTargets(`\x1b]8;;${other}\x07first${open}second`, expected)).toEqual({
      marked: "\x1b[0;3mfirst\x1b[0;1msecond",
      activeTarget: expected,
    });
    expect(markLinkTargets(`${close}\x1b]8;;${expected};other\x07`, expected).activeTarget).toBe(
      `${expected};other`,
    );
  });
});

describe("file link cells", () => {
  it("requires every visible reference cell to point to the exact target across multiple rows", () => {
    expect(() => assertReferenceLinks(referenceRows())).not.toThrow();
    expect(() => assertReferenceLinks(referenceRows({ next: cells(rest) }))).toThrow(
      /exact workspace file and line/,
    );
    expect(() => assertReferenceLinks(referenceRows({ next: cells(rest, "other") }))).toThrow(
      /exact workspace file and line/,
    );
    expect(() => assertReferenceLinks(referenceRows({ next: [] }))).toThrow(
      /entire file reference/,
    );
    expect(() => assertReferenceLinks(referenceRows({ wrap: false }))).toThrow(
      /wraps across multiple/,
    );
    const rows = referenceRows();
    rows.splice(2, 0, cells("│ "));
    expect(() => assertReferenceLinks(rows)).toThrow(/consecutive rows/);
  });

  it("rejects a correct link on moved text or leaked into prose, padding, or chrome", () => {
    const cases = [
      referenceRows({ beside: cells("│  ") }),
      referenceRows({ suffix: [...cells(" "), ...cells("today.", "expected")] }),
      referenceRows({ suffix: [...cells(" today."), ...cells(" ", "expected")] }),
      referenceRows({ chrome: cells("Keywork", "other") }),
    ];
    for (const rows of cases) {
      expect(() => assertReferenceLinks(rows)).toThrow(/link outside the visible file reference/);
    }
  });
});
