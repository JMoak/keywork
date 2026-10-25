import type { CommandRegistry, CommandSpec } from "../commands.ts";
import type { Screen } from "../geometry.ts";
import type { Chord } from "../keys.ts";
import { isEnter, type OverlayFrame, paletteFrame, RowOverlay, steppedIndex } from "./overlay.ts";

export type PaletteMode = "go" | "commands";

export const paletteRowLimit = 10;

export function paletteModeOf(query: string): PaletteMode {
  return commandPrefixes.some((prefix) => query.startsWith(prefix)) ? "commands" : "go";
}

const commandPrefixes = ["/", ">"] as const;

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
    if (chord.name === "tab") {
      this.complete(this.index);
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
    if (chosen?.needsArgs === true) {
      this.complete(row);
      return;
    }
    this.seams.dismiss();
    chosen?.run();
  }

  private complete(row: number): void {
    const chosen = this.entries[row];
    if (chosen === undefined || this.mode !== "commands" || this.argued()) return;
    this.retype(`${this.query.charAt(0)}${chosen.name}${chosen.needsArgs === true ? " " : ""}`);
  }

  private argued(): boolean {
    return invocationOf(this.query.slice(1))[1] !== undefined;
  }

  private retype(query: string): void {
    this.query = query;
    this.index = 0;
    this.entries = paletteMatches(this.registry, query);
  }
}

function paletteMatches(registry: CommandRegistry, query: string): CommandSpec[] {
  if (paletteModeOf(query) === "go") {
    return registry
      .search(query)
      .filter((command) => command.jump === true)
      .slice(0, paletteRowLimit);
  }
  const [verb, argument] = invocationOf(query.slice(1));
  if (argument === undefined) {
    return registry
      .search(verb)
      .filter((command) => command.jump !== true)
      .slice(0, paletteRowLimit);
  }
  const named = registry.named(verb);
  return named === undefined || named.jump === true ? [] : [withArgument(named, argument)];
}

function invocationOf(typed: string): [string, string | undefined] {
  const trimmed = typed.trimStart();
  const space = trimmed.search(/\s/);
  return space === -1
    ? [trimmed, undefined]
    : [trimmed.slice(0, space), trimmed.slice(space + 1).trim()];
}

function withArgument({ needsArgs: _, ...command }: CommandSpec, argument: string): CommandSpec {
  return {
    ...command,
    label: argument === "" ? `${command.name} …` : `${command.name} ${argument}`,
    run: () => command.run(argument === "" ? undefined : argument),
  };
}
