import { CommandRegistry } from "./commands.ts";
import { Keymap } from "./keymap.ts";
import { type Chord, formatChord } from "./keys.ts";
import { type DockSide, Layout, type Rect, type Screen } from "./layout.ts";
import type { Pane, PaneIntents } from "./pane.ts";
import { type PointerEvent, type PointerScroll, wheelSteps } from "./pointer.ts";

interface AppAction {
  chords: string | readonly string[];
  help: string;
  sticky?: true;
  chainable?: true;
  invoke: (core: AppCore) => void;
  command?: { name: string; description: string; aliases?: string[] };
}

const appActions: Record<string, AppAction> = {
  "pane.split": {
    chords: "leader s",
    help: "new session pane",
    sticky: true,
    invoke: (core) => core.openPane(),
    command: { name: "split", description: "open a new session pane" },
  },
  "pane.close": {
    chords: "leader x",
    help: "close focused pane",
    sticky: true,
    invoke: (core) => core.closePane(),
  },
  "pane.zoom": {
    chords: "leader z",
    help: "zoom pane (toggle)",
    sticky: true,
    invoke: (core) => core.layout.zoomToggle(),
    command: { name: "zoom", description: "zoom the focused pane" },
  },
  "focus.left": {
    chords: ["leader h", "leader left"],
    help: "focus left",
    sticky: true,
    invoke: (core) => core.layout.moveFocus("left", core.screen()),
    command: {
      name: "move-left",
      description: "focus the pane to the left",
      aliases: ["moveleft"],
    },
  },
  "focus.down": {
    chords: ["leader j", "leader down"],
    help: "focus down",
    sticky: true,
    invoke: (core) => core.layout.moveFocus("down", core.screen()),
    command: { name: "move-down", description: "focus the pane below", aliases: ["movedown"] },
  },
  "focus.up": {
    chords: ["leader k", "leader up"],
    help: "focus up",
    sticky: true,
    invoke: (core) => core.layout.moveFocus("up", core.screen()),
    command: { name: "move-up", description: "focus the pane above", aliases: ["moveup"] },
  },
  "focus.right": {
    chords: ["leader l", "leader right"],
    help: "focus right",
    sticky: true,
    invoke: (core) => core.layout.moveFocus("right", core.screen()),
    command: {
      name: "move-right",
      description: "focus the pane to the right",
      aliases: ["moveright"],
    },
  },
  "swap.left": {
    chords: "leader shift+h",
    help: "swap pane left",
    sticky: true,
    invoke: (core) => core.layout.swap("left", core.screen()),
  },
  "swap.down": {
    chords: "leader shift+j",
    help: "swap pane down",
    sticky: true,
    invoke: (core) => core.layout.swap("down", core.screen()),
  },
  "swap.up": {
    chords: "leader shift+k",
    help: "swap pane up",
    sticky: true,
    invoke: (core) => core.layout.swap("up", core.screen()),
  },
  "swap.right": {
    chords: "leader shift+l",
    help: "swap pane right",
    sticky: true,
    invoke: (core) => core.layout.swap("right", core.screen()),
  },
  "dock.left": {
    chords: "leader d",
    help: "dock pane to the left edge",
    sticky: true,
    invoke: (core) => core.layout.dockFocused("left"),
    command: {
      name: "dock-left",
      description: "dock this pane to the left edge",
      aliases: ["dockleft"],
    },
  },
  "dock.right": {
    chords: "leader shift+d",
    help: "dock pane to the right edge",
    sticky: true,
    invoke: (core) => core.layout.dockFocused("right"),
    command: {
      name: "dock-right",
      description: "dock this pane to the right edge",
      aliases: ["dockright"],
    },
  },
  "dock.undock": {
    chords: "leader u",
    help: "return pane to the main area",
    sticky: true,
    invoke: (core) => core.layout.undockFocused(core.screen()),
    command: { name: "undock", description: "return this pane to the main area" },
  },
  "dock.grow": {
    chords: "leader .",
    help: "widen the dock",
    sticky: true,
    invoke: (core) => core.layout.growDock(0.05),
    command: { name: "dock-wider", description: "widen the dock column" },
  },
  "dock.shrink": {
    chords: "leader ,",
    help: "narrow the dock",
    sticky: true,
    invoke: (core) => core.layout.growDock(-0.05),
    command: { name: "dock-narrower", description: "narrow the dock column" },
  },
  "pane.grow": {
    chords: "leader shift+.",
    help: "grow the focused pane",
    sticky: true,
    invoke: (core) => core.layout.resizeFocused(0.05),
    command: { name: "grow", description: "grow the focused pane", aliases: ["pane-grow"] },
  },
  "pane.shrink": {
    chords: "leader shift+,",
    help: "shrink the focused pane",
    sticky: true,
    invoke: (core) => core.layout.resizeFocused(-0.05),
    command: { name: "shrink", description: "shrink the focused pane", aliases: ["pane-shrink"] },
  },
  "browser.summon": {
    chords: "leader f",
    help: "file browser",
    chainable: true,
    invoke: (core) => core.summonBrowser(),
  },
  "help.toggle": {
    chords: ["leader /", "f1"],
    help: "this overlay",
    invoke: (core) => core.toggleHelp(),
    command: { name: "keys", description: "show the hotkeys overlay", aliases: ["help"] },
  },
  "palette.toggle": {
    chords: ["ctrl+p", "leader p"],
    help: "command palette",
    invoke: (core) => core.openPalette(),
    command: { name: "palette", description: "open the command palette" },
  },
  "app.quit": {
    chords: "ctrl+q",
    help: "quit",
    invoke: (core) => core.shutdown(),
  },
};

