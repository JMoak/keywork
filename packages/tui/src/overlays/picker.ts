import type { FilterPage, FilterPicker } from "../filter-picker.ts";
import type { Screen } from "../geometry.ts";
import type { Chord } from "../keys.ts";
import type { PointerEvent } from "../pointer.ts";
import {
  type OverlayFrame,
  paletteFrame,
  paletteRowRoom,
  RowOverlay,
  routeRows,
} from "./overlay.ts";

export type PickerKind = "model" | "arc" | "workspace" | "bot";

export interface PickerSeams<Row> {
  dismiss(overlay: RowOverlay): void;
  choose(row: Row): void;
}

export function pickerPage<Row>(
  picker: FilterPicker<Row>,
  frame: Pick<OverlayFrame, "height">,
): FilterPage<Row> {
  const room = paletteRowRoom(frame);
  const overflows = picker.rows().length > room;
  return picker.page(overflows ? Math.max(1, room - hiddenRowsHintLines) : room);
}

export class PickerOverlay<Kind extends PickerKind, Row> extends RowOverlay {
  constructor(
    readonly kind: Kind,
    readonly picker: FilterPicker<Row>,
    private readonly seams: PickerSeams<Row>,
  ) {
    super();
  }

  frame(screen: Screen): OverlayFrame {
    return paletteFrame(screen, this.rowCount());
  }

  rowCount(): number {
    return this.picker.rows().length;
  }

  handleKey(chord: Chord, sequence: string | undefined): void {
    const outcome = this.picker.handleKey(chord, sequence);
    if (outcome === "choose") this.chooseSelected();
    else if (outcome === "close") this.seams.dismiss(this);
  }

  override handlePaste(line: string): void {
    this.picker.paste(line);
  }

  override handleMouse(event: PointerEvent, screen: Screen): void {
    const frame = this.frame(screen);
    const page = pickerPage(this.picker, frame);
    routeRows(event, frame, page.rows.length, {
      hover: (offset) => this.hover(page.above + offset),
      click: (offset) => this.click(page.above + offset),
      outside: () => this.outside(),
    });
  }

  override hover(row: number): void {
    this.picker.select(row);
  }

  click(row: number): void {
    this.picker.select(row);
    this.chooseSelected();
  }

  outside(): void {
    this.seams.dismiss(this);
  }

  private chooseSelected(): void {
    const chosen = this.picker.selected();
    if (chosen === undefined) return;
    this.seams.dismiss(this);
    this.seams.choose(chosen);
  }
}

const hiddenRowsHintLines = 1;
