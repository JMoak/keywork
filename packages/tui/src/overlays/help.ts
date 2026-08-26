import { clampScroll } from "../clamp.ts";
import type { Screen } from "../geometry.ts";
import type { Keymap } from "../keymap.ts";
import type { Chord } from "../keys.ts";
import type { PointerEvent } from "../pointer.ts";
import { helpFrame, type OverlayFrame, panelRowRoom, RowOverlay, routeRows } from "./overlay.ts";

export interface HelpSeams {
  dismiss(): void;
  screen(): Screen;
}

export interface HelpPage {
  actions: readonly string[];
  above: number;
  below: number;
}

export class HelpOverlay extends RowOverlay {
  readonly kind = "help" as const;
  private top = 0;

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

  page(screen: Screen): HelpPage {
    const actions = this.keymap.actions();
    const room = panelRowRoom(this.frame(screen));
    const top = clampScroll(this.top, actions.length, room);
    return {
      actions: actions.slice(top, top + room),
      above: top,
      below: Math.max(0, actions.length - top - room),
    };
  }

  handleKey(chord: Chord): void {
    if (chord.name === "escape" || chord.name === "f1") {
      this.seams.dismiss();
      return;
    }
    const step = scrollStep(chord, this.pageRows());
    if (step !== undefined) this.scrollBy(step);
  }

  override handleMouse(event: PointerEvent, screen: Screen): void {
    if (event.type === "scroll" && event.scroll !== undefined) {
      const { direction, delta } = event.scroll;
      this.scrollBy(direction === "down" ? delta : -delta);
      return;
    }
    routeRows(event, this.frame(screen), this.page(screen).actions.length, this);
  }

  click(): void {}

  outside(): void {
    this.seams.dismiss();
  }

  private scrollBy(rows: number): void {
    this.top = clampScroll(this.top + rows, this.rowCount(), this.pageRows());
  }

  private pageRows(): number {
    return panelRowRoom(this.frame(this.seams.screen()));
  }
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
