import { Text } from "@opentui/core";
import { fuzzyScore } from "./commands.ts";
import type { Chord } from "./keys.ts";
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
  private query = "";
  private index = 0;
  private openState = false;

  constructor(
    private readonly notify: () => void,
    private readonly source: () => TrayCommand[],
  ) {}

  get open(): boolean {
    return this.openState;
  }

  promptText(): string {
    return this.query;
  }

  opensOn(chord: Chord): boolean {
    return !chord.ctrl && !chord.meta && (chord.name === "/" || chord.name === ":");
  }

  openTray(): void {
    this.openState = true;
    this.query = "";
    this.index = 0;
    this.notify();
  }

  close(): void {
    this.openState = false;
    this.notify();
  }

  matches(): TrayCommand[] {
    const commands = this.source();
    const query = this.query.trim().toLowerCase();
    if (query === "") return commands;
    return commands
      .map((command) => ({ command, score: fuzzyScore(query, command.name) }))
      .filter(
        (entry): entry is { command: TrayCommand; score: number } => entry.score !== undefined,
      )
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.command);
  }

  selected(): number {
    return Math.max(0, Math.min(this.index, this.matches().length - 1));
  }

  handleKey(chord: Chord, sequence: string | undefined): boolean {
    if (!this.openState) return false;
    switch (chord.name) {
      case "escape":
        this.close();
        return true;
      case "up":
        return this.step(-1);
      case "down":
        return this.step(1);
      case "tab":
        return this.step(chord.shift ? -1 : 1);
      case "enter":
      case "return":
        this.runSelected();
        return true;
      case "backspace":
        return this.retype(this.query.slice(0, -1));
      default:
        if (sequence !== undefined && sequence.length === 1 && !chord.ctrl && !chord.meta) {
          return this.retype(this.query + sequence);
        }
        return true;
    }
  }

  private step(delta: number): boolean {
    const count = this.matches().length;
    if (count > 0) this.index = (this.selected() + delta + count) % count;
    this.notify();
    return true;
  }

  private retype(query: string): boolean {
    this.query = query;
    this.index = 0;
    this.notify();
    return true;
  }

  private runSelected(): void {
    const chosen = this.matches()[this.selected()];
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
