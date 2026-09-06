import type { FilterPicker } from "../filter-picker.ts";
import type { Screen } from "../geometry.ts";
import type { Chord } from "../keys.ts";
import { type OverlayFrame, paletteFrame, RowOverlay } from "./overlay.ts";

export type PickerKind = "model" | "arc" | "workspace" | "bot";

export interface PickerSeams<Row> {
  dismiss(): void;
  choose(row: Row): void;
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
    else if (outcome === "close") this.seams.dismiss();
  }

  override handlePaste(line: string): void {
    this.picker.paste(line);
  }

  override hover(row: number): void {
    this.picker.select(row);
  }

  click(row: number): void {
    this.picker.select(row);
    this.chooseSelected();
  }

  outside(): void {
    this.seams.dismiss();
  }

  private chooseSelected(): void {
    const chosen = this.picker.selected();
    if (chosen === undefined) return;
    this.seams.dismiss();
    this.seams.choose(chosen);
  }
}
