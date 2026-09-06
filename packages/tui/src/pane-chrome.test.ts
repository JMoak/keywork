import { describe, expect, it } from "vitest";
import { lifecycleChrome, paneBorder, rampColor, rampPositions } from "./chroma.ts";
import type { ChromeWeight, LifecycleState, PaneContext } from "./pane.ts";
import {
  focusMark,
  type PaneTitle,
  paneChrome,
  paneContentHeight,
  paneContentWidth,
  paneLine,
  rowsView,
  selectedLine,
  toneInk,
  trayCommandsPressing,
} from "./pane-chrome.ts";
import { AppProbe } from "./probe.ts";
import { RowCursor } from "./row-cursor.ts";
import { keyworkNight } from "./theme.ts";
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

  it("never hands a title to the OpenTUI box", () => {
    for (const chrome of weights) {
      const view = paneChrome(contextWith({ chrome }), " t ") as Node & {
        props: { title?: string };
      };
      expect(view.props.title).toBeUndefined();
      expect(frameOf(view).props).not.toHaveProperty("title");
    }
  });

  it("renders the flat single-pane border byte-identical to the resolver at ramp position 0", () => {
    for (const focused of [true, false]) {
      expect(borderOf(paneChrome(contextWith({ focused }), " t "))).toBe(
        paneBorder(keyworkNight, 0, focused),
      );
    }
    expect(borderOf(paneChrome(contextWith(), " t "))).toBe(keyworkNight.border);
    expect(borderOf(paneChrome(contextWith({ focused: true }), " t "))).toBe(
      keyworkNight.borderFocus,
    );
  });

  it("takes its border from the pane's hue through the lifecycle resolver", () => {
    for (const focused of [true, false]) {
      expect(borderOf(paneChrome(contextWith({ hue, focused }), " t "))).toBe(
        lifecycleChrome("idle", focused, hue, keyworkNight).borderColor,
      );
    }
  });

  it("inks the slug words in the label ink, separators dim, the arc colon soft", () => {
    const view = paneChrome(contextWith({ chrome: "seams", focused: true, hue, width: 84 }), {
      spans: titleSpans({ name: "arc:auth-retry-fix" }, 60, true),
      state: "idle",
    });
    const cells = titleRowOf(view);
    const inkOf = (text: string) => cells.find((cell) => cell.text === text)?.fg;
    const label = lifecycleChrome("idle", true, hue, keyworkNight).labelInk;
    expect(inkOf("auth")).toBe(label);
    expect(inkOf("retry")).toBe(label);
    expect(inkOf("-")).toBe(keyworkNight.textDim);
    expect(inkOf(":")).toBe(keyworkNight.accentSoft);
    expect(rowText(view)).toBe(" arc:auth-retry-fix ");
  });

  it("inks telemetry mid, the joints and the mode word dim", () => {
    const spans = titleSpans({ name: "s", telemetry: "$0.01", modeWord: "plan" }, 132, true);
    const cells = titleRowOf(paneChrome(contextWith({ width: 132 }), { spans, state: "idle" }));
    expect(cells.find((cell) => cell.text === "$0.01")?.fg).toBe(keyworkNight.textMid);
    expect(cells.find((cell) => cell.text === "plan")?.fg).toBe(keyworkNight.textDim);
    expect(cells.find((cell) => cell.text === " · ")?.fg).toBe(keyworkNight.textDim);
  });

  it("renders the pin mark first and dim in every weight", () => {
    for (const chrome of weights) {
      const cells = titleRowOf(paneChrome(contextWith({ chrome, pinMark: "▪" }), " tail "));
      expect(cells.map((cell) => cell.text).join("")).toBe(" ▪ tail ");
      expect(cells.find((cell) => cell.text.startsWith("▪"))?.fg).toBe(keyworkNight.textDim);
    }
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

  it("keeps the pin mark outside the inversion", () => {
    const cells = titleRowOf(
      paneChrome(contextWith({ hue, width: 84, pinMark: "▪" }), titled("needs-you", "█")),
    );
    expect(cells.map((cell) => cell.text).join("")).toBe(" ▪ █ auth-retry-fix · $0.01 ");
    expect(cells.find((cell) => cell.text.startsWith("▪"))?.bg).not.toBe(hue);
    expect(
      cells
        .filter((cell) => cell.bg === hue)
        .map((cell) => cell.text)
        .join(""),
    ).toBe(" █ auth-retry-fix ");
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

  it("steps the quiet states' name ink without touching the ground", () => {
    const inkOf = (state: LifecycleState) =>
      titleRowOf(paneChrome(contextWith({ hue, width: 84 }), titled(state, "█"))).find(
        (cell) => cell.text === "auth",
      );
    expect(inkOf("finished-unseen")?.fg).toBe(keyworkNight.text);
    expect(inkOf("failed")?.fg).toBe(keyworkNight.error);
    expect(inkOf("idle")?.fg).toBe(keyworkNight.textMid);
    expect(inkOf("failed")?.bg).not.toBe(hue);
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

  it("fades the inverted ground up from the border ink as the arrival plays", () => {
    const at = (groundArrival: number | undefined) =>
      titleRowOf(
        paneChrome(contextWith({ hue, width: 84 }), { ...titled("needs-you", "█"), groundArrival }),
      ).find((cell) => cell.text === "auth")?.bg;
    expect(at(0)).toBe(keyworkNight.border);
    expect(at(1)).toBe(hue);
    expect(at(undefined)).toBe(hue);
    expect(at(0.5)).not.toBe(hue);
    expect(at(0.5)).not.toBe(keyworkNight.border);
  });

  it("fades the border up from the resting border as a pane arrives", () => {
    const at = (arrival: number | undefined) =>
      borderOf(paneChrome(contextWith({ hue, focused: true }), { ...titled("idle"), arrival }));
    expect(at(0)).toBe(keyworkNight.border);
    expect(at(1)).toBe(at(undefined));
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
  it("rounds the boxed corners at glyph tier 1 and above and squares them at tier 0", () => {
    const rounded = frameOf(
      paneChrome(contextWith({ glyphs: { glyphTier: 1, nerdFont: false } }), " t "),
    );
    expect(rounded.props?.borderStyle).toBe("rounded");
    expect(rounded.props?.customBorderChars).toBeUndefined();
    const square = frameOf(
      paneChrome(contextWith({ glyphs: { glyphTier: 0, nerdFont: false } }), " t "),
    );
    expect(square.props?.borderStyle).toBe("single");
    expect(square.props?.customBorderChars).toMatchObject({
      topLeft: "+",
      horizontal: "-",
      vertical: "|",
    });
    expect(frameOf(paneChrome(contextWith(), " t ")).props?.borderStyle).toBe("rounded");
  });

  it("draws no border in the seams weight and puts the title on a header row", () => {
    const view = paneChrome(contextWith({ chrome: "seams" }), " session-1 · idle ") as Node;
    expect(view.props?.border).toBeUndefined();
    expect(view.children?.[0]?.props?.content).toBeTypeOf("object");
    expect(rowText(view)).toBe(" session-1 · idle ");
  });

  it("inks the header in the pane's hue when focused and in mid ink otherwise", () => {
    const focused = titleRowOf(
      paneChrome(contextWith({ chrome: "seams", focused: true, hue }), " t "),
    );
    expect(focused.find((cell) => cell.text === "t")?.fg).toBe(
      lifecycleChrome("idle", true, hue, keyworkNight).borderColor,
    );
    const rested = titleRowOf(paneChrome(contextWith({ chrome: "seams", hue }), " t "));
    expect(rested.find((cell) => cell.text === "t")?.fg).toBe(keyworkNight.textMid);
  });

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

  it("keeps the borderless focus mark inside an inverted label", () => {
    const cells = titleRowOf(
      paneChrome(
        contextWith({ chrome: "borderless", focused: true, hue, width: 84 }),
        titled("needs-you", "█"),
      ),
    );
    expect(cells.find((cell) => cell.text === focusMark.tier1)?.bg).toBe(hue);
  });
});

describe("pane hue identity", () => {
  it("travels with the pane through dock moves and cycles", () => {
    const probe = new AppProbe();
    probe.keys("ctrl+k", "s", "s");
    const spawnOrder = () => [...probe.core.panes.keys()];
    const before = rampPositions(spawnOrder());
    expect(before.size).toBe(3);
    probe.keys("ctrl+k", "shift+l").keys("ctrl+k", "c").keys("ctrl+k", "shift+h");
    expect(rampPositions(spawnOrder())).toEqual(before);
  });

  it("recomputes the sweep when a pane closes", () => {
    const probe = new AppProbe();
    probe.keys("ctrl+k", "s", "s");
    expect(rampPositions([...probe.core.panes.keys()]).size).toBe(3);
    probe.command("exit");
    const survivors = [...probe.core.panes.keys()];
    expect(survivors.length).toBe(2);
    expect([...rampPositions(survivors).values()]).toEqual([0, 1]);
  });
});

function propsOf(child: unknown): { content?: string; bg?: unknown } {
  return (child as { props: { content?: string; bg?: unknown } }).props;
}

class Words extends RowCursor<string> {
  constructor(private readonly words: string[]) {
    super(() => {});
  }

  protected buildRows(): string[] {
    return this.words;
  }

  protected keyOf(row: string): string {
    return row;
  }

  protected override selectable(row: string): boolean {
    return row !== "heading";
  }
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

  it("paints only the cursored selectable row selected and the rest through the pane", () => {
    const list = new Words(["heading", "alpha", "beta"]);
    const dim = (row: string) => paneLine(row, keyworkNight.textDim, 10);
    list.cursor = 1;
    const lines = rowsView(list, 3, keyworkNight, 10, {
      text: (row) => row.toUpperCase(),
      line: dim,
    });
    expect(lines.map(propsOf).map((line) => line.content)).toEqual([
      "heading",
      "ALPHA     ",
      "beta",
    ]);
    expect(propsOf(lines[1]).bg).toBe(keyworkNight.accent);
    list.cursor = 0;
    const unselectable = rowsView(list, 3, keyworkNight, 10, { text: (row) => row, line: dim });
    expect(unselectable.map(propsOf).every((line) => line.bg === undefined)).toBe(true);
  });

  it("renders an empty list as the calm line it was given, or nothing", () => {
    const dim = (row: string) => paneLine(row, keyworkNight.textDim, 20);
    const calm = rowsView(new Words([]), 3, keyworkNight, 20, {
      empty: "nothing here",
      text: (row) => row,
      line: dim,
    });
    expect(calm.map(propsOf).map((line) => line.content)).toEqual(["nothing here"]);
    expect(rowsView(new Words([]), 3, keyworkNight, 20, { text: (row) => row, line: dim })).toEqual(
      [],
    );
  });

  it("maps every tone to a distinct theme ink", () => {
    const tones = ["dim", "normal", "heading", "alert"] as const;
    expect(new Set(tones.map((tone) => toneInk(keyworkNight, tone))).size).toBe(4);
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
