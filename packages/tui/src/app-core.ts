import { ArcPicker, type ArcPickerChoice } from "./arc-picker.ts";
import { type ArcsPort, arcSlugProblem, suggestArcSlug } from "./arcs.ts";
import { describeCloseOutcome } from "./arcs-pane.ts";
import { CommandRegistry } from "./commands.ts";
import { ConnectModel } from "./connect-model.ts";
import type { ConnectionsPort, InferencePort } from "./inference-port.ts";
import { Keymap } from "./keymap.ts";
import { type Chord, formatChord, parseChord } from "./keys.ts";
import {
  type Direction,
  type DockSide,
  type DropTarget,
  Layout,
  layoutStateIds,
  type Rect,
  type Screen,
} from "./layout.ts";
import { ModelPicker } from "./model-picker.ts";
import type { FileOpenOptions, Pane, PaneIntents } from "./pane.ts";
import { type PointerEvent, type PointerScroll, wheelSteps } from "./pointer.ts";
import {
  WorkspacePicker,
  type WorkspacePickerChoice,
  type WorkspacesPort,
} from "./workspace-picker.ts";
import { captureWorkspace, type WorkspacePane, type WorkspaceState } from "./workspace-state.ts";

type AppAction = {
  chords: string | readonly string[];
  help: string;
  sticky?: true;
  chainable?: true;
  invoke: (core: AppCore) => void;
} & (
  | { command: { name: string; description: string; aliases?: string[] } }
  | { coveredBy: string }
);

const appActions: Record<string, AppAction> = {
  "pane.split": {
    chords: "leader s",
    help: "new session pane",
    sticky: true,
    invoke: (core) => core.splitPane("inherit"),
    command: { name: "split", description: "open a new session pane in this arc" },
  },
  "pane.splitArc": {
    chords: "leader shift+s",
    help: "new session in a new arc",
    sticky: true,
    invoke: (core) => core.splitPane("new"),
    command: {
      name: "split-arc",
      description: "new session pane in a fresh arc",
      aliases: ["split-new-arc"],
    },
  },
  "pane.close": {
    chords: "leader x",
    help: "close focused pane",
    sticky: true,
    invoke: (core) => core.closePane(),
    coveredBy: "exit",
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
  "move.left": {
    chords: "leader shift+h",
    help: "move pane left",
    sticky: true,
    invoke: (core) => core.movePane("left"),
    command: { name: "push-left", description: "move this pane left", aliases: ["pushleft"] },
  },
  "move.down": {
    chords: "leader shift+j",
    help: "move pane down",
    sticky: true,
    invoke: (core) => core.movePane("down"),
    command: { name: "push-down", description: "move this pane down", aliases: ["pushdown"] },
  },
  "move.up": {
    chords: "leader shift+k",
    help: "move pane up",
    sticky: true,
    invoke: (core) => core.movePane("up"),
    command: { name: "push-up", description: "move this pane up", aliases: ["pushup"] },
  },
  "move.right": {
    chords: "leader shift+l",
    help: "move pane right",
    sticky: true,
    invoke: (core) => core.movePane("right"),
    command: { name: "push-right", description: "move this pane right", aliases: ["pushright"] },
  },
  "dock.cycle": {
    chords: "leader c",
    help: "cycle pane main → left → right",
    sticky: true,
    invoke: (core) => core.cyclePane(),
    command: {
      name: "dock-cycle",
      description: "move this pane to its next home: main → left → right",
      aliases: ["cycle"],
    },
  },
  "dock.grow": {
    chords: "leader .",
    help: "widen this pane's dock",
    sticky: true,
    invoke: (core) => core.resizeDock(0.05),
    command: { name: "dock-wider", description: "widen this pane's dock" },
  },
  "dock.shrink": {
    chords: "leader ,",
    help: "narrow this pane's dock",
    sticky: true,
    invoke: (core) => core.resizeDock(-0.05),
    command: { name: "dock-narrower", description: "narrow this pane's dock" },
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
    coveredBy: "browse",
  },
  "tree.summon": {
    chords: "leader t",
    help: "session tree",
    chainable: true,
    invoke: (core) => core.summonSessionTree(),
    coveredBy: "tree",
  },
  "memory.summon": {
    chords: "leader m",
    help: "memory pane",
    chainable: true,
    invoke: (core) => core.summonMemoryPane(),
    coveredBy: "memory",
  },
  "arcs.summon": {
    chords: "leader a",
    help: "arcs node",
    chainable: true,
    invoke: (core) => core.summonArcsPane(),
    coveredBy: "arcs",
  },
  "help.toggle": {
    chords: ["leader /", "f1"],
    help: "this overlay",
    invoke: (core) => core.toggleHelp(),
    command: { name: "keys", description: "show the hotkeys overlay", aliases: ["help"] },
  },
  "palette.go": {
    chords: "ctrl+p",
    help: "quick open (> commands)",
    invoke: (core) => core.openPalette(),
    command: { name: "go", description: "jump to a pane (type > for commands)" },
  },
  "palette.commands": {
    chords: ["ctrl+shift+p", "leader p"],
    help: "command palette",
    invoke: (core) => core.openPalette(">"),
    command: {
      name: "palette",
      description: "open the command palette",
      aliases: ["commands"],
    },
  },
  "app.quit": {
    chords: "ctrl+q",
    help: "quit",
    invoke: (core) => core.shutdown(),
    coveredBy: "exit-all",
  },
};

export const actionCommandNames: Record<string, string> = Object.fromEntries(
  Object.entries(appActions).map(([name, action]) => [
    name,
    "command" in action ? action.command.name : action.coveredBy,
  ]),
);

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

export type ArcOrigin = "inherit" | "new";

export interface PaneOrigin {
  sourcePaneId?: string;
  arc: ArcOrigin;
}

export type PaneFactory = (
  id: string,
  notify: () => void,
  commands: CommandRegistry,
  resumeSessionId?: string,
  draft?: string,
  origin?: PaneOrigin,
) => Pane | undefined;
export type FilePaneFactory = (
  id: string,
  path: string,
  notify: () => void,
  options?: FileOpenOptions,
) => Pane;
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
export type ArcsPaneFactory = (
  id: string,
  notify: () => void,
  intents: PaneIntents,
  targetSession: () => string | undefined,
  arc?: string,
) => Pane;
export type MemoryPaneFactory = (id: string, notify: () => void) => Pane;
export type McpPaneFactory = (id: string, notify: () => void) => Pane;

export interface FocusedArcPort {
  current(): string | undefined;
  titleHint(): string | undefined;
  bind(slug: string | undefined): Promise<void>;
}

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
  createArcsPane?: ArcsPaneFactory;
  createMemoryPane?: MemoryPaneFactory;
  createMcpPane?: McpPaneFactory;
  isDirectory?: (path: string) => boolean;
  undo?: UndoPort;
  presets?: PresetsPort;
  inference?: InferencePort;
  connections?: ConnectionsPort;
  arcs?: ArcsPort;
  focusedArc?: FocusedArcPort;
  workspaces?: WorkspacesPort;
  currentModel?: () => string | undefined;
  switchModel?: (reference: string) => Promise<string>;
  restoreWorkspace?: WorkspaceState;
  saveWorkspace?: (state: WorkspaceState) => void;
  onPaneClosed?: (id: string) => void;
  onExit: () => void;
}

