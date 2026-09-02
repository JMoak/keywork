import { toError } from "@keywork/shared";
import {
  type ActionTarget,
  appActions,
  appBindings,
  chainActions,
  stickyActions,
} from "./app-actions.ts";
import {
  type ArcCommandSeams,
  type ArcInvocation,
  applyArcChoice,
  type FocusedArcPort,
  legacyArcInvocation,
  runArcCommand,
} from "./arc-commands.ts";
import { arcChoiceOf } from "./arc-picker.ts";
import type { ArcsPort } from "./arcs.ts";
import { CommandRegistry } from "./commands.ts";
import { ConnectModel } from "./connect-model.ts";
import { registerCoreCommands } from "./core-commands.ts";
import type { Direction, Rect, Screen } from "./geometry.ts";
import { type InferenceCommandSeams, runModelCommand } from "./inference-commands.ts";
import type { ConnectionsPort, InferencePort } from "./inference-port.ts";
import { type InitialPane, initialWorkspace } from "./initial-workspace.ts";
import { Keymap } from "./keymap.ts";
import { type Chord, formatChord } from "./keys.ts";
import { type DockSide, Layout, layoutStateIds } from "./layout.ts";
import type { ModelPicker } from "./model-picker.ts";
import {
  type ArcOverlay,
  ConnectOverlay,
  HelpOverlay,
  type Overlay,
  type OverlayFrame,
  type OverlayKind,
  type PaletteMode,
  PaletteOverlay,
  PickerOverlay,
  type PresetConfirmation,
  PresetOverlay,
  type PresetPicker,
  type PresetsPort,
  pastedLine,
  SetupConfirmOverlay,
  type WorkspaceOverlay,
} from "./overlays/index.ts";
import type { FileOpenOptions, Pane, PaneDescriptor, PaneIntents } from "./pane.ts";
import {
  type ArcOrigin,
  buildPane,
  dockWeightOf,
  type PaneFactories,
  PaneIds,
  type PaneOrigin,
  type PaneRequest,
  paneKindOf,
  paneKinds,
  type SummonableKind,
  summonRequests,
} from "./pane-kinds.ts";
import { pluralize } from "./pluralize.ts";
import type { PointerEvent } from "./pointer.ts";
import { PanePointer } from "./pointer-routing.ts";
import { rotatingTip, type TipSignals } from "./tips.ts";
import {
  applyWorkspaceChoice,
  legacyWorkspaceInvocation,
  runWorkspaceCommand,
  type WorkspaceCommandSeams,
  type WorkspaceInvocation,
} from "./workspace-commands.ts";
import { type WorkspacesPort, workspaceChoiceOf } from "./workspace-picker.ts";
import {
  describeReady,
  readinessNotice,
  setupPrompt,
  type WorkspaceReadiness,
  type WorkspaceSetupPort,
} from "./workspace-setup.ts";
import { captureWorkspace, type WorkspacePane, type WorkspaceState } from "./workspace-state.ts";

export interface UndoPort {
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
}

export interface TipsOption {
  enabled: boolean;
  now?: () => number;
}

export interface AppCoreOptions extends PaneFactories {
  screen: () => Screen;
  drawnRect?: (rect: Rect, screen: Screen) => Rect;
  isDirectory?: (path: string) => boolean;
  undo?: UndoPort;
  presets?: PresetsPort;
  inference?: InferencePort;
  connections?: ConnectionsPort;
  arcs?: ArcsPort;
  focusedArc?: FocusedArcPort;
  workspaces?: WorkspacesPort;
  workspaceSetup?: WorkspaceSetupPort;
  currentModel?: () => string | undefined;
  switchModel?: (reference: string) => Promise<string>;
  tips?: TipsOption;
  restoreWorkspace?: WorkspaceState;
  initialWorkspace?: readonly InitialPane[];
  saveWorkspace?: (state: WorkspaceState) => void;
  onPaneClosed?: (id: string) => void;
  onExit: () => void;
}

