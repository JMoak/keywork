import type { ActivePreset } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import { appBindings } from "../app-actions.ts";
import { CommandRegistry } from "../commands.ts";
import type { Screen } from "../geometry.ts";
import { Keymap } from "../keymap.ts";
import { parseChord } from "../keys.ts";
import { HelpOverlay } from "./help.ts";
import {
  helpFrame,
  type OverlayFrame,
  paletteFrame,
  panelRowRoom,
  pastedLine,
  RowOverlay,
  steppedIndex,
} from "./overlay.ts";
import { PaletteOverlay } from "./palette.ts";
import { PresetOverlay, type PresetsPort } from "./preset.ts";

const screen: Screen = { width: 120, height: 40 };

class ThreeRows extends RowOverlay {
  readonly kind = "help" as const;
  readonly log: string[] = [];

  frame(): OverlayFrame {
    return { x: 10, y: 5, width: 20, height: 8, firstRowY: 7 };
  }

  rowCount(): number {
    return 3;
  }

  handleKey(): void {}

  override hover(row: number): void {
    this.log.push(`hover ${row}`);
  }

  click(row: number): void {
    this.log.push(`click ${row}`);
  }

  outside(): void {
    this.log.push("outside");
  }
}

describe("RowOverlay mouse routing", () => {
  it("hovers rows on move, chooses on click and dismisses outside the frame", () => {
    const overlay = new ThreeRows();
    overlay.handleMouse({ type: "move", x: 12, y: 8 }, screen);
    overlay.handleMouse({ type: "down", x: 12, y: 9, button: 0 }, screen);
    overlay.handleMouse({ type: "down", x: 12, y: 5, button: 0 }, screen);
    overlay.handleMouse({ type: "down", x: 0, y: 0, button: 0 }, screen);
    overlay.handleMouse({ type: "move", x: 0, y: 0 }, screen);
    expect(overlay.log).toEqual(["hover 1", "click 2", "outside"]);
  });

  it("ignores rows past the last one", () => {
    const overlay = new ThreeRows();
    overlay.handleMouse({ type: "down", x: 12, y: 11, button: 0 }, screen);
    expect(overlay.log).toEqual([]);
  });
});

describe("overlay frames", () => {
  it("centers the palette near the top and the help box mid-screen", () => {
    const palette = paletteFrame(screen, 4);
    expect(palette).toEqual({ x: 28, y: 2, width: 64, height: 9, firstRowY: 5 });
    const help = helpFrame(screen, 10);
    expect(help.width).toBe(52);
    expect(help.firstRowY).toBe(help.y + 2);
    expect(help.y).toBe(Math.floor((screen.height - help.height) / 2));
  });

  it("keeps at least one row of height for an empty palette", () => {
    expect(paletteFrame(screen, 0).height).toBe(6);
  });

  it("clamps a tall panel to the screen and leaves a row above and below", () => {
    const short: Screen = { width: 120, height: 30 };
    const help = helpFrame(short, 27);
    expect(help.height).toBe(28);
    expect(help.y).toBe(1);
    expect(panelRowRoom(help)).toBe(23);
    expect(panelRowRoom(helpFrame(screen, 10))).toBe(10);
  });
});

describe("pastedLine and steppedIndex", () => {
  it("folds pasted newlines into one trimmed line", () => {
    expect(pastedLine("  a\r\nb\nc  ")).toBe("a b c");
  });

  it("wraps the index around in both directions", () => {
    expect(steppedIndex(2, parseChord("down"), 3)).toBe(0);
    expect(steppedIndex(0, parseChord("up"), 3)).toBe(2);
    expect(steppedIndex(0, parseChord("left"), 3)).toBeUndefined();
  });
});

describe("PaletteOverlay", () => {
  function registryWith(...names: string[]) {
    const registry = new CommandRegistry();
    const ran: string[] = [];
    for (const name of names) {
      registry.register({ name, description: name, run: () => ran.push(name) });
    }
    return { registry, ran };
  }

  it("dismisses before running so the command may open another overlay", () => {
    const { registry, ran } = registryWith("zoom", "split");
    const order: string[] = [];
    const palette = new PaletteOverlay(registry, ">sp", {
      dismiss: () => order.push("dismiss"),
    });
    registry.register({ name: "probe", description: "", run: () => order.push("ran") });
    palette.handleKey(parseChord("enter"), undefined);
    expect(ran).toEqual(["split"]);
    expect(order).toEqual(["dismiss"]);
  });

  it("types, pastes and backspaces into the query and resets the cursor", () => {
    const { registry } = registryWith("zoom", "split", "exit");
    const palette = new PaletteOverlay(registry, ">", { dismiss: () => {} });
    palette.handleKey(parseChord("down"), undefined);
    expect(palette.index).toBe(1);
    palette.handleKey(parseChord("z"), "z");
    expect(palette.query).toBe(">z");
    expect(palette.index).toBe(0);
    expect(palette.entries.map((entry) => entry.name)).toEqual(["zoom"]);
    palette.handlePaste("oo");
    expect(palette.query).toBe(">zoo");
    palette.handleKey(parseChord("backspace"), undefined);
    expect(palette.query).toBe(">zo");
  });

  it("separates jump entries from commands by mode", () => {
    const { registry } = registryWith("zoom");
    registry.addSource(() => [
      { name: "go-a", label: "a", description: "", jump: true, run: () => {} },
    ]);
    expect(new PaletteOverlay(registry, "", { dismiss: () => {} }).mode).toBe("go");
    expect(
      new PaletteOverlay(registry, "", { dismiss: () => {} }).entries.map((e) => e.name),
    ).toEqual(["go-a"]);
    expect(
      new PaletteOverlay(registry, ">", { dismiss: () => {} }).entries.map((e) => e.name),
    ).toEqual(["zoom"]);
  });
});

