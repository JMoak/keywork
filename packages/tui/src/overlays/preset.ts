import { type ActivePreset, type PresetName, toError } from "@keywork/shared";
import type { Screen } from "../geometry.ts";
import type { Chord } from "../keys.ts";
import { helpFrame, isEnter, type OverlayFrame, RowOverlay, steppedIndex } from "./overlay.ts";

export interface PresetsPort {
  names(): readonly PresetName[];
  active(): ActivePreset;
  requiresConfirmation(name: PresetName): boolean;
  apply(name: PresetName): Promise<void>;
}

export interface PresetPicker {
  names: readonly PresetName[];
  active: ActivePreset;
  index: number;
}

export interface PresetConfirmation {
  from: ActivePreset;
  to: PresetName;
}

export interface PresetSeams {
  dismiss(): void;
  notice(text: string): void;
  confirm(overlay: PresetConfirmOverlay): void;
}

export class PresetOverlay extends RowOverlay {
  readonly kind = "preset" as const;
  readonly names: readonly PresetName[];
  index: number;

  constructor(
    private readonly port: PresetsPort,
    private readonly seams: PresetSeams,
  ) {
    super();
    this.names = port.names();
    this.index = Math.max(0, this.activeRow());
  }

  picker(): PresetPicker {
    return { names: this.names, active: this.port.active(), index: this.index };
  }

  frame(screen: Screen): OverlayFrame {
    return helpFrame(screen, this.rowCount());
  }

  rowCount(): number {
    return this.names.length + (this.activeRow() === -1 ? 1 : 0);
  }

  handleKey(chord: Chord): void {
    if (chord.name === "escape") {
      this.seams.dismiss();
      return;
    }
    const stepped = steppedIndex(this.index, chord, this.names.length);
    if (stepped !== undefined) {
      this.index = stepped;
      return;
    }
    if (isEnter(chord)) this.chooseRow(this.index);
  }

  override hover(row: number): void {
    if (row < this.names.length) this.index = row;
  }

  click(row: number): void {
    this.chooseRow(row);
  }

  outside(): void {
    this.seams.dismiss();
  }

  private activeRow(): number {
    const names: readonly ActivePreset[] = this.names;
    return names.indexOf(this.port.active());
  }

  private chooseRow(row: number): void {
    const name = this.names[row];
    if (name === undefined) return;
    if (name === this.port.active()) {
      this.seams.dismiss();
      this.seams.notice(`already on ${name}`);
      return;
    }
    if (this.port.requiresConfirmation(name)) {
      this.seams.confirm(new PresetConfirmOverlay(this.port, name, this.seams));
      return;
    }
    applyPreset(this.port, name, this.seams);
  }
}

export class PresetConfirmOverlay extends RowOverlay {
  readonly kind = "preset-confirm" as const;

  constructor(
    private readonly port: PresetsPort,
    readonly name: PresetName,
    private readonly seams: Pick<PresetSeams, "dismiss" | "notice">,
  ) {
    super();
  }

  confirmation(): PresetConfirmation {
    return { from: this.port.active(), to: this.name };
  }

  frame(screen: Screen): OverlayFrame {
    return helpFrame(screen, this.rowCount());
  }

  rowCount(): number {
    return 2;
  }

  handleKey(chord: Chord): void {
    if (chord.name === "y" || isEnter(chord)) applyPreset(this.port, this.name, this.seams);
    else if (chord.name === "n" || chord.name === "escape") this.seams.dismiss();
  }

  click(): void {}

  outside(): void {
    this.seams.dismiss();
  }
}

function applyPreset(
  port: PresetsPort,
  name: PresetName,
  seams: Pick<PresetSeams, "dismiss" | "notice">,
): void {
  seams.dismiss();
  port
    .apply(name)
    .then(() => seams.notice(`permissions preset → ${name}`))
    .catch((cause: unknown) => seams.notice(toError(cause).message));
}