export interface PaneSnapshot {
  id: string;
  title: string;
  focused: boolean;
  dock: DockSide | undefined;
}

export interface OverlayFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayRowFrame extends OverlayFrame {
  firstRowY: number;
}

export const paletteRowLimit = 10;

export function paletteModeOf(query: string): "go" | "commands" {
  return query.startsWith(">") ? "commands" : "go";
}

export function paletteFrame(screen: Screen, rowCount: number): OverlayRowFrame {
  const width = Math.min(64, screen.width - 4);
  const x = Math.max(2, Math.floor((screen.width - width) / 2));
  const y = 2;
  return { x, y, width, height: Math.max(1, rowCount) + 5, firstRowY: y + 3 };
}

export function helpFrame(screen: Screen, rowCount: number): OverlayRowFrame {
  const width = Math.min(52, screen.width - 4);
  const height = rowCount + 5;
  const y = Math.max(1, Math.floor((screen.height - height) / 2));
  return {
    x: Math.max(2, Math.floor((screen.width - width) / 2)),
    y,
    width,
    height,
    firstRowY: y + 2,
  };
}

export interface AppSnapshot {
  panes: PaneSnapshot[];
  focused: string | undefined;
  zoomed: string | undefined;
  overlay: Overlay["kind"] | undefined;
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

const presetConfirmRows = 2;
const escapeChord = parseChord("escape");

type PaletteEntries = ReturnType<CommandRegistry["search"]>;
type PaletteOverlay = { kind: "palette"; query: string; index: number; entries: PaletteEntries };
type Overlay =
  | PaletteOverlay
  | { kind: "help" }
  | { kind: "preset"; names: readonly string[]; index: number }
  | { kind: "preset-confirm"; name: string }
  | { kind: "model"; picker: ModelPicker }
  | { kind: "arc"; picker: ArcPicker }
  | { kind: "workspace"; picker: WorkspacePicker }
  | { kind: "connect"; model: ConnectModel };

export class AppCore {
  readonly layout = new Layout();
  readonly keymap = new Keymap({ leader: "ctrl+k", bindings: appBindings });
  readonly registry = new CommandRegistry();
  readonly panes = new Map<string, Pane>();
  readonly intents: PaneIntents = {
    openFile: (path, options) => this.openFilePane(path, options),
    openSession: (sessionId, draft) => this.openPane(sessionId, draft),
    focusPane: (id) => this.layout.focus(id),
    notice: (text) => this.showNotice(text),
  };
  leaderArmed = false;
  lastKey = "";
  notice = "";
  private overlay: Overlay | undefined;
  private dockResize: DockSide | undefined;
  private paneDrag: { id: string; lifted: boolean; target: DropTarget | undefined } | undefined;
  private nextSession = 1;
  private nextFile = 1;
  private nextBrowser = 1;
  private nextTree = 1;
  private nextArcs = 1;
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
    if (saved === undefined || !this.restoreFrom(saved)) this.seedDefaultWorkspace();
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

