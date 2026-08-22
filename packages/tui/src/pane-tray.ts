import { Text } from "@opentui/core";
import { FilterPicker } from "./filter-picker.ts";
import type { Chord } from "./keys.ts";
import { rankByFuzzy } from "./picker-keys.ts";
import type { Theme } from "./theme.ts";
import { clipLine, type TrayChild, type TrayItem, trayBox, trayRows } from "./tray.ts";

export interface TrayCommand extends TrayItem {
  run(): void;
}

export interface PaneTrayView {
  children: TrayChild[];
  rows: number;
}

export class PaneTrayModel {
  private readonly picker: FilterPicker<TrayCommand>;
  private openState = false;

  constructor(
    private readonly notify: () => void,
    source: () => TrayCommand[],
  ) {
    this.picker = new FilterPicker((needle) =>
      rankByFuzzy(source(), needle, (command) => command.name),
    );
  }

  get open(): boolean {
    return this.openState;
  }

  promptText(): string {
    return this.picker.query;
  }

  opensOn(chord: Chord): boolean {
    return !chord.ctrl && !chord.meta && (chord.name === "/" || chord.name === ":");
  }

  openTray(): void {
    this.openState = true;
    this.picker.retype("");
    this.notify();
  }

  close(): void {
    this.openState = false;
    this.notify();
  }

  matches(): readonly TrayCommand[] {
    return this.picker.rows();
  }

  selected(): number {
    return this.picker.cursor();
  }

  handleKey(chord: Chord, sequence: string | undefined): boolean {
    if (!this.openState) return false;
    switch (this.picker.handleKey(chord, sequence)) {
      case "close":
        this.close();
        return true;
      case "choose":
        this.runSelected();
        return true;
      case "stay":
        this.notify();
        return true;
    }
  }

  private runSelected(): void {
    const chosen = this.picker.selected();
    this.close();
    chosen?.run();
  }
}

export function paneTrayView(tray: PaneTrayModel, width: number, theme: Theme): PaneTrayView {
  const matches = tray.matches();
  const body =
    matches.length === 0
      ? [Text({ content: clipLine("  no matching commands", width - 2), fg: theme.textDim })]
      : trayRows(matches, tray.selected(), width - 2, theme);
  const prompt = Text({ content: clipLine(`: ${tray.promptText()}▌`, width), fg: theme.accent });
  return {
    children: [trayBox(theme, body), prompt],
    rows: Math.max(1, matches.length) + trayChromeRows + promptRows,
  };
}

const trayChromeRows = 2;
const promptRows = 1;
