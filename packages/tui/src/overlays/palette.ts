import type { CommandRegistry, CommandSpec } from "../commands.ts";
import type { Screen } from "../geometry.ts";
import type { Chord } from "../keys.ts";
import { isEnter, type OverlayFrame, paletteFrame, RowOverlay, steppedIndex } from "./overlay.ts";

export type PaletteMode = "go" | "commands";

export const paletteRowLimit = 10;

export function paletteModeOf(query: string): PaletteMode {
  return query.startsWith(">") ? "commands" : "go";
}

export interface PaletteSeams {
  dismiss(): void;
}

export class PaletteOverlay extends RowOverlay {
  readonly kind = "palette" as const;
  query = "";
  index = 0;
  entries: CommandSpec[] = [];

  constructor(
    private readonly registry: CommandRegistry,
    query: string,
    private readonly seams: PaletteSeams,
  ) {
    super();
    this.retype(query);
  }

  get mode(): PaletteMode {
    return paletteModeOf(this.query);
  }

  frame(screen: Screen): OverlayFrame {
    return paletteFrame(screen, this.entries.length);
  }

  rowCount(): number {
    return this.entries.length;
  }

  handleKey(chord: Chord, sequence: string | undefined): void {
    if (chord.name === "escape") {
      this.seams.dismiss();
      return;
    }
    const stepped = steppedIndex(this.index, chord, this.entries.length);
    if (stepped !== undefined) {
      this.index = stepped;
      return;
    }
    if (isEnter(chord)) {
      this.run(this.index);
      return;
    }
    if (chord.name === "backspace") {
      this.retype(this.query.slice(0, -1));
      return;
    }
    if (sequence !== undefined && sequence.length === 1 && !chord.ctrl && !chord.meta) {
      this.retype(this.query + sequence);
    }
  }

  override handlePaste(line: string): void {
    this.retype(this.query + line);
  }

  override hover(row: number): void {
    this.index = row;
  }

  click(row: number): void {
    this.run(row);
  }

  outside(): void {
    this.seams.dismiss();
  }

  private run(row: number): void {
    const chosen = this.entries[row];
    this.seams.dismiss();
    chosen?.run();
  }

  private retype(query: string): void {
    const commandMode = paletteModeOf(query) === "commands";
    this.query = query;
    this.index = 0;
    this.entries = this.registry
      .search(commandMode ? query.slice(1) : query)
      .filter((command) => command.needsArgs !== true)
      .filter((command) => (command.jump === true) !== commandMode)
      .slice(0, paletteRowLimit);
  }
}