export interface PaneSnapshot {
  id: string;
  title: string;
  focused: boolean;
  dock: DockSide | undefined;
  pinned: boolean;
}

export interface AppSnapshot {
  panes: PaneSnapshot[];
  held: string[];
  focused: string | undefined;
  zoomed: string | undefined;
  overlay: OverlayKind | undefined;
  paletteQuery: string;
  leaderArmed: boolean;
  costsShown: boolean;
  lastKey: string;
  notice: string;
}

export class AppCore implements ActionTarget {
  readonly layout = new Layout({ dockWeight: dockWeightOf });
  readonly keymap = new Keymap({ leader: "ctrl+k", bindings: appBindings });
  readonly registry = new CommandRegistry();
  readonly panes = new Map<string, Pane>();
  readonly intents: PaneIntents = {
    openFile: (path, options) => this.openFile(path, options),
    openSession: (sessionId, draft) => this.openPane(sessionId, draft),
    focusPane: (id) => this.focusPane(id),
    notice: (text) => this.postNotice(text),
    holdPane: (id) => this.holdPane(id),
    showPane: (id, near) => this.showPane(id, near),
    paneHeld: (id) => this.paneHeld(id),
  };
  leaderArmed = false;
  costsShown = false;
  lastKey = "";
  notice = "";
  private readonly held = new Set<string>();
  private overlay: Overlay | undefined;
  private readonly pointer = new PanePointer({
    layout: this.layout,
    screen: () => this.screen(),
    paneAt: (id) => this.panes.get(id),
    changed: () => this.touch(),
    drawnRect: (rect, screen) => this.options.drawnRect?.(rect, screen) ?? rect,
  });
  private readonly ids = new PaneIds();
  private readonly described = new Map<string, string>();
  private notify: () => void = () => {};
  private workspaceDirty = false;
  private lastSavedWorkspace = "";

  constructor(readonly options: AppCoreOptions) {
    registerCoreCommands(this);
  }

  bindNotify(notify: () => void): void {
    this.notify = notify;
  }

  start(): void {
    const saved = this.options.restoreWorkspace;
    if (saved === undefined || !this.restoreFrom(saved)) this.seedDefaultWorkspace();
    this.persistWorkspace();
  }

  screen(): Screen {
    return this.options.screen();
  }

  workspaceState(): WorkspaceState {
    return captureWorkspace(this.layout, this.panes, this.held);
  }

  snapshot(): AppSnapshot {
    const focused = this.layout.focused();
    return {
      panes: this.layout.panes().map((id) => ({
        id,
        title: this.panes.get(id)?.title().trim() ?? id,
        focused: id === focused,
        dock: this.layout.dockSideOf(id),
        pinned: this.layout.pinned(id),
      })),
      held: this.heldPanes(),
      focused,
      zoomed: this.layout.zoomed(),
      overlay: this.overlay?.kind,
      paletteQuery: this.paletteQuery,
      leaderArmed: this.leaderArmed,
      costsShown: this.costsShown,
      lastKey: this.lastKey,
      notice: this.notice,
    };
  }

  panesFocusedFirst(): string[] {
    const focused = this.layout.focused();
    const ids = this.layout.panes();
    return focused === undefined ? ids : [focused, ...ids.filter((id) => id !== focused)];
  }

  handleKey(chord: Chord, sequence: string | undefined, nowMs: number, repeat = false): void {
    this.lastKey = formatChord(chord);
    this.notice = "";
    if (chord.ctrl && chord.name === "q") {
      this.shutdown();
      return;
    }
    if (chord.name === "escape" && this.pointer.cancelDrag()) this.touch();
    else if (this.overlay !== undefined) this.overlay.handleKey(chord, sequence);
    else this.handleAppKey(chord, sequence, nowMs, repeat);
    this.persistWorkspace();
  }

  handlePaste(text: string): void {
    if (this.overlay !== undefined) {
      this.overlay.handlePaste(pastedLine(text));
      return;
    }
    const id = this.layout.focused();
    if (id !== undefined) this.panes.get(id)?.handlePaste?.(text);
  }

