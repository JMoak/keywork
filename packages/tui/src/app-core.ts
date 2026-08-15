import { CommandRegistry } from "./commands.ts";
import { Keymap } from "./keymap.ts";
import { type Chord, formatChord } from "./keys.ts";
import { type DockSide, Layout, layoutStateIds, type Rect, type Screen } from "./layout.ts";
import type { Pane, PaneIntents } from "./pane.ts";
import { type PointerEvent, type PointerScroll, wheelSteps } from "./pointer.ts";
import { captureWorkspace, type WorkspacePane, type WorkspaceState } from "./workspace-state.ts";

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
  "tree.summon": {
    chords: "leader t",
    help: "session tree",
    chainable: true,
    invoke: (core) => core.summonSessionTree(),
  },
  "memory.summon": {
    chords: "leader m",
    help: "memory pane",
    chainable: true,
    invoke: (core) => core.summonMemoryPane(),
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

export type PaneFactory = (
  id: string,
  notify: () => void,
  commands: CommandRegistry,
  resumeSessionId?: string,
  draft?: string,
) => Pane;
export type FilePaneFactory = (id: string, path: string, notify: () => void) => Pane;
export type BrowserPaneFactory = (
  id: string,
  root: string,
  notify: () => void,
  intents: PaneIntents,
) => Pane;
export type SessionTreePaneFactory = (
  id: string,
  notify: () => void,
  intents: PaneIntents,
  targetSession: () => string | undefined,
  sessionId?: string,
) => Pane;
export type MemoryPaneFactory = (id: string, notify: () => void) => Pane;
export type McpPaneFactory = (id: string, notify: () => void) => Pane;

export interface UndoPort {
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
}

export interface PresetsPort {
  names(): readonly string[];
  active(): string;
  requiresConfirmation(name: string): boolean;
  apply(name: string): Promise<void>;
}

export interface AppCoreOptions {
  screen: () => Screen;
  createPane: PaneFactory;
  createFilePane?: FilePaneFactory;
  createBrowserPane?: BrowserPaneFactory;
  createSessionTreePane?: SessionTreePaneFactory;
  createMemoryPane?: MemoryPaneFactory;
  createMcpPane?: McpPaneFactory;
  isDirectory?: (path: string) => boolean;
  undo?: UndoPort;
  presets?: PresetsPort;
  restoreWorkspace?: WorkspaceState;
  saveWorkspace?: (state: WorkspaceState) => void;
  onPaneClosed?: (id: string) => void;
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
  overlay: "palette" | "help" | "preset" | "preset-confirm" | undefined;
  paletteQuery: string;
  leaderArmed: boolean;
  lastKey: string;
  notice: string;
}

export interface PresetPicker {
  names: readonly string[];
  active: string;
  index: number;
}

export interface PresetConfirmation {
  from: string;
  to: string;
}

type PaletteEntries = ReturnType<CommandRegistry["search"]>;
type PaletteOverlay = { kind: "palette"; query: string; index: number; entries: PaletteEntries };
type Overlay =
  | PaletteOverlay
  | { kind: "help" }
  | { kind: "preset"; names: readonly string[]; index: number }
  | { kind: "preset-confirm"; name: string };

export class AppCore {
  readonly layout = new Layout();
  readonly keymap = new Keymap({ leader: "ctrl+k", bindings: appBindings });
  readonly registry = new CommandRegistry();
  readonly panes = new Map<string, Pane>();
  readonly intents: PaneIntents = {
    openFile: (path) => this.openFilePane(path),
    openSession: (sessionId, draft) => this.openPane(sessionId, draft),
    focusPane: (id) => this.layout.focus(id),
  };
  leaderArmed = false;
  lastKey = "";
  notice = "";
  private overlay: Overlay | undefined;
  private nextSession = 1;
  private nextFile = 1;
  private nextBrowser = 1;
  private nextTree = 1;
  private nextMemory = 1;
  private nextMcp = 1;
  private notify: () => void = () => {};
  private lastSavedWorkspace = "";
  private readonly paneChanged = (): void => {
    this.persistWorkspace();
    this.notify();
  };

  constructor(private readonly options: AppCoreOptions) {
    this.registerCommands();
  }

  bindNotify(notify: () => void): void {
    this.notify = notify;
  }

  start(): void {
    const saved = this.options.restoreWorkspace;
    if (saved === undefined || !this.restoreFrom(saved)) this.openPane();
    this.dockMcpPaneOnStartup();
    this.persistWorkspace();
  }

  workspaceState(): WorkspaceState {
    return captureWorkspace(this.layout, this.panes);
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
    const ran = this.registry.run(name);
    this.persistWorkspace();
    return ran;
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

  handleKey(chord: Chord, sequence: string | undefined, nowMs: number, repeat = false): void {
    this.dispatchKey(chord, sequence, nowMs, repeat);
    this.persistWorkspace();
  }

  private dispatchKey(
    chord: Chord,
    sequence: string | undefined,
    nowMs: number,
    repeat: boolean,
  ): void {
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
    if (this.helpVisible) {
      if (chord.name === "escape" || chord.name === "f1") this.overlay = undefined;
      return;
    }
    if (this.overlay?.kind === "preset") {
      this.handlePresetKey(this.overlay, chord);
      return;
    }
    if (this.overlay?.kind === "preset-confirm") {
      this.handlePresetConfirmKey(this.overlay.name, chord);
      return;
    }
    const result = this.keymap.press(chord, nowMs, repeat);
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

  handlePaste(text: string): void {
    if (this.overlay !== undefined) return;
    const id = this.layout.focused();
    if (id !== undefined) this.panes.get(id)?.handlePaste?.(text);
  }

  handleMouse(event: PointerEvent, _nowMs: number): void {
    if (this.paletteOpen) this.routePaletteMouse(event);
    else if (this.helpVisible) this.routeHelpMouse(event);
    else if (this.overlay !== undefined) {
      if (event.type === "down") this.overlay = undefined;
    } else this.routePaneMouse(event);
    this.persistWorkspace();
  }

  openPane(resumeSessionId?: string, draft?: string): void {
    const id = `session-${this.nextSession}`;
    this.nextSession += 1;
    this.panes.set(
      id,
      this.options.createPane(id, this.paneChanged, this.registry, resumeSessionId, draft),
    );
    this.focusMainArea();
    this.layout.open(id, this.screen());
    this.persistWorkspace();
    this.notify();
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
    this.options.onPaneClosed?.(id);
  }

  summonBrowser(): void {
    const existing = [...this.panes.keys()].find((id) => id.startsWith("browser-"));
    if (existing !== undefined) {
      this.layout.focus(existing);
      return;
    }
    this.openBrowserPane(".");
  }

  summonSessionTree(): void {
    const existing = [...this.panes.keys()].find((id) => id.startsWith("tree-"));
    if (existing !== undefined) {
      this.layout.focus(existing);
      return;
    }
    this.openSessionTreePane();
  }

  summonMemoryPane(): void {
    const existing = [...this.panes.keys()].find((id) => id.startsWith("memory-"));
    if (existing !== undefined) {
      this.layout.focus(existing);
      return;
    }
    this.openMemoryPane();
  }

  summonMcpPane(): void {
    const existing = [...this.panes.keys()].find((id) => id.startsWith("mcp-"));
    if (existing !== undefined) {
      this.layout.focus(existing);
      return;
    }
    this.openMcpPane();
  }

  postNotice(text: string): void {
    this.showNotice(text);
  }

  toggleHelp(): void {
    this.overlay = this.helpVisible ? undefined : { kind: "help" };
  }

  openPalette(): void {
    this.overlay = this.paletteFor("");
  }

  openPresetPicker(): void {
    const port = this.options.presets;
    if (port === undefined) return;
    const names = port.names();
    this.overlay = { kind: "preset", names, index: Math.max(0, names.indexOf(port.active())) };
  }

  presetPicker(): PresetPicker | undefined {
    const port = this.options.presets;
    if (port === undefined || this.overlay?.kind !== "preset") return undefined;
    return { names: this.overlay.names, active: port.active(), index: this.overlay.index };
  }

  presetConfirmation(): PresetConfirmation | undefined {
    const port = this.options.presets;
    if (port === undefined || this.overlay?.kind !== "preset-confirm") return undefined;
    return { from: port.active(), to: this.overlay.name };
  }

  shutdown(): void {
    this.persistWorkspace();
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
      entries: this.registry
        .search(query)
        .filter((command) => command.needsArgs !== true)
        .slice(0, paletteRowLimit),
    };
  }

  private apply(action: string): void {
    appActions[action]?.invoke(this);
  }

  private persistWorkspace(): void {
    const save = this.options.saveWorkspace;
    if (save === undefined) return;
    const state = this.workspaceState();
    const fingerprint = JSON.stringify(state);
    if (fingerprint === this.lastSavedWorkspace) return;
    this.lastSavedWorkspace = fingerprint;
    save(state);
  }

  private restoreFrom(state: WorkspaceState): boolean {
    const layoutIds = new Set(layoutStateIds(state.layout));
    const revived: string[] = [];
    for (const entry of state.panes) {
      if (!layoutIds.has(entry.id)) continue;
      const pane = this.revive(entry);
      if (pane === undefined) continue;
      this.panes.set(entry.id, pane);
      revived.push(entry.id);
    }
    if (revived.length === 0) return false;
    this.layout.load(state.layout);
    for (const id of this.layout.panes()) {
      if (!this.panes.has(id)) this.layout.close(id);
    }
    this.adoptPaneNumbers(revived);
    return true;
  }

  private revive(entry: WorkspacePane): Pane | undefined {
    try {
      switch (entry.kind) {
        case "conversation":
          return this.options.createPane(
            entry.id,
            this.paneChanged,
            this.registry,
            entry.sessionId,
          );
        case "file":
          return this.options.createFilePane?.(entry.id, entry.path, this.paneChanged);
        case "browser":
          return this.options.createBrowserPane?.(
            entry.id,
            entry.root,
            this.paneChanged,
            this.intents,
          );
        case "session-tree":
          return this.options.createSessionTreePane?.(
            entry.id,
            this.paneChanged,
            this.intents,
            () => this.conversationSession(),
            entry.sessionId,
          );
        case "memory":
          return this.options.createMemoryPane?.(entry.id, this.paneChanged);
        case "mcp":
          return this.options.createMcpPane?.(entry.id, this.paneChanged);
      }
    } catch {
      return undefined;
    }
  }

  private adoptPaneNumbers(ids: readonly string[]): void {
    for (const id of ids) {
      this.nextSession = nextAfter(id, "session", this.nextSession);
      this.nextFile = nextAfter(id, "file", this.nextFile);
      this.nextBrowser = nextAfter(id, "browser", this.nextBrowser);
      this.nextTree = nextAfter(id, "tree", this.nextTree);
      this.nextMemory = nextAfter(id, "memory", this.nextMemory);
      this.nextMcp = nextAfter(id, "mcp", this.nextMcp);
    }
  }

  private openFilePane(path: string): void {
    const create = this.options.createFilePane;
    if (create === undefined) return;
    const id = `file-${this.nextFile}`;
    this.nextFile += 1;
    this.panes.set(id, create(id, path, this.paneChanged));
    this.focusMainArea();
    this.layout.open(id, this.screen());
  }

  private openBrowserPane(root: string): void {
    const create = this.options.createBrowserPane;
    if (create === undefined) return;
    const id = `browser-${this.nextBrowser}`;
    this.nextBrowser += 1;
    this.panes.set(id, create(id, root, this.paneChanged, this.intents));
    this.layout.open(id, this.screen());
    this.layout.dockFocused(this.layout.dock()?.side ?? "left");
  }

  private openSessionTreePane(): void {
    const create = this.options.createSessionTreePane;
    if (create === undefined) return;
    const id = `tree-${this.nextTree}`;
    this.nextTree += 1;
    this.panes.set(
      id,
      create(id, this.paneChanged, this.intents, () => this.conversationSession()),
    );
    this.layout.open(id, this.screen());
    this.layout.dockFocused(this.layout.dock()?.side ?? "left");
  }

  private openMemoryPane(): void {
    const create = this.options.createMemoryPane;
    if (create === undefined) return;
    const id = `memory-${this.nextMemory}`;
    this.nextMemory += 1;
    this.panes.set(id, create(id, this.paneChanged));
    this.layout.open(id, this.screen());
    this.layout.dockFocused(this.layout.dock()?.side ?? "left");
  }

  private openMcpPane(): void {
    const create = this.options.createMcpPane;
    if (create === undefined) return;
    const id = `mcp-${this.nextMcp}`;
    this.nextMcp += 1;
    this.panes.set(id, create(id, this.paneChanged));
    this.layout.open(id, this.screen());
    this.layout.dockFocused(this.layout.dock()?.side ?? "right");
  }

  private dockMcpPaneOnStartup(): void {
    if (this.options.createMcpPane === undefined) return;
    if ([...this.panes.keys()].some((id) => id.startsWith("mcp-"))) return;
    this.openMcpPane();
    this.focusMainArea();
  }

  private conversationSession(): string | undefined {
    const focused = this.layout.focused();
    const ids = this.layout.panes();
    const ordered = focused === undefined ? ids : [focused, ...ids.filter((id) => id !== focused)];
    for (const id of ordered) {
      const descriptor = this.panes.get(id)?.describe?.();
      if (descriptor?.kind === "conversation" && descriptor.sessionId !== undefined) {
        return descriptor.sessionId;
      }
    }
    return undefined;
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

  private handlePresetKey(
    overlay: { names: readonly string[]; index: number },
    chord: Chord,
  ): void {
    if (chord.name === "escape") {
      this.overlay = undefined;
      return;
    }
    if (chord.name === "up" || chord.name === "down") {
      const step = chord.name === "down" ? 1 : -1;
      const count = Math.max(1, overlay.names.length);
      overlay.index = (overlay.index + step + count) % count;
      return;
    }
    if (chord.name === "return" || chord.name === "enter") {
      const chosen = overlay.names[overlay.index];
      if (chosen !== undefined) this.choosePreset(chosen);
    }
  }

  private handlePresetConfirmKey(name: string, chord: Chord): void {
    if (["y", "return", "enter"].includes(chord.name)) {
      this.applyPreset(name);
      return;
    }
    if (chord.name === "n" || chord.name === "escape") this.overlay = undefined;
  }

  private choosePreset(name: string): void {
    const port = this.options.presets;
    if (port === undefined) return;
    if (name === port.active()) {
      this.overlay = undefined;
      this.showNotice(`already on ${name}`);
      return;
    }
    if (port.requiresConfirmation(name)) {
      this.overlay = { kind: "preset-confirm", name };
      return;
    }
    this.applyPreset(name);
  }

  private applyPreset(name: string): void {
    const port = this.options.presets;
    this.overlay = undefined;
    if (port === undefined) return;
    port
      .apply(name)
      .then(() => this.showNotice(`permissions preset → ${name}`))
      .catch((cause: unknown) => this.showNotice((cause as Error).message));
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
        needsArgs: true,
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
    if (this.options.createSessionTreePane !== undefined) {
      this.registry.register({
        name: "tree",
        aliases: ["session-tree"],
        description: "open the session tree: /tree",
        ...shortcut("tree.summon"),
        run: () => this.summonSessionTree(),
      });
    }
    if (this.options.createMemoryPane !== undefined) {
      this.registry.register({
        name: "memory",
        description: "open the memory pane: /memory",
        ...shortcut("memory.summon"),
        run: () => this.summonMemoryPane(),
      });
    }
    if (this.options.createMcpPane !== undefined) {
      this.registry.register({
        name: "mcp",
        description: "open the MCP status pane: /mcp",
        run: () => this.summonMcpPane(),
      });
    }
    if (this.options.presets !== undefined) {
      this.registry.register({
        name: "preset",
        aliases: ["presets"],
        description: "switch the permissions preset: /preset",
        run: () => this.openPresetPicker(),
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
    this.registry.addSource(() => {
      const targets = this.layout
        .panes()
        .filter((id) => id !== this.layout.focused())
        .map((id) => ({ id, title: this.panes.get(id)?.title().trim().split(" ·")[0] ?? id }));
      const titleCounts = new Map<string, number>();
      for (const { title } of targets) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
      return targets.map(({ id, title }) => ({
        name: `go-${(titleCounts.get(title) ?? 0) > 1 ? `${title} ${id}` : title}`,
        description: "jump to this session",
        run: () => this.layout.focus(id),
      }));
    });
  }
}

function nextAfter(id: string, prefix: string, current: number): number {
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
  if (match === null) return current;
  return Math.max(current, Number(match[1]) + 1);
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
