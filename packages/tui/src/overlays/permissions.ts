import type { Screen } from "../geometry.ts";
import { type Chord, parseChord } from "../keys.ts";
import type { PermissionsModel } from "../permissions-model.ts";
import { type OverlayFrame, panelFrame, RowOverlay } from "./overlay.ts";

export interface PermissionsSeams {
  dismiss(): void;
}

export class PermissionsOverlay extends RowOverlay {
  readonly kind = "permissions" as const;

  constructor(
    readonly model: PermissionsModel,
    private readonly seams: PermissionsSeams,
  ) {
    super();
  }

  frame(screen: Screen): OverlayFrame {
    return panelFrame(screen, this.rowCount(), permissionsPanelWidth);
  }

  rowCount(): number {
    return this.model.rowCount();
  }

  handleKey(chord: Chord): void {
    if (this.model.handleKey(chord) === "close") this.seams.dismiss();
  }

  click(): void {}

  outside(): void {
    this.handleKey(escapeChord);
  }
}

const escapeChord = parseChord("escape");

const permissionsPanelWidth = 96;