export const appBindings: Record<string, string | readonly string[]> = Object.fromEntries(
  Object.entries(appActions).map(([name, action]) => [name, action.chords]),
);

export const bindingHelp: Record<string, string> = Object.fromEntries(
  Object.entries(appActions).map(([name, action]) => [name, action.help]),
);

const stickyActions = new Set(
  Object.entries(appActions)
    .filter(([, action]) => action.sticky)
    .map(([name]) => name),
);

const chainActions = new Set(
  Object.entries(appActions)
    .filter(([, action]) => action.sticky || action.chainable)
    .map(([name]) => name),
);

export type PaneFactory = (id: string, notify: () => void, commands: CommandRegistry) => Pane;
export type FilePaneFactory = (id: string, path: string, notify: () => void) => Pane;
export type BrowserPaneFactory = (
  id: string,
  root: string,
  notify: () => void,
  intents: PaneIntents,
) => Pane;

export interface UndoPort {
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
}

export interface AppCoreOptions {
  screen: () => Screen;
  createPane: PaneFactory;
  createFilePane?: FilePaneFactory;
  createBrowserPane?: BrowserPaneFactory;
  isDirectory?: (path: string) => boolean;
  undo?: UndoPort;
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
  notice: string;
}

type PaletteEntries = ReturnType<CommandRegistry["search"]>;
type PaletteOverlay = { kind: "palette"; query: string; index: number; entries: PaletteEntries };
type Overlay = PaletteOverlay | { kind: "help" };

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
  lastKey = "";
  notice = "";
  private overlay: Overlay | undefined;
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

  screen(): Screen {
    return this.options.screen();
  }

  get helpVisible(): boolean {
    return this.overlay?.kind === "help";
  }

  get paletteOpen(): boolean {
    return this.overlay?.kind === "palette";
  }

  get paletteQuery(): string {
    return this.palette()?.query ?? "";
  }

  get paletteIndex(): number {
    return this.palette()?.index ?? 0;
  }

  paletteMatches(): PaletteEntries {
    return this.palette()?.entries ?? [];
  }

  runCommand(name: string): boolean {
    return this.registry.run(name);
  }

  expireArmed(nowMs: number): void {
    this.leaderArmed = this.keymap.armed(nowMs);
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
      overlay: this.overlay?.kind,
      paletteQuery: this.paletteQuery,
      leaderArmed: this.leaderArmed,
      lastKey: this.lastKey,
      notice: this.notice,
    };
  }

  handleKey(chord: Chord, sequence: string | undefined, nowMs: number): void {
    this.lastKey = formatChord(chord);
    this.notice = "";
    if (chord.ctrl && chord.name === "q") {
      this.shutdown();
      return;
    }
    if (this.paletteOpen) {
      this.handlePaletteKey(chord, sequence);
      return;
    }
    if (this.helpVisible && chord.name === "escape") {
      this.overlay = undefined;
      return;
    }
    const result = this.keymap.press(chord, nowMs);
    this.leaderArmed = result.type === "leader-pending";
    if (result.type === "action") {
      this.apply(result.action);
      if (stickyActions.has(result.action)) {
        this.keymap.arm(nowMs, chainActions);
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

  openPane(): void {
    const id = `session-${this.nextSession}`;
    this.nextSession += 1;
    this.panes.set(
      id,
      this.options.createPane(id, () => this.notify(), this.registry),
    );
    this.focusMainArea();
    this.layout.open(id, this.screen());
  }

  closePane(): void {
    if (this.panes.size <= 1) {
      this.shutdown();
      return;
    }
    const id = this.layout.focused();
    if (id === undefined) return;
    this.panes.get(id)?.dispose?.();
    this.panes.delete(id);
    this.layout.close(id);
  }

  summonBrowser(): void {
    const existing = [...this.panes.keys()].find((id) => id.startsWith("browser-"));
    if (existing !== undefined) {
      this.layout.focus(existing);
      return;
    }
    this.openBrowserPane(".");
  }

  toggleHelp(): void {
    this.overlay = this.helpVisible ? undefined : { kind: "help" };
  }

  openPalette(): void {
    this.overlay = this.paletteFor("");
  }

  shutdown(): void {
    for (const pane of this.panes.values()) pane.dispose?.();
    this.options.onExit();
  }

  private announce(outcome: Promise<boolean>, done: string, empty: string): void {
    outcome
      .then((changed) => this.showNotice(changed ? done : empty))
      .catch((cause: unknown) => this.showNotice((cause as Error).message));
  }

  private showNotice(text: string): void {
    this.notice = text;
    this.notify();
  }

  private palette(): PaletteOverlay | undefined {
    return this.overlay?.kind === "palette" ? this.overlay : undefined;
  }

  private paletteFor(query: string): PaletteOverlay {
    return {
      kind: "palette",
      query,
      index: 0,
      entries: this.registry.search(query).slice(0, paletteRowLimit),
    };
  }

  private apply(action: string): void {
    appActions[action]?.invoke(this);
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
    this.layout.open(id, this.screen());
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
    this.layout.open(id, this.screen());
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

  private routePaletteMouse(event: PointerEvent): void {
    const palette = this.palette();
    if (palette === undefined) return;
    const frame = paletteFrame(this.screen(), palette.entries.length);
    const inside = containsPoint(frame, event.x, event.y);
    const row = event.y - frame.firstRowY;
    const onRow = inside && row >= 0 && row < palette.entries.length;
    if ((event.type === "move" || event.type === "drag") && onRow) palette.index = row;
    if (event.type !== "down") return;
    if (!inside) {
      this.overlay = undefined;
      return;
    }
    if (onRow) {
      const chosen = palette.entries[row];
      this.overlay = undefined;
      chosen?.run();
    }
  }

  private routeHelpMouse(event: PointerEvent): void {
    if (event.type !== "down") return;
    const frame = helpFrame(this.screen(), this.keymap.actions().length);
    if (!containsPoint(frame, event.x, event.y)) this.overlay = undefined;
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
    for (const [id, rect] of this.layout.rects(this.screen())) {
      if (containsPoint(rect, x, y)) return { id, rect };
    }
    return undefined;
  }

  private handlePaletteKey(chord: Chord, sequence: string | undefined): void {
    const palette = this.palette();
    if (palette === undefined) return;
    if (chord.name === "escape") {
      this.overlay = undefined;
      return;
    }
    if (chord.name === "up" || chord.name === "down") {
      const step = chord.name === "down" ? 1 : -1;
      const count = Math.max(1, palette.entries.length);
      palette.index = (palette.index + step + count) % count;
      return;
    }
    if (chord.name === "return" || chord.name === "enter") {
      const chosen = palette.entries[palette.index];
      this.overlay = undefined;
      chosen?.run();
      return;
    }
    if (chord.name === "backspace") {
      this.overlay = this.paletteFor(palette.query.slice(0, -1));
      return;
    }
    if (sequence !== undefined && sequence.length === 1 && !chord.ctrl && !chord.meta) {
      this.overlay = this.paletteFor(palette.query + sequence);
    }
  }

  private registerCommands(): void {
    const shortcut = (action: string) => {
      const keys = this.keymap.describe(action);
      return keys === undefined ? {} : { shortcut: keys };
    };
    for (const [name, action] of Object.entries(appActions)) {
      if (action.command === undefined) continue;
      const { aliases, ...command } = action.command;
      this.registry.register({
        ...command,
        ...(aliases !== undefined && { aliases }),
        ...shortcut(name),
        run: () => action.invoke(this),
      });
    }
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
    const undoPort = this.options.undo;
    if (undoPort !== undefined) {
      this.registry.register({
        name: "undo",
        description: "restore files to before the last agent change",
        run: () => this.announce(undoPort.undo(), "files restored", "nothing to undo"),
      });
      this.registry.register({
        name: "redo",
        description: "reapply the last undone agent change",
        run: () => this.announce(undoPort.redo(), "files brought forward", "nothing to redo"),
      });
    }
    this.registry.register({
      name: "exit",
      description: "close this pane (closes keywork from the last one)",
      ...shortcut("pane.close"),
      run: () => this.closePane(),
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
  const steps = wheelSteps(scroll.delta);
  for (let step = 0; step < steps; step += 1) pane.handleKey(chord, undefined);
}
