import { CommandRegistry } from "./commands.ts";
import { Keymap } from "./keymap.ts";
import { type Chord, formatChord } from "./keys.ts";
import { type Direction, type DockSide, Layout, type Rect, type Screen } from "./layout.ts";
import type { Pane, PaneIntents } from "./pane.ts";
import type { PointerEvent, PointerScroll } from "./pointer.ts";

export const appBindings = {
  "pane.split": "leader s",
  "pane.close": "leader x",
  "pane.zoom": "leader z",
  "focus.left": ["leader h", "leader left"],
  "focus.down": ["leader j", "leader down"],
  "focus.up": ["leader k", "leader up"],
  "focus.right": ["leader l", "leader right"],
  "swap.left": "leader shift+h",
  "swap.down": "leader shift+j",
  "swap.up": "leader shift+k",
  "swap.right": "leader shift+l",
  "dock.left": "leader d",
  "dock.right": "leader shift+d",
  "dock.undock": "leader u",
  "dock.grow": "leader .",
  "dock.shrink": "leader ,",
  "pane.grow": "leader shift+.",
  "pane.shrink": "leader shift+,",
  "browser.summon": "leader f",
  "help.toggle": ["leader /", "f1"],
  "palette.toggle": ["ctrl+p", "leader p"],
  "app.quit": "ctrl+q",
} as const;

export const bindingHelp: Record<string, string> = {
  "pane.split": "new session pane",
  "pane.close": "close focused pane",
  "pane.zoom": "zoom pane (toggle)",
  "focus.left": "focus left",
  "focus.down": "focus down",
  "focus.up": "focus up",
  "focus.right": "focus right",
  "swap.left": "swap pane left",
  "swap.down": "swap pane down",
  "swap.up": "swap pane up",
  "swap.right": "swap pane right",
  "dock.left": "dock pane to the left edge",
  "dock.right": "dock pane to the right edge",
  "dock.undock": "return pane to the main area",
  "dock.grow": "widen the dock",
  "dock.shrink": "narrow the dock",
  "pane.grow": "grow the focused pane",
  "pane.shrink": "shrink the focused pane",
  "browser.summon": "file browser",
  "help.toggle": "this overlay",
  "palette.toggle": "command palette",
  "app.quit": "quit",
};

const focusDirections: Record<string, Direction> = {
  "focus.left": "left",
  "focus.down": "down",
  "focus.up": "up",
  "focus.right": "right",
};

const swapDirections: Record<string, Direction> = {
  "swap.left": "left",
  "swap.down": "down",
  "swap.up": "up",
  "swap.right": "right",
};

const stickyActions = new Set([
  ...Object.keys(focusDirections),
  ...Object.keys(swapDirections),
  "pane.split",
  "pane.close",
  "pane.zoom",
  "dock.left",
  "dock.right",
  "dock.undock",
  "dock.grow",
  "dock.shrink",
  "pane.grow",
  "pane.shrink",
]);

export interface AppCoreOptions {
  screen: () => Screen;
  createPane: (id: string, notify: () => void, commands: CommandRegistry) => Pane;
  createFilePane?: (id: string, path: string, notify: () => void) => Pane;
  createBrowserPane?: (id: string, root: string, notify: () => void, intents: PaneIntents) => Pane;
  isDirectory?: (path: string) => boolean;
  onExit: () => void;
}

export interface PaneSnapshot {
  id: string;
  title: string;
  focused: boolean;
  docked: boolean;
}

export interface OverlayFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const paletteRowLimit = 10;

export function paletteFrame(
  screen: Screen,
  rowCount: number,
): OverlayFrame & { firstRowY: number } {
  const width = Math.min(64, screen.width - 4);
  const x = Math.max(2, Math.floor((screen.width - width) / 2));
  const y = 2;
  return { x, y, width, height: Math.max(1, rowCount) + 5, firstRowY: y + 3 };
}

export function helpFrame(screen: Screen, rowCount: number): OverlayFrame {
  const width = Math.min(52, screen.width - 4);
  const height = rowCount + 5;
  return {
    x: Math.max(2, Math.floor((screen.width - width) / 2)),
    y: Math.max(1, Math.floor((screen.height - height) / 2)),
    width,
    height,
  };
}

