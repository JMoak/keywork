import type { BotCreateModel } from "../bot-create-model.ts";
import type { Screen } from "../geometry.ts";
import { type Chord, parseChord } from "../keys.ts";
import { type OverlayFrame, panelFrame, RowOverlay } from "./overlay.ts";

export interface BotCreateSeams {
  dismiss(): void;
}

export class BotCreateOverlay extends RowOverlay {
  readonly kind = "bot-new" as const;

  constructor(
    readonly model: BotCreateModel,
    private readonly seams: BotCreateSeams,
  ) {
    super();
  }

  frame(screen: Screen): OverlayFrame {
    return panelFrame(screen, this.rowCount(), botCreatePanelWidth);
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
    this.model.selectRow(row);
  }

  outside(): void {
    this.handleKey(escapeChord, undefined);
  }
}

const escapeChord = parseChord("escape");

const botCreatePanelWidth = 72;