  handleMouse(event: PointerEvent): boolean {
    let handled = true;
    if (this.overlay !== undefined) this.overlay.handleMouse(event, this.screen());
    else handled = this.pointer.route(event);
    this.persistWorkspace();
    return handled;
  }

  runCommand(name: string): boolean {
    const ran = this.registry.run(name);
    this.persistWorkspace();
    return ran;
  }

  expireArmed(nowMs: number): void {
    this.leaderArmed = this.keymap.armed(nowMs);
  }

  openPane(resumeSessionId?: string, draft?: string, origin?: PaneOrigin): void {
    const request: PaneRequest = {
      kind: "conversation",
      ...(resumeSessionId !== undefined && { sessionId: resumeSessionId }),
      ...(draft !== undefined && { draft }),
      ...(origin !== undefined && { origin }),
    };
    this.place(
      request,
      resumeSessionId === undefined
        ? "can't open a session pane · no session could be started"
        : `can't open session ${resumeSessionId} · its store is missing or unreadable`,
    );
  }

  splitPane(arc: ArcOrigin): void {
    const source = this.focusedConversationPaneId();
    this.openPane(undefined, undefined, {
      ...(source !== undefined && { sourcePaneId: source }),
      arc,
    });
  }

  closePane(): void {
    if (this.layout.panes().length <= 1) this.showHeldPanes();
    if (this.layout.panes().length <= 1) {
      this.shutdown();
      return;
    }
    const id = this.layout.focused();
    if (id === undefined) return;
    this.panes.get(id)?.dispose?.();
    this.panes.delete(id);
    this.described.delete(id);
    this.layout.close(id);
    this.touch();
    this.options.onPaneClosed?.(id);
  }

  summon(kind: SummonableKind): void {
    const existing = [...this.panes.keys()].find((id) => paneKindOf(id) === kind);
    if (existing !== undefined) this.focusPane(existing);
    else this.place(summonRequests[kind]);
  }

  openArcPane(slug: string): void {
    const existing = this.arcPaneFor(slug);
    if (existing !== undefined) this.focusPane(existing);
    else this.placeArcPane(slug);
  }

  introduceArcPane(slug: string): void {
    if (this.arcPaneFor(slug) !== undefined) return;
    const focused = this.layout.focused();
    this.placeArcPane(slug);
    if (focused !== undefined) this.layout.focus(focused);
  }

  openPath(path: string): void {
    if (this.pointsAtDirectory(path)) this.openBrowser(path);
    else this.openFile(path);
  }

  openFile(path: string, options?: FileOpenOptions): void {
    this.place({ kind: "file", path, ...(options !== undefined && { options }) });
  }

  openBrowser(root: string): void {
    this.place({ kind: "browser", root });
  }

  focusPane(id: string): void {
    if (this.held.has(id) && !this.showPane(id)) return;
    this.layout.focus(id);
    this.touch();
  }

  holdPane(id: string): boolean {
    if (!this.layout.panes().includes(id) || this.layout.panes().length <= 1) return false;
    this.layout.close(id);
    this.held.add(id);
    this.touch();
    return true;
  }

  showPane(id: string, near?: readonly string[]): boolean {
    if (!this.held.has(id)) return this.layout.panes().includes(id);
    const focused = this.layout.focused();
    const shown = near === undefined ? this.openInMain(id) : this.openAmong(id, near);
    if (!shown) {
      this.noticeNoRoom("the main area");
      return false;
    }
    this.held.delete(id);
    if (focused !== undefined) this.layout.focus(focused);
    this.panes.get(id)?.revealed?.();
    this.touch();
    return true;
  }

  paneHeld(id: string): boolean {
    return this.held.has(id);
  }

  heldPanes(): string[] {
    return [...this.held];
  }

  focusToward(direction: Direction): void {
    this.layout.moveFocus(direction, this.screen());
    this.touch();
  }

