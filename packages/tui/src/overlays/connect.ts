import type { ConnectModel } from "../connect-model.ts";
import type { Screen } from "../geometry.ts";
import { type Chord, parseChord } from "../keys.ts";
import { type OverlayFrame, panelFrame, RowOverlay } from "./overlay.ts";

export interface ConnectSeams {
  dismiss(): void;
}

export class ConnectOverlay extends RowOverlay {
  readonly kind = "connect" as const;

  constructor(
    readonly model: ConnectModel,
    private readonly seams: ConnectSeams,
  ) {
    super();
  }

  frame(screen: Screen): OverlayFrame {
    return panelFrame(screen, this.rowCount(), connectPanelWidth);
  }

  rowCount(): number {
    return this.model.rowCount();
  }

  handleKey(chord: Chord, sequence: string | undefined): void {
    if (this.model.handleKey(chord, sequence) === "close") this.seams.dismiss();
  }

  override handlePaste(line: string): void {
    this.model.paste(line);
  }

  click(row: number): void {
    if (this.model.clickRow(row) === "close") this.seams.dismiss();
  }

  outside(): void {
    this.handleKey(escapeChord, undefined);
  }
}

const escapeChord = parseChord("escape");

const connectPanelWidth = 96;
