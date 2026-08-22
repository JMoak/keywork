import { describe, expect, it } from "vitest";
import { paneBorder, rampPositions } from "./chroma.ts";
import type { PaneContext } from "./pane.ts";
import {
  paneChrome,
  paneLine,
  rowsView,
  selectedLine,
  toneInk,
  trayCommandsPressing,
} from "./pane-chrome.ts";
import { AppProbe } from "./probe.ts";
import { RowCursor } from "./row-cursor.ts";
import { keyworkNight } from "./theme.ts";

function contextWith(overrides: Partial<PaneContext> = {}): PaneContext {
  return { theme: keyworkNight, focused: false, width: 24, height: 8, ...overrides };
}

function borderOf(view: unknown): string | undefined {
  return (view as { props?: { borderColor?: string } }).props?.borderColor;
}

describe("paneChrome border color", () => {
  it("renders today's tokens when no chroma border is resolved", () => {
    expect(borderOf(paneChrome(contextWith(), " t "))).toBe(keyworkNight.border);
    expect(borderOf(paneChrome(contextWith({ focused: true }), " t "))).toBe(
      keyworkNight.borderFocus,
    );
  });

  it("renders the resolved chroma border when the context carries one", () => {
    const view = paneChrome(contextWith({ borderColor: "#123456" }), " t ");
    expect(borderOf(view)).toBe("#123456");
  });

  it("renders a single pane byte-identical to today", () => {
    for (const focused of [true, false]) {
      const chroma = paneChrome(
        contextWith({ focused, borderColor: paneBorder(keyworkNight, 0, focused) }),
        " t ",
      );
      const today = paneChrome(contextWith({ focused }), " t ");
      expect(borderOf(chroma)).toBe(borderOf(today));
    }
  });

  it("renders every rank byte-identical to today when chroma is off", () => {
    const flat = { ...keyworkNight, ramp: [keyworkNight.accent] };
    for (const focused of [true, false]) {
      for (const t of [0, 0.3, 0.7, 1]) {
        const chroma = paneChrome(
          contextWith({ focused, borderColor: paneBorder(flat, t, focused) }),
          " t ",
        );
        const today = paneChrome(contextWith({ focused }), " t ");
        expect(borderOf(chroma)).toBe(borderOf(today));
      }
    }
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
    expect(commands.map((command) => command.shortcut)).toEqual(["⏎", "esc", "L", "r"]);
    for (const command of commands) command.run();
    expect(pressed).toEqual(["enter", "escape", "shift+l", "r"]);
  });
});