  zoomPane(): void {
    this.layout.zoomToggle();
    this.touch();
  }

  movePane(direction: Direction): void {
    this.layout.move(direction, this.screen());
    this.touch();
  }

  cyclePane(): void {
    if (!this.layout.cycleFocused(this.screen())) this.noticeNoRoom("this pane's next home");
    this.touch();
  }

  pinPane(): void {
    const id = this.layout.focused();
    if (id === undefined) return;
    if (this.layout.pinned(id)) {
      this.unpinPane();
      return;
    }
    if (!this.layout.pinFocused()) {
      this.postNotice("pins are for docked panes · dock it first");
      return;
    }
    this.touch();
  }

  unpinPane(): void {
    if (!this.layout.unpinFocused()) {
      this.postNotice("pins are for docked panes · dock it first");
      return;
    }
    this.touch();
  }

  dockPane(side: DockSide): void {
    if (!this.layout.dockFocused(side, this.screen())) this.noticeNoRoom(`the ${side} dock`);
    this.touch();
  }

  undockPane(): void {
    if (!this.layout.undockFocused(this.screen())) this.noticeNoRoom("the main area");
    this.touch();
  }

  resizeDock(delta: number): void {
    this.resizeDockSide(this.focusedDockSide(), delta);
  }

  resizeDockSide(side: DockSide, delta: number): void {
    this.layout.growDock(side, delta);
    this.touch();
  }

  resizePane(delta: number): void {
    this.layout.resizeFocused(delta);
    this.touch();
  }

  dragPreview(): Rect | undefined {
    return this.pointer.dragPreview();
  }

  draggingPane(): string | undefined {
    return this.pointer.draggingPane();
  }

  toggleCosts(): void {
    this.costsShown = !this.costsShown;
    this.postNotice(this.costsShown ? "spend shown in pane headers" : "spend hidden");
  }

  toggleHelp(): void {
    this.overlay = this.helpVisible ? undefined : new HelpOverlay(this.keymap, this.overlaySeams);
  }

  openPalette(initialQuery = ""): void {
    this.overlay = new PaletteOverlay(this.registry, initialQuery, this.overlaySeams);
  }

  openPresetPicker(): void {
    const port = this.options.presets;
    if (port === undefined) return;
    this.overlay = new PresetOverlay(port, {
      ...this.overlaySeams,
      confirm: (confirmation) => {
        this.overlay = confirmation;
      },
    });
  }

  openModelPicker(argument = ""): void {
    const inference = this.options.inference;
    if (inference === undefined) return;
    const seams: InferenceCommandSeams = {
      inference,
      currentModel: this.options.currentModel,
      switchModel: this.options.switchModel,
      notice: (text) => this.postNotice(text),
      showPicker: (picker) => {
        this.overlay = new PickerOverlay("model", picker, {
          ...this.overlaySeams,
          choose: (row) => this.settle(runModelCommand(seams, row.choice.reference)),
        });
      },
    };
    this.settle(runModelCommand(seams, argument));
  }

  openArcCommand(argument = ""): void {
    this.arcCommand(legacyArcInvocation(argument));
  }

  arcCommand(invocation: ArcInvocation): void {
    const arcs = this.options.arcs;
    if (arcs === undefined) return;
    const blocker = this.workspaceBlocker();
    if (blocker !== undefined) {
      this.postNotice(blocker);
      return;
    }
    const seams: ArcCommandSeams = {
      arcs,
      focusedArc: this.options.focusedArc,
      notice: (text) => this.postNotice(text),
      openArcPane: (slug) => this.openArcPane(slug),
      showPicker: (picker) => {
        this.overlay = new PickerOverlay("arc", picker, {
          ...this.overlaySeams,
          choose: (row) => this.settle(applyArcChoice(seams, arcChoiceOf(row))),
        });
      },
    };
    this.settle(runArcCommand(seams, invocation));
  }

  openWorkspaceCommand(argument = ""): void {
    this.workspaceCommand(legacyWorkspaceInvocation(argument));
  }