describe("PresetOverlay", () => {
  function portWith(active: ActivePreset) {
    const applied: string[] = [];
    const port: PresetsPort = {
      names: () => ["careful", "standard", "open"],
      active: () => active,
      requiresConfirmation: (name) => name === "open",
      apply: async (name) => {
        applied.push(name);
      },
    };
    return { port, applied };
  }

  it("starts on the active preset and reserves a row when the active one is custom", () => {
    const standard = new PresetOverlay(portWith("standard").port, {
      dismiss: () => {},
      notice: () => {},
      confirm: () => {},
    });
    expect(standard.index).toBe(1);
    expect(standard.rowCount()).toBe(3);
    const custom = new PresetOverlay(portWith("custom").port, {
      dismiss: () => {},
      notice: () => {},
      confirm: () => {},
    });
    expect(custom.index).toBe(0);
    expect(custom.rowCount()).toBe(4);
  });

  it("hands a loosening choice to a confirmation instead of applying it", () => {
    const { port, applied } = portWith("standard");
    const log: string[] = [];
    const overlay = new PresetOverlay(port, {
      dismiss: () => log.push("dismiss"),
      notice: (text) => log.push(text),
      confirm: (confirmation) => log.push(`confirm ${confirmation.name}`),
    });
    overlay.click(2);
    expect(log).toEqual(["confirm open"]);
    expect(applied).toEqual([]);
  });
});

describe("HelpOverlay", () => {
  const short: Screen = { width: 120, height: 30 };

  function help(closed: string[] = [], at: Screen = short): HelpOverlay {
    const keymap = new Keymap({ leader: "ctrl+k", bindings: appBindings });
    return new HelpOverlay(keymap, { dismiss: () => closed.push("x"), screen: () => at });
  }

  it("closes on escape or f1 and on a click outside", () => {
    const closed: string[] = [];
    const overlay = help(closed);
    overlay.handleKey(parseChord("escape"));
    overlay.handleKey(parseChord("f1"));
    overlay.handleKey(parseChord("a"));
    overlay.handleMouse({ type: "down", x: 0, y: 0, button: 0 }, screen);
    expect(closed).toEqual(["x", "x", "x"]);
  });

  it("shows every action with nothing hidden when the screen has room", () => {
    const overlay = help([], screen);
    const page = overlay.page(screen);
    expect(page.actions.length).toBe(overlay.rowCount());
    expect(page).toMatchObject({ above: 0, below: 0 });
    overlay.handleKey(parseChord("down"));
    expect(overlay.page(screen).above).toBe(0);
  });

  it("pages a long list on a short screen and clamps at both ends", () => {
    const overlay = help();
    const total = overlay.rowCount();
    const room = panelRowRoom(overlay.frame(short));
    expect(room).toBeLessThan(total);
    expect(overlay.page(short)).toMatchObject({ above: 0, below: total - room });
    expect(overlay.page(short).actions).toEqual(overlay.page(short).actions.slice(0, room));

    overlay.handleKey(parseChord("up"));
    expect(overlay.page(short).above).toBe(0);
    overlay.handleKey(parseChord("down"));
    expect(overlay.page(short)).toMatchObject({ above: 1, below: total - room - 1 });
    overlay.handleKey(parseChord("pagedown"));
    expect(overlay.page(short)).toMatchObject({ above: total - room, below: 0 });
    expect(overlay.page(short).actions.length).toBe(room);
    overlay.handleKey(parseChord("pageup"));
    expect(overlay.page(short)).toMatchObject({ above: 0, below: total - room });
  });

  it("scrolls with the wheel and still dismisses on a click outside", () => {
    const closed: string[] = [];
    const overlay = help(closed);
    overlay.handleMouse(
      { type: "scroll", x: 40, y: 10, scroll: { direction: "down", delta: 3 } },
      short,
    );
    expect(overlay.page(short).above).toBe(3);
    overlay.handleMouse(
      { type: "scroll", x: 40, y: 10, scroll: { direction: "up", delta: 9 } },
      short,
    );
    expect(overlay.page(short).above).toBe(0);
    expect(closed).toEqual([]);
    overlay.handleMouse({ type: "down", x: 0, y: 0, button: 0 }, short);
    expect(closed).toEqual(["x"]);
  });
});
