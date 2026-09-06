import { contains, type Rect, type Screen } from "./geometry.ts";
import type { Chord } from "./keys.ts";
import type { DockSide, DropTarget, Layout, SplitHandle } from "./layout.ts";
import type { Pane } from "./pane.ts";
import { type PointerEvent, type PointerScroll, wheelSteps } from "./pointer.ts";

export interface PointerSurface {
  readonly layout: Layout;
  screen(): Screen;
  paneAt(id: string): Pane | undefined;
  changed(): void;
  drawnRect?(rect: Rect, screen: Screen): Rect;
}

interface PaneDrag {
  id: string;
  lifted: boolean;
  target: DropTarget | undefined;
}

export class PanePointer {
  private dockResize: DockSide | undefined;
  private splitResize: SplitHandle | undefined;
  private paneDrag: PaneDrag | undefined;

  constructor(private readonly surface: PointerSurface) {}

  route(event: PointerEvent): boolean {
    if (this.routeDockResize(event)) return true;
    if (this.routeSplitResize(event)) return true;
    if (this.routePaneDrag(event)) return true;
    const hit = this.paneUnder(event.x, event.y);
    if (hit === undefined) return false;
    if (event.type === "down") {
      this.surface.layout.focus(hit.id);
      this.surface.changed();
      if (event.y === hit.rect.y) this.paneDrag = { id: hit.id, lifted: false, target: undefined };
    }
    const pane = this.surface.paneAt(hit.id);
    const local = { x: event.x - hit.rect.x, y: event.y - hit.rect.y };
    if (pane?.handleMouse?.(local, event) === true) return true;
    if (event.type === "scroll" && event.scroll !== undefined) {
      scrollByKeys(pane, event.scroll);
      return true;
    }
    return event.type === "down";
  }

  dragPreview(): Rect | undefined {
    const drag = this.paneDrag;
    if (drag?.lifted !== true) return undefined;
    return drag.target?.rect ?? this.surface.layout.rects(this.surface.screen()).get(drag.id);
  }

  draggingPane(): string | undefined {
    return this.paneDrag?.lifted === true ? this.paneDrag.id : undefined;
  }

  cancelDrag(): boolean {
    if (this.paneDrag?.lifted !== true) return false;
    this.paneDrag = undefined;
    return true;
  }

  private routePaneDrag(event: PointerEvent): boolean {
    const drag = this.paneDrag;
    if (drag === undefined) return false;
    const { layout } = this.surface;
    if (event.type === "drag") {
      drag.lifted = true;
      drag.target = layout.dropTargetAt(drag.id, event.x, event.y, this.surface.screen());
      return true;
    }
    if (event.type === "up" || event.type === "drag-end") {
      this.paneDrag = undefined;
      if (!drag.lifted) return false;
      if (drag.target !== undefined) {
        layout.applyDrop(drag.id, drag.target, this.surface.screen());
        this.surface.changed();
      }
      return true;
    }
    if (event.type === "down") this.paneDrag = undefined;
    return false;
  }

  private routeDockResize(event: PointerEvent): boolean {
    const { layout } = this.surface;
    if (this.dockResize !== undefined) {
      if (event.type === "drag") {
        layout.dragDockEdge(this.dockResize, event.x, this.surface.screen());
        this.surface.changed();
        return true;
      }
      if (event.type === "up" || event.type === "drag-end") {
        this.dockResize = undefined;
        return true;
      }
      this.dockResize = undefined;
    }
    if (event.type !== "down") return false;
    const side = layout.dockHandleAt(event.x, this.surface.screen());
    if (side === undefined) return false;
    this.dockResize = side;
    return true;
  }

  private routeSplitResize(event: PointerEvent): boolean {
    const { layout } = this.surface;
    if (this.splitResize !== undefined) {
      if (event.type === "drag") {
        layout.dragSplitHandle(this.splitResize, event.x, event.y, this.surface.screen());
        this.surface.changed();
        return true;
      }
      if (event.type === "up" || event.type === "drag-end") {
        this.splitResize = undefined;
        return true;
      }
      this.splitResize = undefined;
    }
    if (event.type !== "down") return false;
    const handle = layout.splitHandleAt(event.x, event.y, this.surface.screen());
    if (handle === undefined) return false;
    this.splitResize = handle;
    return true;
  }

  private paneUnder(x: number, y: number): { id: string; rect: Rect } | undefined {
    const screen = this.surface.screen();
    for (const [id, laidOut] of this.surface.layout.rects(screen)) {
      const rect = this.surface.drawnRect?.(laidOut, screen) ?? laidOut;
      if (contains(rect, x, y)) return { id, rect };
    }
    return undefined;
  }
}

function scrollByKeys(pane: Pane | undefined, scroll: PointerScroll): void {
  if (pane?.handleKey === undefined) return;
  const chord: Chord = { name: scroll.direction, ctrl: false, shift: false, meta: false };
  const steps = wheelSteps(scroll.delta);
  for (let step = 0; step < steps; step += 1) pane.handleKey(chord, undefined);
}