  workspaceCommand(invocation: WorkspaceInvocation): void {
    const workspaces = this.options.workspaces;
    if (workspaces === undefined) return;
    const seams: WorkspaceCommandSeams = {
      workspaces,
      notice: (text) => this.postNotice(text),
      shutdown: () => this.shutdown(),
      showPicker: (picker) => {
        this.overlay = new PickerOverlay("workspace", picker, {
          ...this.overlaySeams,
          choose: (row) => this.settle(applyWorkspaceChoice(seams, workspaceChoiceOf(row))),
        });
      },
    };
    this.settle(runWorkspaceCommand(seams, invocation));
  }

  openWorkspaceSetup(): void {
    const port = this.options.workspaceSetup;
    if (port === undefined) return;
    const readiness = port.readiness();
    if (setupPrompt(readiness) === undefined) {
      this.postNotice(describeReady(readiness));
      return;
    }
    this.overlay = new SetupConfirmOverlay(port, readiness, {
      ...this.overlaySeams,
      shutdown: () => this.shutdown(),
    });
  }

  openConnect(argument = ""): void {
    const port = this.options.connections;
    if (port === undefined) return;
    const model = new ConnectModel(port, {
      notify: () => this.notify(),
      chooseModel: () => this.openModelPicker(),
      notice: (text) => this.postNotice(text),
      currentProvider: () => this.options.currentModel?.()?.split("/")[0],
    });
    model.open(argument);
    this.overlay = new ConnectOverlay(model, this.overlaySeams);
  }

  overlayFrame(): OverlayFrame | undefined {
    return this.overlay?.frame(this.screen());
  }

  get overlayOpen(): boolean {
    return this.overlay !== undefined;
  }

  get helpVisible(): boolean {
    return this.overlay?.kind === "help";
  }