  get overlayOpen(): boolean {
    return this.overlay !== undefined;
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
    return {
      panes: this.layout.panes().map((id) => ({
        id,
        title: this.panes.get(id)?.title().trim() ?? id,
        focused: id === focused,
        dock: this.layout.dockSideOf(id),
      })),
      focused,
      zoomed: this.layout.zoomed(),
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
    if (this.overlay?.kind === "model") {
      this.handleModelKey(this.overlay.picker, chord, sequence);
      return;
    }
    if (this.overlay?.kind === "arc") {
      this.handleArcKey(this.overlay.picker, chord, sequence);
      return;
    }
    if (this.overlay?.kind === "workspace") {
      this.handleWorkspaceKey(this.overlay.picker, chord, sequence);
      return;
    }
    if (this.overlay?.kind === "connect") {
      if (this.overlay.model.handleKey(chord, sequence) === "close") this.overlay = undefined;
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
    const overlay = this.overlay;
    if (overlay !== undefined) {
      this.pasteIntoOverlay(overlay, pastedLine(text));
      return;
    }
    const id = this.layout.focused();
    if (id !== undefined) this.panes.get(id)?.handlePaste?.(text);
  }

  handleMouse(event: PointerEvent, _nowMs: number): void {
    this.routeMouse(event);
    this.persistWorkspace();
  }

  openPane(resumeSessionId?: string, draft?: string, origin?: PaneOrigin): void {
    this.focusMainArea();
    const id = `session-${this.nextSession}`;
    if (!this.openInLayout(id)) return;
    const pane = this.options.createPane(
      id,
      this.paneChanged,
      this.registry,
      resumeSessionId,
      draft,
      origin,
    );
    if (pane === undefined) {
      this.layout.close(id);
      this.showNotice(
        resumeSessionId === undefined
          ? "can't open a session pane · no session could be started"
          : `can't open session ${resumeSessionId} · its store is missing or unreadable`,
      );
      return;
    }
    this.nextSession += 1;
    this.panes.set(id, pane);
    this.persistWorkspace();
    this.notify();
  }

  splitPane(arc: ArcOrigin): void {
    const source = this.focusedConversationPaneId();
    this.openPane(undefined, undefined, {
      ...(source !== undefined && { sourcePaneId: source }),
      arc,
    });
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

  dockPane(side: DockSide): void {
    if (!this.layout.dockFocused(side, this.screen())) this.noticeNoRoom(`the ${side} dock`);
  }

  undockPane(): void {
    if (!this.layout.undockFocused(this.screen())) this.noticeNoRoom("the main area");
  }

  cyclePane(): void {
    if (!this.layout.cycleFocused(this.screen())) this.noticeNoRoom("this pane's next home");
  }

  movePane(direction: Direction): void {
    this.layout.move(direction, this.screen());
  }

  resizeDock(delta: number): void {
    this.layout.growDock(this.focusedDockSide(), delta);
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

  summonArcsPane(): void {
    const existing = [...this.panes.keys()].find((id) => id.startsWith("arcs-"));
    if (existing !== undefined) {
      this.layout.focus(existing);
      return;
    }
    this.openArcsPane();
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

  openPalette(initialQuery = ""): void {
    this.overlay = this.paletteFor(initialQuery);
  }

  get paletteMode(): "go" | "commands" {
    return paletteModeOf(this.paletteQuery);
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

  openModelPicker(argument = ""): void {
    const port = this.options.inference;
    if (port === undefined) return;
    const reference = argument.trim();
    if (reference !== "") {
      this.selectModel(reference);
      return;
    }
    this.overlay = {
      kind: "model",
      picker: new ModelPicker(port.choices(), this.options.currentModel?.()),
    };
  }

  modelPicker(): ModelPicker | undefined {
    return this.overlay?.kind === "model" ? this.overlay.picker : undefined;
  }

  openArcCommand(argument = ""): void {
    const arcs = this.options.arcs;
    if (arcs === undefined) return;
    this.runArcCommand(arcs, argument.trim())
      .catch((cause: unknown) => this.showNotice((cause as Error).message))
      .finally(() => this.notify());
  }

  arcPicker(): ArcPicker | undefined {
    return this.overlay?.kind === "arc" ? this.overlay.picker : undefined;
  }

  openWorkspaceCommand(argument = ""): void {
    const workspaces = this.options.workspaces;
    if (workspaces === undefined) return;
    this.runWorkspaceCommand(workspaces, argument.trim())
      .catch((cause: unknown) => this.showNotice((cause as Error).message))
      .finally(() => this.notify());
  }

  workspacePicker(): WorkspacePicker | undefined {
    return this.overlay?.kind === "workspace" ? this.overlay.picker : undefined;
  }

  private async runWorkspaceCommand(workspaces: WorkspacesPort, argument: string): Promise<void> {
    const [verb = "", operand] = argument.split(/\s+/).filter((word) => word !== "");
    switch (verb) {
      case "":
        this.overlay = { kind: "workspace", picker: new WorkspacePicker(await workspaces.list()) };
        return;
      case "new":
        return this.createWorkspace(workspaces, operand);
      case "default":
        return this.switchWorkspace(workspaces, undefined);
      default:
        return this.switchWorkspace(workspaces, verb);
    }
  }

  private handleWorkspaceKey(
    picker: WorkspacePicker,
    chord: Chord,
    sequence: string | undefined,
  ): void {
    const outcome = picker.handleKey(chord, sequence);
    if (outcome === "choose") this.chooseWorkspace(picker);
    else if (outcome === "close") this.overlay = undefined;
  }

  private chooseWorkspace(picker: WorkspacePicker): void {
    this.overlay = undefined;
    const chosen = picker.selected();
    const workspaces = this.options.workspaces;
    if (chosen === undefined || workspaces === undefined) return;
    this.applyWorkspaceChoice(workspaces, chosen)
      .catch((cause: unknown) => this.showNotice((cause as Error).message))
      .finally(() => this.notify());
  }

  private applyWorkspaceChoice(
    workspaces: WorkspacesPort,
    choice: WorkspacePickerChoice,
  ): Promise<void> {
    return choice.kind === "create"
      ? this.createWorkspace(workspaces, choice.slug)
      : this.switchWorkspace(workspaces, choice.slug);
  }

  private async createWorkspace(
    workspaces: WorkspacesPort,
    slug: string | undefined,
  ): Promise<void> {
    if (slug === undefined) {
      this.showNotice("new needs a name · /workspace new <slug>");
      return;
    }
    await workspaces.create(slug);
    await this.switchWorkspace(workspaces, slug);
  }

  private async switchWorkspace(
    workspaces: WorkspacesPort,
    slug: string | undefined,
  ): Promise<void> {
    await workspaces.use(slug);
    this.showNotice(`workspace → ${slug ?? "default"} · reopening`);
    this.shutdown();
  }

  private async runArcCommand(arcs: ArcsPort, argument: string): Promise<void> {
    const [verb = "", operand] = argument.split(/\s+/).filter((word) => word !== "");
    switch (verb) {
      case "":
        return this.showArcPicker(arcs);
      case "new":
        return this.createArc(arcs, operand);
      case "none":
      case "release":
        return this.bindFocusedArc(undefined);
      case "close":
        return this.closeArc(arcs, operand);
      case "abandon":
        return this.abandonArc(arcs, operand);
      default:
        return this.switchArc(arcs, verb);
    }
  }

  private async showArcPicker(arcs: ArcsPort): Promise<void> {
    const picker = new ArcPicker(await arcs.list(), this.options.focusedArc?.current());
    this.overlay = { kind: "arc", picker };
  }

  private handleArcKey(picker: ArcPicker, chord: Chord, sequence: string | undefined): void {
    const outcome = picker.handleKey(chord, sequence);
    if (outcome === "choose") this.chooseArc(picker);
    else if (outcome === "close") this.overlay = undefined;
  }

  private chooseArc(picker: ArcPicker): void {
    this.overlay = undefined;
    const chosen = picker.selected();
    if (chosen !== undefined) this.applyArcChoice(chosen);
  }

  private applyArcChoice(choice: ArcPickerChoice): void {
    const arcs = this.options.arcs;
    if (arcs === undefined) return;
    const act = (): Promise<void> => {
      switch (choice.kind) {
        case "release":
          return this.bindFocusedArc(undefined);
        case "bind":
          return this.bindFocusedArc(choice.slug);
        case "create":
          return this.createArc(arcs, choice.slug);
        case "archived":
          this.showNotice(`arc ${choice.slug} is archived · pick an active arc or /arc new`);
          return Promise.resolve();
      }
    };
    act()
      .catch((cause: unknown) => this.showNotice((cause as Error).message))
      .finally(() => this.notify());
  }

  private async bindFocusedArc(slug: string | undefined): Promise<void> {
    const focused = this.options.focusedArc;
    if (focused === undefined) {
      this.showNotice("no session pane here · /arc binds the focused session");
      return;
    }
    await focused.bind(slug);
    this.showNotice(slug === undefined ? "arc released" : `arc → ${slug}`);
  }

  private async createArc(arcs: ArcsPort, requested: string | undefined): Promise<void> {
    const taken = (await arcs.list()).map((arc) => arc.slug);
    const slug = requested ?? suggestArcSlug(this.options.focusedArc?.titleHint(), taken);
    const problem = arcSlugProblem(slug);
    if (problem !== undefined) {
      this.showNotice(problem);
      return;
    }
    if (taken.includes(slug)) {
      this.showNotice(`an arc named ${slug} already exists · /arc ${slug} switches to it`);
      return;
    }
    await arcs.create(slug);
    const focused = this.options.focusedArc;
    if (focused === undefined) {
      this.showNotice(`arc ${slug} created`);
      return;
    }
    await focused.bind(slug);
    this.showNotice(`arc → ${slug} · new`);
  }

  private async switchArc(arcs: ArcsPort, slug: string): Promise<void> {
    const found = (await arcs.list()).find((arc) => arc.slug === slug);
    if (found === undefined) {
      this.showNotice(`no arc named ${slug} · /arc new ${slug} creates it`);
      return;
    }
    if (found.status === "archived") {
      this.showNotice(`arc ${slug} is archived · /arc new starts another`);
      return;
    }
    await this.bindFocusedArc(slug);
  }

  private async closeArc(arcs: ArcsPort, requested: string | undefined): Promise<void> {
    const slug = requested ?? this.options.focusedArc?.current();
    if (slug === undefined) {
      this.showNotice("no arc to close · this session is unbound · /arc close <slug> names one");
      return;
    }
    this.showNotice(describeCloseOutcome(slug, await arcs.close(slug)));
  }

  private async abandonArc(arcs: ArcsPort, slug: string | undefined): Promise<void> {
    if (slug === undefined) {
      this.showNotice("abandon needs a name · /arc abandon <slug>");
      return;
    }
    await arcs.abandon(slug);
    this.showNotice(`arc ${slug} abandoned · archived without distilling, nothing deleted`);
  }

  openConnect(argument = ""): void {
    const port = this.options.connections;
    if (port === undefined) return;
    const model = new ConnectModel(port, {
      notify: () => this.notify(),
      chooseModel: () => this.openModelPicker(),
      notice: (text) => this.showNotice(text),
    });
    model.open(argument);
    this.overlay = { kind: "connect", model };
  }

  connectModel(): ConnectModel | undefined {
    return this.overlay?.kind === "connect" ? this.overlay.model : undefined;
  }

  private handleModelKey(picker: ModelPicker, chord: Chord, sequence: string | undefined): void {
    const outcome = picker.handleKey(chord, sequence);
    if (outcome === "choose") this.chooseModel(picker);
    else if (outcome === "close") this.overlay = undefined;
  }

  private chooseModel(picker: ModelPicker): void {
    const chosen = picker.selected();
    if (chosen === undefined) return;
    this.overlay = undefined;
    this.selectModel(chosen.reference);
  }

  private selectModel(reference: string): void {
    const port = this.options.inference;
    const switchModel = this.options.switchModel;
    if (port === undefined || switchModel === undefined) return;
    const notice = port.describe(reference);
    if (!notice.ok) {
      this.showNotice(`${notice.message} · ${notice.nextAction ?? ""}`.trim());
      return;
    }
    switchModel(reference)
      .then((text) => this.showNotice(text))
      .catch((cause: unknown) => this.showNotice((cause as Error).message))
      .finally(() => this.notify());
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

  private noticeNoRoom(where: string): void {
    this.showNotice(`no room in ${where} · close or resize a pane`);
  }

  private focusedDockSide(): DockSide {
    const focused = this.layout.focused();
    const side = focused === undefined ? undefined : this.layout.dockSideOf(focused);
    if (side !== undefined) return side;
    if (this.layout.dock("left") !== undefined) return "left";
    if (this.layout.dock("right") !== undefined) return "right";
    return "left";
  }

  private palette(): PaletteOverlay | undefined {
    return this.overlay?.kind === "palette" ? this.overlay : undefined;
  }

  private paletteFor(query: string): PaletteOverlay {
    const commandMode = paletteModeOf(query) === "commands";
    return {
      kind: "palette",
      query,
      index: 0,
      entries: this.registry
        .search(commandMode ? query.slice(1) : query)
        .filter((command) => command.needsArgs !== true)
        .filter((command) => (command.jump === true) !== commandMode)
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
        case "arcs":
          return this.options.createArcsPane?.(
            entry.id,
            this.paneChanged,
            this.intents,
            () => this.conversationSession(),
            entry.arc,
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
      this.nextArcs = nextAfter(id, "arcs", this.nextArcs);
      this.nextMemory = nextAfter(id, "memory", this.nextMemory);
      this.nextMcp = nextAfter(id, "mcp", this.nextMcp);
    }
  }

  private openInLayout(id: string): boolean {
    if (this.layout.open(id, this.screen())) return true;
    this.showNotice("no room for another pane · close or resize one");
    return false;
  }

  private openFilePane(path: string, options?: FileOpenOptions): void {
    const create = this.options.createFilePane;
    if (create === undefined) return;
    this.focusMainArea();
    const id = `file-${this.nextFile}`;
    if (!this.openInLayout(id)) return;
    this.nextFile += 1;
    this.panes.set(id, create(id, path, this.paneChanged, options));
  }

  private openBrowserPane(root: string): void {
    const create = this.options.createBrowserPane;
    if (create === undefined) return;
    const id = `browser-${this.nextBrowser}`;
    if (!this.openInLayout(id)) return;
    this.nextBrowser += 1;
    this.panes.set(id, create(id, root, this.paneChanged, this.intents));
    this.layout.dockFocused("left", this.screen());
  }

  private openSessionTreePane(): void {
    const create = this.options.createSessionTreePane;
    if (create === undefined) return;
    const id = `tree-${this.nextTree}`;
    if (!this.openInLayout(id)) return;
    this.nextTree += 1;
    this.panes.set(
      id,
      create(id, this.paneChanged, this.intents, () => this.conversationSession()),
    );
    this.layout.dockFocused("left", this.screen());
  }

  private openArcsPane(): void {
    const create = this.options.createArcsPane;
    if (create === undefined) return;
    const id = `arcs-${this.nextArcs}`;
    if (!this.openInLayout(id)) return;
    this.nextArcs += 1;
    this.panes.set(
      id,
      create(id, this.paneChanged, this.intents, () => this.conversationSession()),
    );
    this.layout.dockFocused("left", this.screen());
  }

  private openMemoryPane(): void {
    const create = this.options.createMemoryPane;
    if (create === undefined) return;
    const id = `memory-${this.nextMemory}`;
    if (!this.openInLayout(id)) return;
    this.nextMemory += 1;
    this.panes.set(id, create(id, this.paneChanged));
    this.layout.dockFocused("left", this.screen());
  }

  private openMcpPane(): void {
    const create = this.options.createMcpPane;
    if (create === undefined) return;
    const id = `mcp-${this.nextMcp}`;
    if (!this.openInLayout(id)) return;
    this.nextMcp += 1;
    this.panes.set(id, create(id, this.paneChanged));
    this.layout.dockFocused("right", this.screen());
  }

  private seedDefaultWorkspace(): void {
    this.openPane();
    this.openSessionTreePane();
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

  private focusedConversationPaneId(): string | undefined {
    const focused = this.layout.focused();
    if (focused === undefined) return undefined;
    return this.panes.get(focused)?.describe?.().kind === "conversation" ? focused : undefined;
  }

  private pointsAtDirectory(path: string): boolean {
    return (
      this.options.createBrowserPane !== undefined && this.options.isDirectory?.(path) === true
    );
  }

  private focusMainArea(): void {
    const focused = this.layout.focused();
    if (focused === undefined || this.layout.dockSideOf(focused) === undefined) return;
    const main = this.layout.panes().find((id) => this.layout.dockSideOf(id) === undefined);
    if (main !== undefined) this.layout.focus(main);
  }

  private pasteIntoOverlay(overlay: Overlay, line: string): void {
    switch (overlay.kind) {
      case "palette":
        this.overlay = this.paletteFor(overlay.query + line);
        return;
      case "model":
      case "arc":
      case "workspace":
        overlay.picker.paste(line);
        return;
      case "connect":
        overlay.model.paste(line);
        return;
      case "help":
      case "preset":
      case "preset-confirm":
        return;
    }
  }

  private routeMouse(event: PointerEvent): void {
    const overlay = this.overlay;
    if (overlay === undefined) {
      this.routePaneMouse(event);
      return;
    }
    switch (overlay.kind) {
      case "palette":
        this.routePaletteMouse(overlay, event);
        return;
      case "help":
        this.routeDismissableMouse(helpFrame(this.screen(), this.keymap.actions().length), event);
        return;
      case "preset":
        this.routePresetMouse(overlay, event);
        return;
      case "preset-confirm":
        this.routeDismissableMouse(helpFrame(this.screen(), presetConfirmRows), event);
        return;
      case "model":
        this.routePickerMouse(overlay.picker, event, () => this.chooseModel(overlay.picker));
        return;
      case "arc":
        this.routePickerMouse(overlay.picker, event, () => this.chooseArc(overlay.picker));
        return;
      case "workspace":
        this.routePickerMouse(overlay.picker, event, () => this.chooseWorkspace(overlay.picker));
        return;
      case "connect":
        this.routeConnectMouse(overlay.model, event);
        return;
    }
  }

  private routePaletteMouse(palette: PaletteOverlay, event: PointerEvent): void {
    const count = palette.entries.length;
    this.routeRows(event, paletteFrame(this.screen(), count), count, {
      hover: (row) => {
        palette.index = row;
      },
      click: (row) => {
        const chosen = palette.entries[row];
        this.overlay = undefined;
        chosen?.run();
      },
      outside: () => this.closeOverlay(),
    });
  }

  private routeDismissableMouse(frame: OverlayRowFrame, event: PointerEvent): void {
    this.routeRows(event, frame, 0, { click: () => {}, outside: () => this.closeOverlay() });
  }

  private routePresetMouse(
    overlay: { names: readonly string[]; index: number },
    event: PointerEvent,
  ): void {
    const frame = helpFrame(this.screen(), this.presetRowCount(overlay.names));
    this.routeRows(event, frame, overlay.names.length, {
      hover: (row) => {
        overlay.index = row;
      },
      click: (row) => {
        const chosen = overlay.names[row];
        if (chosen !== undefined) this.choosePreset(chosen);
      },
      outside: () => this.closeOverlay(),
    });
  }

  private presetRowCount(names: readonly string[]): number {
    const active = this.options.presets?.active();
    return names.length + (active === undefined || names.includes(active) ? 0 : 1);
  }

  private routePickerMouse(
    picker: ModelPicker | ArcPicker | WorkspacePicker,
    event: PointerEvent,
    choose: () => void,
  ): void {
    const count = picker.rows().length;
    this.routeRows(event, paletteFrame(this.screen(), count), count, {
      hover: (row) => picker.select(row),
      click: (row) => {
        picker.select(row);
        choose();
      },
      outside: () => this.closeOverlay(),
    });
  }

  private routeConnectMouse(model: ConnectModel, event: PointerEvent): void {
    const count = model.rowCount();
    this.routeRows(event, helpFrame(this.screen(), count), count, {
      click: (row) => {
        if (model.clickRow(row) === "close") this.closeOverlay();
      },
      outside: () => {
        if (model.handleKey(escapeChord, undefined) === "close") this.closeOverlay();
      },
    });
  }

  private routeRows(
    event: PointerEvent,
    frame: OverlayRowFrame,
    rowCount: number,
    rows: { hover?(row: number): void; click(row: number): void; outside(): void },
  ): void {
    const inside = containsPoint(frame, event.x, event.y);
    const row = event.y - frame.firstRowY;
    const onRow = inside && row >= 0 && row < rowCount;
    if (onRow && (event.type === "move" || event.type === "drag")) rows.hover?.(row);
    if (event.type !== "down") return;
    if (!inside) rows.outside();
    else if (onRow) rows.click(row);
  }

  private closeOverlay(): void {
    this.overlay = undefined;
  }

  dragPreview(): Rect | undefined {
    return this.paneDrag?.lifted === true ? this.paneDrag.target?.rect : undefined;
  }

  draggingPane(): string | undefined {
    return this.paneDrag?.lifted === true ? this.paneDrag.id : undefined;
  }

  private routePaneMouse(event: PointerEvent): void {
    if (this.routeDockResize(event)) return;
    if (this.routePaneDrag(event)) return;
    const hit = this.paneUnder(event.x, event.y);
    if (hit === undefined) return;
    if (event.type === "down") {
      this.layout.focus(hit.id);
      if (event.y === hit.rect.y) {
        this.paneDrag = { id: hit.id, lifted: false, target: undefined };
      }
    }
    const pane = this.panes.get(hit.id);
    const local = { x: event.x - hit.rect.x, y: event.y - hit.rect.y };
    if (pane?.handleMouse?.(local, event) === true) return;
    if (event.type === "scroll" && event.scroll !== undefined) scrollByKeys(pane, event.scroll);
  }

  private routePaneDrag(event: PointerEvent): boolean {
    const drag = this.paneDrag;
    if (drag === undefined) return false;
    if (event.type === "drag") {
      drag.lifted = true;
      drag.target = this.layout.dropTargetAt(drag.id, event.x, event.y, this.screen());
      return true;
    }
    if (event.type === "up" || event.type === "drag-end") {
      this.paneDrag = undefined;
      if (!drag.lifted) return false;
      if (drag.target !== undefined) this.layout.applyDrop(drag.id, drag.target, this.screen());
      return true;
    }
    if (event.type === "down") this.paneDrag = undefined;
    return false;
  }

  private routeDockResize(event: PointerEvent): boolean {
    if (this.dockResize !== undefined) {
      if (event.type === "drag") {
        this.layout.dragDockEdge(this.dockResize, event.x, this.screen());
        return true;
      }
      if (event.type === "up" || event.type === "drag-end") {
        this.dockResize = undefined;
        return true;
      }
      this.dockResize = undefined;
    }
    if (event.type !== "down") return false;
    const side = this.layout.dockHandleAt(event.x, this.screen());
    if (side === undefined) return false;
    this.dockResize = side;
    return true;
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
      if (!("command" in action)) continue;
      const { aliases, ...command } = action.command;
      this.registry.register({
        ...command,
        ...(aliases !== undefined && { aliases }),
        ...shortcut(name),
        run: () => action.invoke(this),
      });
    }
    for (const side of ["left", "right"] as const) {
      this.registry.register({
        name: `dock-${side}`,
        description: `dock this pane to the ${side} edge`,
        aliases: [`dock${side}`],
        run: () => this.dockPane(side),
      });
      this.registry.register({
        name: `dock-${side}-wider`,
        description: `widen the ${side} dock`,
        run: () => this.layout.growDock(side, 0.05),
      });
      this.registry.register({
        name: `dock-${side}-narrower`,
        description: `narrow the ${side} dock`,
        run: () => this.layout.growDock(side, -0.05),
      });
    }
    this.registry.register({
      name: "undock",
      description: "return this pane to the main area",
      run: () => this.undockPane(),
    });
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
        aliases: ["session-tree", "sessions"],
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
    if (this.options.createArcsPane !== undefined) {
      this.registry.register({
        name: "arcs",
        description: "open the arcs node: /arcs",
        ...shortcut("arcs.summon"),
        run: () => this.summonArcsPane(),
      });
    }
    if (this.options.workspaces !== undefined) {
      this.registry.register({
        name: "workspace",
        aliases: ["workspaces"],
        description:
          "switch or create a workspace over this root: /workspace [slug | new <slug> | default]",
        run: (args) => this.openWorkspaceCommand(args),
      });
    }
    if (this.options.arcs !== undefined) {
      this.registry.register({
        name: "arc",
        description:
          "bind this session to an arc: /arc [slug | new [slug] | none | close | abandon <slug>]",
        run: (args) => this.openArcCommand(args),
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
    if (this.options.inference !== undefined) {
      this.registry.register({
        name: "model",
        aliases: ["models"],
        description: "pick the model for this session: /model [provider/model]",
        run: (args) => this.openModelPicker(args),
      });
    }
    if (this.options.connections !== undefined) {
      this.registry.register({
        name: "connect",
        aliases: ["setup", "new-provider"],
        description: "add or verify an inference provider: /connect [target|url]",
        run: (args) => this.openConnect(args),
      });
    }
    const undoPort = this.options.undo;
    if (undoPort !== undefined) {
      this.registry.register({
        name: "undo",
        description: "undo the last agent file change",
        run: () => this.announce(undoPort.undo(), "files put back", "nothing to undo"),
      });
      this.registry.register({
        name: "redo",
        description: "redo the last undone change",
        run: () => this.announce(undoPort.redo(), "files redone", "nothing to redo"),
      });
    }
    this.registry.register({
      name: "exit",
      description: "close this pane · quits keywork if it's the last",
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
      return targets.map(({ id, title }) => {
        const distinct = (titleCounts.get(title) ?? 0) > 1 ? `${title} ${id}` : title;
        return {
          name: `go-${distinct}`,
          label: distinct,
          description: "jump to this pane",
          jump: true as const,
          run: () => this.layout.focus(id),
        };
      });
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

function pastedLine(text: string): string {
  return text.replace(/\r\n?|\n/g, " ").trim();
}

function scrollByKeys(pane: Pane | undefined, scroll: PointerScroll): void {
  if (pane?.handleKey === undefined) return;
  const chord: Chord = { name: scroll.direction, ctrl: false, shift: false, meta: false };
  const steps = wheelSteps(scroll.delta);
  for (let step = 0; step < steps; step += 1) pane.handleKey(chord, undefined);
}
