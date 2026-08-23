import { toError } from "@keywork/shared";
import type { Screen } from "../geometry.ts";
import type { Chord } from "../keys.ts";
import {
  setupReceiptNotice,
  type WorkspaceReadiness,
  type WorkspaceSetupPort,
} from "../workspace-setup.ts";
import { helpFrame, isEnter, type OverlayFrame, RowOverlay } from "./overlay.ts";

export interface SetupSeams {
  dismiss(): void;
  notice(text: string): void;
  shutdown(): void;
}

export class SetupConfirmOverlay extends RowOverlay {
  readonly kind = "setup" as const;

  constructor(
    private readonly port: WorkspaceSetupPort,
    readonly readiness: WorkspaceReadiness,
    private readonly seams: SetupSeams,
  ) {
    super();
  }

  frame(screen: Screen): OverlayFrame {
    return helpFrame(screen, this.rowCount());
  }

  rowCount(): number {
    return 2;
  }

  handleKey(chord: Chord): void {
    if (chord.name === "y" || isEnter(chord)) this.confirm();
    else if (chord.name === "n" || chord.name === "escape") this.seams.dismiss();
  }

  click(): void {}

  outside(): void {
    this.seams.dismiss();
  }

  private confirm(): void {
    this.seams.dismiss();
    this.port
      .setUp()
      .then((receipt) => {
        this.seams.notice(setupReceiptNotice(receipt));
        if (receipt.reopens) this.seams.shutdown();
      })
      .catch((cause: unknown) => this.seams.notice(toError(cause).message));
  }
}