  helpOverlay(): HelpOverlay | undefined {
    return this.overlay?.kind === "help" ? this.overlay : undefined;
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

  get paletteMode(): PaletteMode {
    return this.palette()?.mode ?? "go";
  }

  paletteMatches(): PaletteOverlay["entries"] {
    return this.palette()?.entries ?? [];
  }

  presetPicker(): PresetPicker | undefined {
    return this.overlay?.kind === "preset" ? this.overlay.picker() : undefined;
  }

  presetConfirmation(): PresetConfirmation | undefined {
    return this.overlay?.kind === "preset-confirm" ? this.overlay.confirmation() : undefined;
  }

  modelPicker(): ModelPicker | undefined {
    return this.overlay?.kind === "model" ? this.overlay.picker : undefined;
  }

  arcPicker(): ArcOverlay["picker"] | undefined {
    return this.overlay?.kind === "arc" ? this.overlay.picker : undefined;
  }

  workspacePicker(): WorkspaceOverlay["picker"] | undefined {
    return this.overlay?.kind === "workspace" ? this.overlay.picker : undefined;
  }

  connectModel(): ConnectModel | undefined {
    return this.overlay?.kind === "connect" ? this.overlay.model : undefined;
  }

  setupConfirmation(): WorkspaceReadiness | undefined {
    return this.overlay?.kind === "setup" ? this.overlay.readiness : undefined;
  }

  workspaceBlocker(): string | undefined {
    const readiness = this.options.workspaceSetup?.readiness();
    return readiness === undefined ? undefined : readinessNotice(readiness);
  }

  postNotice(text: string): void {
    this.notice = text;
    this.notify();
  }

  tip(): string | undefined {
    const tips = this.options.tips;
    if (tips === undefined || !tips.enabled) return undefined;
    return rotatingTip(this.tipSignals(), (tips.now ?? Date.now)());
  }

  private tipSignals(): TipSignals {
    const kinds = new Set([...this.panes.keys()].map(paneKindOf));
    return {
      paneCount: this.layout.panes().length,
      costsShown: this.costsShown,
      memoryUntouched: this.options.createMemoryPane !== undefined && !kinds.has("memory"),
      arcsUntouched: this.options.arcs !== undefined && !kinds.has("arc") && !kinds.has("arcs"),
    };
  }

  settle(work: Promise<unknown>): void {
    work
      .catch((cause: unknown) => this.postNotice(toError(cause).message))
      .finally(() => this.notify());
  }

  shutdown(): void {
    this.touch();
    this.persistWorkspace();
    for (const pane of this.panes.values()) pane.dispose?.();
    this.options.onExit();
  }

  private readonly overlaySeams = {
    dismiss: (): void => {
      this.overlay = undefined;
    },
    screen: (): Screen => this.screen(),
    notice: (text: string): void => this.postNotice(text),
  };

  private handleAppKey(
    chord: Chord,
    sequence: string | undefined,
    nowMs: number,
    repeat: boolean,
  ): void {
    const result = this.keymap.press(chord, nowMs, repeat);
    this.leaderArmed = result.type === "leader-pending";
    if (result.type === "pass") {
      const id = this.layout.focused();
      if (id !== undefined) this.panes.get(id)?.handleKey?.(chord, sequence);
      return;
    }
    if (result.type !== "action") return;
    appActions[result.action]?.invoke(this);
    if (stickyActions.has(result.action)) {
      this.keymap.arm(nowMs, chainActions);
      this.leaderArmed = true;
    }
  }

  private palette(): PaletteOverlay | undefined {
    return this.overlay?.kind === "palette" ? this.overlay : undefined;
  }

  private place(request: PaneRequest, refusedNotice?: string): Pane | undefined {
    const { home } = paneKinds[request.kind];
    if (home === "main") this.focusMainArea();
    const id = this.ids.mint(request.kind);
    if (!this.layout.open(id, this.screen())) {
      this.postNotice("no room for another pane · close or resize one");
      return undefined;
    }
    const pane = buildPane(this.options, this.buildSeams, id, request);
    if (pane === undefined) {
      this.layout.close(id);
      if (refusedNotice !== undefined) this.postNotice(refusedNotice);
      return undefined;
    }
    this.adopt(id, pane);
    if (home !== "main") this.layout.dockFocused(home, this.screen());
    this.persistWorkspace();
    this.notify();
    return pane;
  }

  private adopt(id: string, pane: Pane): void {
    this.ids.adopt(id);
    this.panes.set(id, pane);
    this.described.set(id, describedAs(pane));
    this.touch();
  }

  private readonly buildSeams = {
    notifierFor: (id: string) => (): void => {
      this.noteDescribed(id);
      this.notify();
    },
    commands: this.registry,
    intents: this.intents,
    conversationSession: (): string | undefined => this.conversationSession(),
  };

  private noteDescribed(id: string): void {
    const pane = this.panes.get(id);
    if (pane === undefined) return;
    const current = describedAs(pane);
    if (current === this.described.get(id)) return;
    this.described.set(id, current);
    this.touch();
    this.persistWorkspace();
  }

  private touch(): void {
    this.workspaceDirty = true;
  }

  private persistWorkspace(): void {
    const save = this.options.saveWorkspace;
    if (save === undefined || !this.workspaceDirty) return;
    this.workspaceDirty = false;
    const state = this.workspaceState();
    const fingerprint = JSON.stringify(state);
    if (fingerprint === this.lastSavedWorkspace) return;
    this.lastSavedWorkspace = fingerprint;
    save(state);
  }

  private restoreFrom(state: WorkspaceState): boolean {
    const layoutIds = new Set(layoutStateIds(state.layout));
    const failed: string[] = [];
    const revive = (entry: WorkspacePane): boolean => {
      try {
        const pane = buildPane(this.options, this.buildSeams, entry.id, entry);
        if (pane !== undefined) this.adopt(entry.id, pane);
        return pane !== undefined;
      } catch {
        failed.push(entry.id);
        return false;
      }
    };
    for (const entry of state.panes) {
      if (layoutIds.has(entry.id)) revive(entry);
    }
    if (this.panes.size === 0) return false;
    for (const entry of state.held) {
      if (revive(entry)) this.held.add(entry.id);
    }
    if (failed.length > 0) {
      this.postNotice(
        `couldn't restore ${pluralize(failed.length, "pane")} · ${failed.join(", ")}`,
      );
    }
    this.layout.load(state.layout);
    for (const id of this.layout.panes()) {
      if (!this.panes.has(id)) this.layout.close(id);
    }
    return true;
  }

  private openInMain(id: string): boolean {
    this.focusMainArea();
    return this.layout.open(id, this.screen());
  }

  private openAmong(id: string, near: readonly string[]): boolean {
    const anchor = this.anchorAmong(near);
    if (anchor !== undefined) return this.layout.open(id, this.screen(), anchor);
    return this.layout.openAtEdge(id, this.edgeToward(near), this.screen());
  }

  private anchorAmong(near: readonly string[]): string | undefined {
    const shownInMain = (id: string): boolean =>
      this.layout.panes().includes(id) && this.layout.dockSideOf(id) === undefined;
    const candidates = near.filter(shownInMain);
    return this.layout.recentlyFocused().find((id) => candidates.includes(id)) ?? candidates[0];
  }

  private edgeToward(near: readonly string[]): DockSide {
    for (const id of near) {
      const side = this.layout.dockSideOf(id);
      if (side !== undefined) return side;
    }
    return "left";
  }

  private showHeldPanes(): void {
    for (const id of this.heldPanes()) this.showPane(id);
  }

  private seedDefaultWorkspace(): void {
    for (const entry of this.options.initialWorkspace ?? initialWorkspace) this.seed(entry);
    this.focusMainArea();
  }

  private seed(entry: InitialPane): void {
    if (entry.kind === "conversation") {
      this.openPane();
      return;
    }
    if (this.place(summonRequests[entry.kind]) !== undefined && entry.pinned) {
      this.layout.pinFocused();
    }
  }

  private conversationSession(): string | undefined {
    for (const id of this.panesFocusedFirst()) {
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

  private arcPaneFor(slug: string): string | undefined {
    for (const [id, pane] of this.panes) {
      const descriptor = pane.describe?.();
      if (descriptor?.kind === "arc" && descriptor.arc === slug) return id;
    }
    return undefined;
  }

  private placeArcPane(slug: string): void {
    const dock = this.dockForArcPane();
    if (this.place({ kind: "arc", arc: slug }) === undefined) return;
    if (dock !== undefined) this.layout.dockFocused(dock, this.screen());
  }

  private dockForArcPane(): DockSide | undefined {
    const arcsNode = [...this.panes.keys()].find((id) => paneKindOf(id) === "arcs");
    const besideArcsNode = arcsNode === undefined ? undefined : this.layout.dockSideOf(arcsNode);
    if (besideArcsNode !== undefined) return besideArcsNode;
    return (["left", "right"] as const).find((side) => this.layout.dock(side) !== undefined);
  }

  private focusMainArea(): void {
    const focused = this.layout.focused();
    if (focused === undefined || this.layout.dockSideOf(focused) === undefined) return;
    const main = this.layout.panes().find((id) => this.layout.dockSideOf(id) === undefined);
    if (main !== undefined) this.layout.focus(main);
  }

  private focusedDockSide(): DockSide {
    const focused = this.layout.focused();
    const side = focused === undefined ? undefined : this.layout.dockSideOf(focused);
    if (side !== undefined) return side;
    if (this.layout.dock("left") !== undefined) return "left";
    if (this.layout.dock("right") !== undefined) return "right";
    return "left";
  }

  private noticeNoRoom(where: string): void {
    this.postNotice(`no room in ${where} · close or resize a pane`);
  }
}

function describedAs(pane: Pane): string {
  const descriptor: PaneDescriptor | undefined = pane.describe?.();
  return JSON.stringify(descriptor ?? null);
}