export interface AppSnapshot {
  panes: PaneSnapshot[];
  focused: string | undefined;
  zoomed: string | undefined;
  dockSide: DockSide | undefined;
  overlay: "palette" | "help" | undefined;
  paletteQuery: string;
  leaderArmed: boolean;
  lastKey: string;
}

export class AppCore {
  readonly layout = new Layout();
  readonly keymap = new Keymap({ leader: "ctrl+k", bindings: appBindings });
  readonly registry = new CommandRegistry();
  readonly panes = new Map<string, Pane>();
  readonly intents: PaneIntents = {
    openFile: (path) => this.openFilePane(path),
    focusPane: (id) => this.layout.focus(id),
  };
  leaderArmed = false;
  helpVisible = false;
  paletteOpen = false;
  paletteQuery = "";
  paletteIndex = 0;
  lastKey = "";
  private nextSession = 1;
  private nextFile = 1;
  private nextBrowser = 1;
  private notify: () => void = () => {};

  constructor(private readonly options: AppCoreOptions) {
    this.registerCommands();
  }

  bindNotify(notify: () => void): void {
    this.notify = notify;
  }

  start(): void {
    this.openPane();
  }

  runCommand(name: string): boolean {
    return this.registry.run(name);
  }

  snapshot(): AppSnapshot {
    const focused = this.layout.focused();
    const dock = this.layout.dock();
    return {
      panes: this.layout.panes().map((id) => ({
        id,
        title: this.panes.get(id)?.title().trim() ?? id,
        focused: id === focused,
        docked: dock?.panes.includes(id) === true,
      })),
      focused,
      zoomed: this.layout.zoomed(),
      dockSide: dock?.side,
      overlay: this.paletteOpen ? "palette" : this.helpVisible ? "help" : undefined,
      paletteQuery: this.paletteQuery,
      leaderArmed: this.leaderArmed,
      lastKey: this.lastKey,
    };
  }

  handleKey(chord: Chord, sequence: string | undefined, nowMs: number): void {
    this.lastKey = formatChord(chord);
    if (chord.ctrl && chord.name === "q") {
      this.shutdown();
      return;
    }
    if (this.paletteOpen) {
      this.handlePaletteKey(chord, sequence);
      return;
    }
    if (this.helpVisible && chord.name === "escape") {
      this.helpVisible = false;
      return;
    }
    const result = this.keymap.press(chord, nowMs);
    this.leaderArmed = result.type === "leader-pending";
    if (result.type === "action") {
      this.apply(result.action);
      if (stickyActions.has(result.action)) {
        this.keymap.arm(nowMs);
        this.leaderArmed = true;
      }
      return;
    }
    if (result.type === "pass") {
      const id = this.layout.focused();
      if (id !== undefined) this.panes.get(id)?.handleKey?.(chord, sequence);
    }
  }

  handleMouse(event: PointerEvent, _nowMs: number): void {
    if (this.paletteOpen) {
      this.routePaletteMouse(event);
      return;
    }
    if (this.helpVisible) {
      this.routeHelpMouse(event);
      return;
    }
    this.routePaneMouse(event);
  }

  private apply(action: string): void {
    const focusDirection = focusDirections[action];
    const swapDirection = swapDirections[action];
    if (action === "pane.split") this.openPane();
    else if (action === "pane.close") this.closePane();
    else if (action === "pane.zoom") this.layout.zoomToggle();
    else if (action === "help.toggle") this.helpVisible = !this.helpVisible;
    else if (action === "palette.toggle") this.openPalette();
    else if (action === "dock.left") this.layout.dockFocused("left");
    else if (action === "dock.right") this.layout.dockFocused("right");
    else if (action === "dock.undock") this.layout.undockFocused(this.options.screen());
    else if (action === "dock.grow") this.layout.growDock(0.05);
    else if (action === "dock.shrink") this.layout.growDock(-0.05);
    else if (action === "pane.grow") this.layout.resizeFocused(0.05);
    else if (action === "pane.shrink") this.layout.resizeFocused(-0.05);
    else if (action === "browser.summon") this.summonBrowser();
    else if (focusDirection !== undefined)
      this.layout.moveFocus(focusDirection, this.options.screen());
    else if (swapDirection !== undefined) this.layout.swap(swapDirection, this.options.screen());
    else if (action === "app.quit") this.shutdown();
  }

