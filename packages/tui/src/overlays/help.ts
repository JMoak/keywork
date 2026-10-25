import { bindingHelp } from "../app-actions.ts";
import { clampScroll } from "../clamp.ts";
import { contains, type Screen } from "../geometry.ts";
import type { Keymap } from "../keymap.ts";
import type { Chord } from "../keys.ts";
import type { PointerEvent } from "../pointer.ts";
import { width } from "../width.ts";
import { type OverlayFrame, panelFrame, panelRowRoom, RowOverlay } from "./overlay.ts";

export interface HelpSeams {
  dismiss(): void;
  screen(): Screen;
}

export interface HelpRow {
  readonly keys: string;
  readonly help: string;
}

export interface HelpPage {
  rows: readonly HelpRow[];
  above: number;
  below: number;
  filter: string;
  keysColumn: number;
}

export const promptKeys: readonly HelpRow[] = [
  { keys: "enter", help: "send · queues behind a running turn" },
  { keys: "alt+enter", help: "steer · interrupts the turn and sends now · the queue stays" },
  {
    keys: "ctrl+enter",
    help: "send now · interrupts the turn and sets the queue aside · up brings those back",
  },
  { keys: "shift+enter", help: "newline in the prompt" },
  { keys: "esc", help: "interrupt the running turn" },
  { keys: "!cmd", help: "run a shell command through the bash gate · shown as your tool call" },
  {
    keys: "alt+up",
    help: "edit queued prompts · ↑↓ pick · shift+↑↓ move · backspace cancels · enter sends now",
  },
  { keys: "tab", help: "expand a [pasted #n] placeholder under the cursor" },
  { keys: "ctrl+c", help: "clear the prompt · up on an empty prompt brings it back" },
];

export const keysColumnLimit = 18;

export class HelpOverlay extends RowOverlay {
  readonly kind = "help" as const;
  private top = 0;
  private filter = "";

  constructor(
    private readonly keymap: Keymap,
    private readonly seams: HelpSeams,
  ) {
    super();
  }

  frame(screen: Screen): OverlayFrame {
    const frame = panelFrame(screen, this.allRows().length + filterRows, keysPanelWidth);
    return { ...frame, firstRowY: frame.firstRowY + filterRows };
  }

  rowCount(): number {
    return this.rows().length;
  }

  rows(): HelpRow[] {
    const rows = this.allRows();
    const needle = this.filter.toLowerCase();
    return needle === "" ? rows : rows.filter((row) => rowMatches(row, needle));
  }

  page(screen: Screen): HelpPage {
    const rows = this.rows();
    const room = this.roomIn(this.frame(screen));
    const top = clampScroll(this.top, rows.length, room);
    return {
      rows: rows.slice(top, top + room),
      above: top,
      below: Math.max(0, rows.length - top - room),
      filter: this.filter,
      keysColumn: keysColumnOf(this.allRows()),
    };
  }

  handleKey(chord: Chord, sequence?: string): void {
    if (chord.name === "escape" && this.filter !== "") {
      this.refilter("");
      return;
    }
    if (chord.name === "escape" || chord.name === "f1") {
      this.seams.dismiss();
      return;
    }
    if (chord.name === "backspace") {
      this.refilter(this.filter.slice(0, -1));
      return;
    }
    const step = scrollStep(chord, this.pageRows());
    if (step !== undefined) {
      this.scrollBy(step);
      return;
    }
    if (isTyped(chord, sequence)) this.refilter(this.filter + sequence);
  }

  override handlePaste(line: string): void {
    this.refilter(this.filter + line);
  }

  override handleMouse(event: PointerEvent, screen: Screen): void {
    if (event.type === "scroll" && event.scroll !== undefined) {
      const { direction, delta } = event.scroll;
      this.scrollBy(direction === "down" ? delta : -delta);
      return;
    }
    const frame = this.frame(screen);
    if (event.type === "down" && !contains(frame, event.x, event.y)) this.outside();
  }

  click(): void {}

  outside(): void {
    this.seams.dismiss();
  }

  private allRows(): HelpRow[] {
    const bound = this.keymap.actions().map((action) => ({
      action,
      keys: this.keymap.describe(action) ?? "",
      help: bindingHelp[action] ?? action,
    }));
    return [...withOrdinalsFolded(bound), ...promptKeys];
  }

  private refilter(filter: string): void {
    this.filter = filter;
    this.top = 0;
  }

  private scrollBy(rows: number): void {
    this.top = clampScroll(this.top + rows, this.rowCount(), this.pageRows());
  }

  private pageRows(): number {
    return this.roomIn(this.frame(this.seams.screen()));
  }

  private roomIn(frame: OverlayFrame): number {
    return Math.max(1, panelRowRoom(frame) - filterRows);
  }
}

interface BoundRow extends HelpRow {
  readonly action: string;
}

const filterRows = 1;
const keysPanelWidth = 72;
const ordinalAction = /^focus\.pane([1-9])$/;
const ordinalFocusRow: HelpRow = {
  keys: "alt+1..9",
  help: "focus a pane by its place · left dock, then main, then right dock",
};

function withOrdinalsFolded(rows: readonly BoundRow[]): HelpRow[] {
  const ordinals = rows.filter((row) => ordinalAction.test(row.action));
  const folds = ordinals.length === 9 && ordinals.every(boundToItsDigit);
  if (!folds) return [...rows];
  const first = rows.indexOf(ordinals[0] as BoundRow);
  const rest = rows.filter((row) => !ordinals.includes(row));
  return [...rest.slice(0, first), ordinalFocusRow, ...rest.slice(first)];
}

function boundToItsDigit(row: BoundRow): boolean {
  const digit = ordinalAction.exec(row.action)?.[1];
  return row.keys === `alt+${digit}`;
}

function keysColumnOf(rows: readonly HelpRow[]): number {
  return Math.min(keysColumnLimit, Math.max(0, ...rows.map((row) => width(row.keys))));
}

function rowMatches(row: HelpRow, needle: string): boolean {
  return row.keys.toLowerCase().includes(needle) || row.help.toLowerCase().includes(needle);
}

function isTyped(chord: Chord, sequence: string | undefined): sequence is string {
  return sequence !== undefined && sequence.length === 1 && !chord.ctrl && !chord.meta;
}

function scrollStep(chord: Chord, pageRows: number): number | undefined {
  switch (chord.name) {
    case "up":
      return -1;
    case "down":
      return 1;
    case "pageup":
      return -pageRows;
    case "pagedown":
      return pageRows;
    default:
      return undefined;
  }
}
