import { describe, expect, it } from "vitest";
import { rampColor } from "./chroma.ts";
import { keyworkNight } from "./palette.ts";
import type { ChromeWeight, LifecycleState, PaneContext } from "./pane.ts";
import {
  focusMark,
  type PaneTitle,
  paneChrome,
  paneContentHeight,
  paneContentWidth,
  paneLine,
  selectedLine,
  trayCommandsPressing,
} from "./pane-chrome.ts";
import { titleSpans } from "./title-bar.ts";
import { width } from "./width.ts";

function contextWith(overrides: Partial<PaneContext> = {}): PaneContext {
  return { theme: keyworkNight, focused: false, width: 24, height: 8, ...overrides };
}

interface Cell {
  readonly text: string;
  readonly fg: string | undefined;
  readonly bg: string | undefined;
}

interface Node {
  props?: {
    border?: boolean;
    borderColor?: string;
    borderStyle?: string;
    customBorderChars?: { topLeft: string };
    backgroundColor?: string;
    content?: unknown;
  };
  children?: Node[];
}

function hexOf(color: { r: number; g: number; b: number } | undefined): string | undefined {
  if (color === undefined) return undefined;
  const byte = (channel: number) =>
    Math.round(channel * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
}

function titleRowOf(view: unknown): Cell[] {
  const row = (view as Node).children?.find((child) => typeof child.props?.content === "object");
  const chunks = (
    row?.props?.content as { chunks?: Array<{ text: string; fg?: never; bg?: never }> }
  )?.chunks;
  return (chunks ?? []).map((chunk) => ({
    text: chunk.text,
    fg: hexOf(chunk.fg),
    bg: hexOf(chunk.bg),
  }));
}

function rowText(view: unknown): string {
  return titleRowOf(view)
    .map((cell) => cell.text)
    .join("");
}

function frameOf(view: unknown): Node {
  const node = view as Node;
  return node.children?.find((child) => child.props?.border === true) ?? node;
}

function borderOf(view: unknown): string | undefined {
  return frameOf(view).props?.borderColor;
}

function titled(state: LifecycleState, stamp?: string, width = 84): PaneTitle {
  return {
    spans: titleSpans({ name: "auth-retry-fix", stamp, telemetry: "$0.01" }, width, true),
    state,
  };
}

const states: LifecycleState[] = ["idle", "working", "needs-you", "finished-unseen", "failed"];
const weights: ChromeWeight[] = ["regular", "seams", "borderless"];
const hue = rampColor(keyworkNight.ramp, 0.5);

describe("the own title row", () => {
  it("composes the boxed title row over the border with the padding of the old title string", () => {
    const view = paneChrome(contextWith({ width: 40 }), " session-1 · idle ");
    expect(rowText(view)).toBe(" session-1 · idle ");
    const row = (view as Node).children?.at(-1)?.props as { left?: number; top?: number };
    expect(row.left).toBe(2);
    expect(row.top).toBe(0);
    expect(frameOf(view).props?.border).toBe(true);
  });
});

describe("needs-you chrome", () => {
  it("inverts the label with the pane hue as ground and background as ink, one pad each side", () => {
    for (const chrome of weights) {
      const cells = titleRowOf(
        paneChrome(contextWith({ chrome, hue, width: 84 }), titled("needs-you", "█")),
      );
      const inverted = cells.filter((cell) => cell.bg === hue);
      expect(inverted.map((cell) => cell.text).join("")).toBe(" █ auth-retry-fix ");
      expect(inverted.every((cell) => cell.fg === keyworkNight.background)).toBe(true);
      const telemetry = cells.find((cell) => cell.text === "$0.01");
      expect(telemetry?.bg).not.toBe(hue);
      expect(
        rowText(paneChrome(contextWith({ chrome, hue, width: 84 }), titled("needs-you", "█"))),
      ).toBe(" █ auth-retry-fix · $0.01 ");
    }
  });

  it("inverts nothing in any other state, in any weight, focused or not", () => {
    for (const chrome of weights) {
      for (const focused of [true, false]) {
        for (const state of states.filter((candidate) => candidate !== "needs-you")) {
          const cells = titleRowOf(
            paneChrome(contextWith({ chrome, hue, focused, width: 84 }), titled(state, "█")),
          );
          expect(
            cells.some((cell) => cell.bg === hue),
            `${chrome} ${state}`,
          ).toBe(false);
        }
      }
    }
  });

  it("warms the border on needs-you and leaves it alone for finished-unseen and failed", () => {
    const resting = borderOf(paneChrome(contextWith({ hue }), titled("idle")));
    expect(borderOf(paneChrome(contextWith({ hue }), titled("finished-unseen", "█")))).toBe(
      resting,
    );
    expect(borderOf(paneChrome(contextWith({ hue }), titled("failed", "▛")))).toBe(resting);
    expect(borderOf(paneChrome(contextWith({ hue }), titled("working", "▒")))).toBe(resting);
    expect(borderOf(paneChrome(contextWith({ hue }), titled("needs-you", "█")))).not.toBe(resting);
  });

  it("reads every state from density alone once color is gone", () => {
    const stamps: Record<LifecycleState, string | undefined> = {
      idle: undefined,
      working: "▒",
      "needs-you": "█",
      "finished-unseen": "█",
      failed: "▛",
    };
    const rows = states.map((state) =>
      rowText(paneChrome(contextWith({ hue, width: 84 }), titled(state, stamps[state]))),
    );
    expect(rows[0]).toBe(" auth-retry-fix · $0.01 ");
    expect(rows[1]).toBe(" ▒ auth-retry-fix · $0.01 ");
    expect(rows[2]).toBe(" █ auth-retry-fix · $0.01 ");
    expect(rows[4]).toBe(" ▛ auth-retry-fix · $0.01 ");
  });
});

describe("the title row under pressure", () => {
  it("clips an overflowing row to the border room and keeps the stamp", () => {
    const view = paneChrome(contextWith({ width: 12, hue }), titled("needs-you", "█", 12));
    const text = rowText(view);
    expect(text.startsWith(" █ ")).toBe(true);
    expect([...text].length).toBeLessThanOrEqual(12 - 4);
  });

  it("measures a CJK slug in cells and never runs past the row", () => {
    const spans = titleSpans({ name: "我们在这里写字", stamp: "█" }, 14, true);
    for (const chrome of weights) {
      const row = rowText(paneChrome(contextWith({ chrome, width: 14 }), { spans, state: "idle" }));
      expect(width(row)).toBeLessThanOrEqual(14);
      expect(row).toContain("█ 我");
    }
  });

  it("inverts an ask at glyph tier 0 with the ascii stamp inside the ground", () => {
    const spans = titleSpans({ name: "auth-retry-fix", stamp: "#" }, 40, true);
    const view = paneChrome(
      contextWith({ hue, width: 40, glyphs: { glyphTier: 0, nerdFont: false } }),
      { spans, state: "needs-you" },
    );
    expect(
      titleRowOf(view)
        .filter((cell) => cell.bg === hue)
        .map((cell) => cell.text)
        .join(""),
    ).toBe(" # auth-retry-fix ");
    expect(frameOf(view).props?.customBorderChars?.topLeft).toBe("+");
  });

  it("follows the title's own state when it flips between frames", () => {
    const context = contextWith({ hue, width: 84 });
    expect(
      titleRowOf(paneChrome(context, titled("needs-you", "█"))).some((cell) => cell.bg === hue),
    ).toBe(true);
    expect(titleRowOf(paneChrome(context, titled("idle"))).some((cell) => cell.bg === hue)).toBe(
      false,
    );
  });
});

describe("chrome weights", () => {
  it("clips the header row before the right padding cell", () => {
    expect(rowText(paneChrome(contextWith({ chrome: "seams", width: 6 }), " long-title "))).toBe(
      " long",
    );
  });

  it("charges two columns and one row of chrome in the headed weights, four and two boxed", () => {
    expect(paneContentWidth({ width: 20, chrome: "seams" })).toBe(18);
    expect(paneContentHeight({ height: 10, chrome: "seams" })).toBe(9);
    expect(paneContentWidth({ width: 20, chrome: "borderless" })).toBe(18);
    expect(paneContentHeight({ height: 10, chrome: "borderless" })).toBe(9);
    expect(paneContentWidth({ width: 20, chrome: "regular" })).toBe(16);
    expect(paneContentHeight({ height: 10 })).toBe(8);
  });

  it("lifts the focused pane's ground in the borderless weight and marks focus in density", () => {
    const focused = paneChrome(contextWith({ chrome: "borderless", focused: true }), " t ") as Node;
    expect(focused.props?.backgroundColor).toBe(keyworkNight.panel);
    expect(rowText(focused)).toBe(`${focusMark.tier1}t `);
    const rested = paneChrome(contextWith({ chrome: "borderless" }), " t ") as Node;
    expect(rested.props?.backgroundColor).toBeUndefined();
    expect(rowText(rested)).toBe(" t ");
    const ascii = paneChrome(
      contextWith({
        chrome: "borderless",
        focused: true,
        glyphs: { glyphTier: 0, nerdFont: false },
      }),
      " t ",
    );
    expect(rowText(ascii)).toBe(`${focusMark.tier0}t `);
  });
});

function propsOf(child: unknown): { content?: string; bg?: unknown } {
  return (child as { props: { content?: string; bg?: unknown } }).props;
}

describe("row lines", () => {
  it("clips and pads the selected line and clips an inked line by display cells", () => {
    const selected = propsOf(selectedLine("日本語テキスト", keyworkNight, 4));
    expect(selected.content).toBe("日本");
    expect(propsOf(selectedLine("日本語", keyworkNight, 5)).content).toBe("日本 ");
    expect(selected.bg).toBe(keyworkNight.accent);
    expect(propsOf(selectedLine("ab", keyworkNight, 4)).content).toBe("ab  ");
    expect(propsOf(paneLine("abcdef", keyworkNight.text, 3)).content).toBe("abc");
  });
});

describe("trayCommandsPressing", () => {
  it("derives the shortcut glyph from the key and presses the chord when run", () => {
    const pressed: string[] = [];
    const commands = trayCommandsPressing(
      (chord) => pressed.push(chord.shift ? `shift+${chord.name}` : chord.name),
      [
        { name: "open", description: "open it", key: "enter" },
        { name: "back", description: "go back", key: "escape" },
        { name: "label", description: "label it", key: "shift+l" },
        { name: "refresh", description: "reload", key: "r" },
      ],
    );
    expect(commands.map((command) => command.shortcut)).toEqual(["enter", "esc", "L", "r"]);
    for (const command of commands) command.run();
    expect(pressed).toEqual(["enter", "escape", "shift+l", "r"]);
  });
});