  private openPane(): void {
    const id = `session-${this.nextSession}`;
    this.nextSession += 1;
    this.panes.set(
      id,
      this.options.createPane(id, () => this.notify(), this.registry),
    );
    this.layout.open(id, this.options.screen());
  }

  private openFilePane(path: string): void {
    const create = this.options.createFilePane;
    if (create === undefined) return;
    const id = `file-${this.nextFile}`;
    this.nextFile += 1;
    this.panes.set(
      id,
      create(id, path, () => this.notify()),
    );
    this.focusMainArea();
    this.layout.open(id, this.options.screen());
  }

  private summonBrowser(): void {
    const existing = [...this.panes.keys()].find((id) => id.startsWith("browser-"));
    if (existing !== undefined) {
      this.layout.focus(existing);
      return;
    }
    this.openBrowserPane(".");
  }

  private openBrowserPane(root: string): void {
    const create = this.options.createBrowserPane;
    if (create === undefined) return;
    const id = `browser-${this.nextBrowser}`;
    this.nextBrowser += 1;
    this.panes.set(
      id,
      create(id, root, () => this.notify(), this.intents),
    );
    this.layout.open(id, this.options.screen());
    this.layout.dockFocused(this.layout.dock()?.side ?? "left");
  }

  private pointsAtDirectory(path: string): boolean {
    return (
      this.options.createBrowserPane !== undefined && this.options.isDirectory?.(path) === true
    );
  }

  private focusMainArea(): void {
    const docked = this.layout.dock()?.panes ?? [];
    const focused = this.layout.focused();
    if (focused === undefined || !docked.includes(focused)) return;
    const main = this.layout.panes().find((id) => !docked.includes(id));
    if (main !== undefined) this.layout.focus(main);
  }

  private closePane(): void {
    const id = this.layout.focused();
    if (id === undefined) return;
    this.panes.get(id)?.dispose?.();
    this.panes.delete(id);
    this.layout.close(id);
  }

  private shutdown(): void {
    for (const pane of this.panes.values()) pane.dispose?.();
    this.options.onExit();
  }

  private openPalette(): void {
    this.paletteOpen = true;
    this.paletteQuery = "";
    this.paletteIndex = 0;
  }

  private closePalette(): void {
    this.paletteOpen = false;
    this.paletteQuery = "";
    this.paletteIndex = 0;
  }

  private routePaletteMouse(event: PointerEvent): void {
    const matches = this.paletteMatches();
    const frame = paletteFrame(this.options.screen(), matches.length);
    const inside = containsPoint(frame, event.x, event.y);
    const row = event.y - frame.firstRowY;
    const onRow = inside && row >= 0 && row < matches.length;
    if ((event.type === "move" || event.type === "drag") && onRow) this.paletteIndex = row;
    if (event.type !== "down") return;
    if (!inside) {
      this.closePalette();
      return;
    }
    if (onRow) {
      const chosen = matches[row];
      this.closePalette();
      chosen?.run();
    }
  }

  private routeHelpMouse(event: PointerEvent): void {
    if (event.type !== "down") return;
    const frame = helpFrame(this.options.screen(), this.keymap.actions().length);
    if (!containsPoint(frame, event.x, event.y)) this.helpVisible = false;
  }

  private routePaneMouse(event: PointerEvent): void {
    const hit = this.paneUnder(event.x, event.y);
    if (hit === undefined) return;
    if (event.type === "down") this.layout.focus(hit.id);
    const pane = this.panes.get(hit.id);
    const local = { x: event.x - hit.rect.x, y: event.y - hit.rect.y };
    if (pane?.handleMouse?.(local, event) === true) return;
    if (event.type === "scroll" && event.scroll !== undefined) scrollByKeys(pane, event.scroll);
  }

  private paneUnder(x: number, y: number): { id: string; rect: Rect } | undefined {
    for (const [id, rect] of this.layout.rects(this.options.screen())) {
      if (containsPoint(rect, x, y)) return { id, rect };
    }
    return undefined;
  }

  private paletteMatches() {
    return this.registry.search(this.paletteQuery).slice(0, paletteRowLimit);
  }

