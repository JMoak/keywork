import type { Screen } from "../geometry.ts";
import type { Keymap } from "../keymap.ts";
import type { Chord } from "../keys.ts";
import { helpFrame, type OverlayFrame, RowOverlay } from "./overlay.ts";

export interface HelpSeams {
  dismiss(): void;
}

export class HelpOverlay extends RowOverlay {
  readonly kind = "help" as const;

  constructor(
    private readonly keymap: Keymap,
    private readonly seams: HelpSeams,
  ) {
    super();
  }

  frame(screen: Screen): OverlayFrame {
    return helpFrame(screen, this.rowCount());
  }

  rowCount(): number {
    return this.keymap.actions().length;
  }

  handleKey(chord: Chord): void {
    if (chord.name === "escape" || chord.name === "f1") this.seams.dismiss();
  }

  click(): void {}

  outside(): void {
    this.seams.dismiss();
  }
}