  private handlePaletteKey(chord: Chord, sequence: string | undefined): void {
    const matches = this.paletteMatches();
    if (chord.name === "escape") {
      this.closePalette();
      return;
    }
    if (chord.name === "up" || chord.name === "down") {
      const step = chord.name === "down" ? 1 : -1;
      const count = Math.max(1, matches.length);
      this.paletteIndex = (this.paletteIndex + step + count) % count;
      return;
    }
    if (chord.name === "return" || chord.name === "enter") {
      const chosen = matches[this.paletteIndex];
      this.closePalette();
      chosen?.run();
      return;
    }
    if (chord.name === "backspace") {
      this.paletteQuery = this.paletteQuery.slice(0, -1);
      this.paletteIndex = 0;
      return;
    }
    if (sequence !== undefined && sequence.length === 1 && !chord.ctrl && !chord.meta) {
      this.paletteQuery += sequence;
      this.paletteIndex = 0;
    }
  }

  private registerCommands(): void {
    const shortcut = (action: string) => {
      const keys = this.keymap.describe(action);
      return keys === undefined ? {} : { shortcut: keys };
    };
    const forAction = (name: string, action: string, description: string, aliases?: string[]) =>
      this.registry.register({
        name,
        description,
        ...(aliases !== undefined && { aliases }),
        ...shortcut(action),
        run: () => this.apply(action),
      });
    forAction("split", "pane.split", "open a new session pane");
    forAction("zoom", "pane.zoom", "zoom the focused pane");
    forAction("move-right", "focus.right", "focus the pane to the right", ["moveright"]);
    forAction("move-left", "focus.left", "focus the pane to the left", ["moveleft"]);
    forAction("move-up", "focus.up", "focus the pane above", ["moveup"]);
    forAction("move-down", "focus.down", "focus the pane below", ["movedown"]);
    forAction("keys", "help.toggle", "show the hotkeys overlay", ["help"]);
    forAction("palette", "palette.toggle", "open the command palette");
    forAction("dock-left", "dock.left", "dock this pane to the left edge", ["dockleft"]);
    forAction("dock-right", "dock.right", "dock this pane to the right edge", ["dockright"]);
    forAction("undock", "dock.undock", "return this pane to the main area");
    forAction("dock-wider", "dock.grow", "widen the dock column");
    forAction("dock-narrower", "dock.shrink", "narrow the dock column");
    forAction("grow", "pane.grow", "grow the focused pane", ["pane-grow"]);
    forAction("shrink", "pane.shrink", "shrink the focused pane", ["pane-shrink"]);
    if (this.options.createFilePane !== undefined) {
      this.registry.register({
        name: "open",
        aliases: ["view"],
        description: "open a file viewer pane: /open <path>",
        run: (args) => {
          if (args === undefined || args === "") return;
          if (this.pointsAtDirectory(args)) this.openBrowserPane(args);
          else this.openFilePane(args);
        },
      });
    }
    if (this.options.createBrowserPane !== undefined) {
      this.registry.register({
        name: "browse",
        aliases: ["files"],
        description: "open the file browser: /browse [dir]",
        ...shortcut("browser.summon"),
        run: (args) =>
          args === undefined || args === "" ? this.summonBrowser() : this.openBrowserPane(args),
      });
    }
    this.registry.register({
      name: "exit",
      description: "close this pane (closes keywork from the last one)",
      ...shortcut("pane.close"),
      run: () => (this.panes.size <= 1 ? this.shutdown() : this.closePane()),
    });
    this.registry.register({
      name: "exit-all",
      aliases: ["exitall", "quit"],
      description: "close every pane and quit keywork",
      ...shortcut("app.quit"),
      run: () => this.shutdown(),
    });
    this.registry.addSource(() =>
      this.layout
        .panes()
        .filter((id) => id !== this.layout.focused())
        .map((id) => {
          const title = this.panes.get(id)?.title().trim().split(" ·")[0] ?? id;
          return {
            name: `go-${title}`,
            description: "jump to this session",
            run: () => this.layout.focus(id),
          };
        }),
    );
  }
}

function containsPoint(frame: OverlayFrame, x: number, y: number): boolean {
  return x >= frame.x && x < frame.x + frame.width && y >= frame.y && y < frame.y + frame.height;
}

function scrollByKeys(pane: Pane | undefined, scroll: PointerScroll): void {
  if (pane?.handleKey === undefined) return;
  const chord: Chord = { name: scroll.direction, ctrl: false, shift: false, meta: false };
  const steps = Math.max(1, Math.round(scroll.delta));
  for (let step = 0; step < steps; step += 1) pane.handleKey(chord, undefined);
}
