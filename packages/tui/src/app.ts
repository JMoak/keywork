import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type Agent,
  checkpointForPrompt,
  type Message,
  type SessionTreeNode,
  type ToolCallPart,
  type ToolGuard,
} from "@keywork/engine";
import {
  Box,
  type CliRenderer,
  createCliRenderer,
  type KeyEvent,
  type MouseEvent,
  type PasteEvent,
  Text,
} from "@opentui/core";
import { AppCore, bindingHelp, helpFrame, type PresetsPort, paletteFrame } from "./app-core.ts";
import { promptAnchor } from "./backtrack.ts";
import { BrowserPane } from "./browser-pane.ts";
import { paneBorder, rampPositions } from "./chroma.ts";
import type { CommandSpec } from "./commands.ts";
import type { ConversationPorts, ForkOutcome, Titler } from "./conversation-model.ts";
import { ConversationPane } from "./conversation-pane.ts";
import {
  type ConversationTarget,
  type ExtensionsPort,
  extensionFailureNotice,
  registerExtensions,
} from "./extension-commands.ts";
import { FilePane } from "./file-pane.ts";
import { FlavorSwitch, registerFlavorCommands, startupFlavors } from "./flavor.ts";
import type { Keymap } from "./keymap.ts";
import { chordOf } from "./keys.ts";
import { minPaneSize, type Rect, type Screen } from "./layout.ts";
import { type Closer, closeOnce, defaultCloseTimeoutMs, runClosers } from "./lifecycle.ts";
import { McpPane, type McpPanePort, mcpDropWatcher } from "./mcp-pane.ts";
import { MemoryPane, type MemoryPanePort } from "./memory-pane.ts";
import { type PageThresholdOverrides, resolvePageThresholds } from "./page.ts";
import type { FileOpenOptions, PaneView } from "./pane.ts";
import { type PointerEvent, pointerEventOf } from "./pointer.ts";
import { SessionTreePane, type SessionTreePort } from "./session-tree-pane.ts";
import type { Theme, ThemeOverrides } from "./theme.ts";
import { clipLine, trayRows } from "./tray.ts";
import { parseWorkspaceState, type WorkspacePane, type WorkspaceState } from "./workspace-state.ts";

export interface CheckpointsPort {
  capture(): Promise<void>;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  restoreTo(tree: string): Promise<void>;
}

export interface SessionAttachment {
  id: string;
  name?: string;
  history: readonly Message[];
  replay(bus: Agent["bus"]): void;
  append(message: Message): Promise<void>;
  rename?(name: string): Promise<void>;
}

export interface SessionPort {
  open(id: string): Promise<SessionAttachment | undefined>;
  create(): Promise<SessionAttachment | undefined>;
  release?(sessionId: string): void;
}

export interface WorkspacePort {
  load(): Promise<unknown>;
  save(state: WorkspaceState): void;
  seal(): void;
}

export interface AgentSeams {
  sessionId(): string | undefined;
  discloseRetrieval(text: string): void;
  bus?: Agent["bus"];
}

export type AgentFactory = (
  guard: ToolGuard,
  history?: readonly Message[],
  seams?: AgentSeams,
  agentName?: string,
) => Agent;

export interface SessionTurn {
  sessionId: string;
  history: readonly Message[];
}

export interface AppOptions {
  themeOverrides?: ThemeOverrides;
  page?: PageThresholdOverrides;
  agentFactory?: AgentFactory;
  afterTurn?: (turn: SessionTurn) => Promise<readonly Message[]>;
  closers?: readonly Closer[];
  closeTimeoutMs?: number;
  createRenderer?: () => Promise<CliRenderer>;
  exit?: (code: number) => void;
  presets?: PresetsPort;
  titler?: Titler;
  statusLabel?: string | (() => string);
  checkpoints?: CheckpointsPort;
  workspace?: WorkspacePort;
  sessions?: SessionPort;
  sessionTrees?: SessionTreePort;
  memory?: MemoryPanePort;
  mcp?: McpPanePort;
  extensions?: ExtensionsPort;
}

export async function runApp(options: AppOptions = {}): Promise<void> {
  const flavors = new FlavorSwitch(startupFlavors(options.themeOverrides));
  const pageThresholds = resolvePageThresholds(options.page);
  const restored = await loadRestorePlan(options);
  const renderer = await (options.createRenderer ?? defaultRenderer)();
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const screen = (): Screen => ({
    width: Math.max(0, renderer.width - 2 * frameChrome.border),
    height: Math.max(0, renderer.height - 2 * frameChrome.border - frameChrome.statusRows),
  });
  const checkpoints = options.checkpoints;
  const attachments = restored?.attachments ?? new Map<string, SessionAttachment>();
  const trees = options.sessionTrees;
  const treePort =
    trees === undefined ? undefined : attachOnFork(trees, options.sessions, attachments);
  const memoryPort = options.memory;
  const mcpPort = options.mcp;
  const agentSwitchers = new Map<string, (agentName: string | undefined) => boolean>();
  const paneSessions = paneSessionIndex(options.sessions);
  let closed = false;
  let armedExpiry: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeMcp: (() => void) | undefined;
  let releaseFatalGuards: () => void = () => {};
  const core = new AppCore({
    screen,
    createPane: (id, notify, commands, resumeSessionId, draft) => {
      let pane: ConversationPane | undefined;
      const guard: ToolGuard = {
        confirm: (call) => pane?.confirmMutation(call) ?? Promise.resolve(true),
        ...(checkpoints !== undefined && { beforeMutation: () => checkpoints.capture() }),
      };
      const attachment =
        resumeSessionId === undefined ? undefined : attachments.get(resumeSessionId);
      if (resumeSessionId !== undefined) attachments.delete(resumeSessionId);
      const seams: AgentSeams = {
        sessionId: () => pane?.sessionId,
        discloseRetrieval: (text) => pane?.discloseRetrieval(text),
      };
      const agent = options.agentFactory?.(guard, attachment?.history, seams);
      let liveSession: SessionAttachment | undefined;
      const titler = persistingTitler(options.titler, () => liveSession);
      const ports: ConversationPorts = {
        readFile: readWorkspaceFile,
        forkAtPrompt: (ordinal, promptDraft) =>
          forkAtPrompt(
            treePort,
            (sessionId, forkDraft) => core.openPane(sessionId, forkDraft),
            checkpoints,
            pane?.sessionId,
            ordinal,
            promptDraft,
          ),
      };
      const created = new ConversationPane(id, agent, notify, titler, commands, {
        ports,
        page: pageThresholds,
        ...(draft !== undefined && { initialDraft: draft }),
      });
      pane = created;
      paneSessions.bind(
        id,
        () => created.sessionId,
        () => created.currentAgent()?.busy() ?? false,
      );
      agentSwitchers.set(id, (agentName) => {
        const factory = options.agentFactory;
        const current = created.currentAgent();
        if (factory === undefined || current === undefined || current.busy()) return false;
        created.swapAgent(
          factory(guard, current.history(), { ...seams, bus: current.bus }, agentName),
        );
        return true;
      });
      const wireSession = (adopted: SessionAttachment): void => {
        liveSession = adopted;
        adoptSession(created, agent, adopted);
        if (agent === undefined) return;
        bindSessionLifecycle({
          pane: created,
          agent,
          attachment: adopted,
          ...(options.afterTurn !== undefined && { afterTurn: options.afterTurn }),
          rebuild: (history) =>
            options.agentFactory?.(guard, history, { ...seams, bus: agent.bus }),
        });
      };
      if (attachment !== undefined) wireSession(attachment);
      else if (resumeSessionId === undefined && agent !== undefined) {
        startFreshSession(options.sessions, notify, wireSession, () => !created.disposed());
      }
      return created;
    },
    createFilePane: (id, path, notify, options) =>
      new FilePane(id, process.cwd(), path, notify, options),
    createBrowserPane: (id, root, notify, intents) =>
      new BrowserPane(id, resolve(process.cwd(), root), notify, intents),
    ...(treePort !== undefined && {
      createSessionTreePane: (id, notify, intents, targetSession, sessionId) =>
        new SessionTreePane(id, notify, intents, treePort, targetSession, {
          ...(sessionId !== undefined && { sessionId }),
          presence: paneSessions,
        }),
    }),
    ...(memoryPort !== undefined && {
      createMemoryPane: (id: string, notify: () => void) => new MemoryPane(id, notify, memoryPort),
    }),
    ...(mcpPort !== undefined && {
      createMcpPane: (id: string, notify: () => void) => new McpPane(id, notify, mcpPort),
    }),
    isDirectory: (path) =>
      statSync(resolve(process.cwd(), path), { throwIfNoEntry: false })?.isDirectory() === true,
    ...(checkpoints !== undefined && { undo: checkpoints }),
    ...(options.presets !== undefined && { presets: options.presets }),
    ...(restored !== undefined && { restoreWorkspace: restored.state }),
    ...(options.workspace !== undefined && {
      saveWorkspace: (state: WorkspaceState) => options.workspace?.save(state),
    }),
    onPaneClosed: (id) => {
      agentSwitchers.delete(id);
      paneSessions.closed(id);
    },
    onExit: closeOnce(() => {
      closed = true;
      releaseFatalGuards();
      if (armedExpiry !== undefined) clearTimeout(armedExpiry);
      unsubscribeMcp?.();
      renderer.destroy();
      options.workspace?.seal();
      void runClosers(
        options.closers ?? [],
        options.closeTimeoutMs ?? defaultCloseTimeoutMs,
        (error) => console.error(error.message),
      ).finally(() => exit(0));
    }),
  });

  core.registry.register(
    doctorCommand({
      logFile: crashLogFile,
      exists: (path) => statKind(path)?.isFile() === true,
      openFile: core.intents.openFile,
      notice: (text) => core.postNotice(text),
    }),
  );
  unsubscribeMcp = mcpPort?.subscribe?.(mcpDropWatcher((text) => core.postNotice(text)));
  if (options.extensions !== undefined) {
    registerExtensions(core.registry, options.extensions, {
      conversation: () => conversationTarget(core, agentSwitchers),
      notice: (text) => core.postNotice(text),
    });
    const failureNote = extensionFailureNotice(options.extensions.failures);
    if (failureNote !== undefined) core.postNotice(failureNote);
  }

  const watchArmedExpiry = (): void => {
    if (armedExpiry !== undefined) clearTimeout(armedExpiry);
    if (!core.leaderArmed) return;
    armedExpiry = setTimeout(() => {
      core.expireArmed(performance.now());
      render();
    }, core.keymap.timeoutMs + 50);
    armedExpiry.unref?.();
  };

  // OpenTUI dispatches mouse events through a hit grid of renderable ids; ids of
  // renderables destroyed by a frame rebuild resolve to nothing and the event is
  // dropped before reaching root. This persistent transparent plane renders above
  // every frame, so hits always resolve to a live renderable that bubbles to root.
  renderer.root.add(
    Box({
      id: pointerPlaneId,
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: pointerPlaneZIndex,
    }),
  );

  const paintFrame = (): void => {
    const theme = flavors.theme;
    watchArmedExpiry();
    discardFrame(renderer.root);
    renderer.root.add(
      Box(
        {
          flexDirection: "column",
          flexGrow: 1,
          width: "100%",
          height: "100%",
          backgroundColor: theme.background,
          border: true,
          borderStyle: "rounded",
          borderColor: core.leaderArmed ? theme.accent : theme.border,
        },
        buildBody(core, theme, screen()),
        statusBar(core, theme, options.statusLabel),
      ),
    );
    if (core.helpVisible) renderer.root.add(helpOverlay(core.keymap, theme, screen()));
    if (core.paletteOpen) renderer.root.add(paletteOverlay(core, theme, screen()));
    const preset = presetOverlay(core, theme, screen());
    if (preset !== undefined) renderer.root.add(preset);
    renderer.requestRender();
  };

  let frameQueued = false;
  const render = (): void => {
    if (closed || frameQueued) return;
    frameQueued = true;
    queueMicrotask(() => {
      frameQueued = false;
      if (closed) return;
      try {
        paintFrame();
      } catch (cause) {
        recordCrash("render", cause);
      }
    });
  };

  const contain = (scope: string, work: () => void): void => {
    try {
      work();
    } catch (cause) {
      recordCrash(scope, cause);
      core.postNotice(`recovered from an internal error · details in ${crashLogFile}`);
    }
  };

  const crashStorm = crashStormGate();
  const onUncaught = (cause: unknown): void => {
    recordCrash("uncaught", cause);
    if (crashStorm(performance.now())) {
      try {
        renderer.destroy();
      } catch {}
      console.error(`keywork hit repeated fatal errors · details in ${crashLogFile}`);
      exit(1);
      return;
    }
    try {
      core.postNotice(`recovered from an internal error · details in ${crashLogFile}`);
      render();
    } catch {}
  };
  const onRejection = (cause: unknown): void => {
    recordCrash("rejection", cause);
  };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    contain("key", () => {
      const chord = chordOf(key);
      if (chord === undefined) return;
      core.handleKey(chord, key.sequence, performance.now(), key.eventType === "repeat");
    });
    render();
  });

  renderer.keyInput.on("paste", (event: PasteEvent) => {
    contain("paste", () => core.handlePaste(new TextDecoder().decode(event.bytes)));
    render();
  });

  renderer.root.onMouse = (event: MouseEvent) => {
    let pointer: PointerEvent | undefined;
    contain("mouse", () => {
      pointer = pointerEventOf(event);
      if (pointer === undefined) return;
      core.handleMouse(
        { ...pointer, x: pointer.x - frameChrome.border, y: pointer.y - frameChrome.border },
        performance.now(),
      );
    });
    if (pointer !== undefined && mouseRepaints(core, pointer)) render();
  };

  renderer.on("resize", () => render());

  releaseFatalGuards = (): void => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
  };

  registerFlavorCommands(core.registry, flavors, {
    repaint: render,
    notice: (text) => core.postNotice(text),
  });
  renderer.auto();
  core.bindNotify(render);
  core.start();
  render();
}

export const crashLogFile = join(homedir(), ".keywork", "tui-crash.log");

export interface DoctorDeps {
  logFile: string;
  exists(path: string): boolean;
  openFile(path: string, options?: FileOpenOptions): void;
  notice(text: string): void;
}

export function doctorCommand(deps: DoctorDeps): CommandSpec {
  return {
    name: "doctor",
    aliases: ["crashlog"],
    description: "open the crash log: /doctor",
    run: () => {
      if (deps.exists(deps.logFile)) deps.openFile(deps.logFile, { atEnd: true });
      else deps.notice("no crashes recorded · nothing to show");
    },
  };
}

function recordCrash(scope: string, cause: unknown): void {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  try {
    mkdirSync(dirname(crashLogFile), { recursive: true });
    appendFileSync(
      crashLogFile,
      `${new Date().toISOString()} [${scope}] ${error.stack ?? error.message}\n`,
    );
  } catch {}
}

const crashStormLimit = { count: 20, windowMs: 5000 };

function crashStormGate(): (nowMs: number) => boolean {
  let recent: number[] = [];
  return (nowMs) => {
    recent = [...recent.filter((at) => nowMs - at < crashStormLimit.windowMs), nowMs];
    return recent.length >= crashStormLimit.count;
  };
}

const frameChrome = { border: 1, statusRows: 1 } as const;
export const pointerPlaneId = "pointer-plane";
const pointerPlaneZIndex = 1000;

interface DiscardableFrame {
  getChildren(): ReadonlyArray<{ id?: string; destroyRecursively(): void }>;
}

// OpenTUI frees native text buffers only in destroy; remove() merely detaches,
// leaking Zig-side allocations until createTextBuffer fails and the app dies.
export function discardFrame(root: DiscardableFrame): void {
  for (const child of [...root.getChildren()]) {
    if (child.id !== pointerPlaneId) child.destroyRecursively();
  }
}

function mouseRepaints(core: AppCore, pointer: PointerEvent): boolean {
  if (pointer.type !== "move") return true;
  return core.paletteOpen || core.helpVisible || core.draggingPane() !== undefined;
}

function defaultRenderer(): Promise<CliRenderer> {
  return createCliRenderer({ exitOnCtrlC: false, enableMouseMovement: true });
}

interface RestorePlan {
  state: WorkspaceState;
  attachments: Map<string, SessionAttachment>;
}

async function loadRestorePlan(options: AppOptions): Promise<RestorePlan | undefined> {
  if (options.workspace === undefined) return undefined;
  const state = parseWorkspaceState(await options.workspace.load());
  if (state === undefined) return undefined;
  const attachments = new Map<string, SessionAttachment>();
  const panes: WorkspacePane[] = [];
  for (const pane of state.panes) {
    if (await restorable(pane, options.sessions, attachments)) panes.push(pane);
  }
  if (panes.length === 0) return undefined;
  return { state: { ...state, panes }, attachments };
}

async function restorable(
  pane: WorkspacePane,
  sessions: SessionPort | undefined,
  attachments: Map<string, SessionAttachment>,
): Promise<boolean> {
  switch (pane.kind) {
    case "conversation": {
      if (pane.sessionId === undefined) return true;
      const attachment = await sessions?.open(pane.sessionId);
      if (attachment === undefined) return false;
      attachments.set(pane.sessionId, attachment);
      return true;
    }
    case "file":
      return statKind(resolve(process.cwd(), pane.path))?.isFile() === true;
    case "browser":
      return statKind(pane.root)?.isDirectory() === true;
    case "session-tree":
    case "memory":
    case "mcp":
      return true;
  }
}

function statKind(path: string) {
  return statSync(path, { throwIfNoEntry: false });
}

function readWorkspaceFile(path: string): string | undefined {
  try {
    return readFileSync(resolve(process.cwd(), path), "utf8");
  } catch {
    return undefined;
  }
}

export async function forkAtPrompt(
  trees: SessionTreePort | undefined,
  open: (sessionId: string | undefined, draft: string) => void,
  checkpoints: CheckpointsPort | undefined,
  sessionId: string | undefined,
  ordinal: number,
  draft: string,
): Promise<ForkOutcome> {
  if (trees === undefined || sessionId === undefined) return { forked: false };
  const view = await trees.load(sessionId);
  if (view === undefined) return { forked: false };
  const anchor = promptAnchor(view.roots, ordinal);
  if (anchor === undefined) return { forked: false };
  if (anchor.parentId === null) {
    open(undefined, draft);
    return { forked: true, note: await restoreForkedFiles(checkpoints, view.roots, ordinal) };
  }
  const forked = await trees.fork(sessionId, anchor.parentId);
  if (forked === undefined) return { forked: false };
  open(forked, draft);
  return { forked: true, note: await restoreForkedFiles(checkpoints, view.roots, ordinal) };
}

const unchangedFilesNote = "forked · files untouched";

async function restoreForkedFiles(
  checkpoints: CheckpointsPort | undefined,
  roots: readonly SessionTreeNode[],
  ordinal: number,
): Promise<string> {
  if (checkpoints === undefined) return unchangedFilesNote;
  const checkpoint = checkpointForPrompt(roots, ordinal);
  if (!checkpoint.restorable) return unchangedFilesNote;
  try {
    await checkpoints.restoreTo(checkpoint.tree);
    return "files put back to that point";
  } catch (cause) {
    return `forked · file restore failed: ${(cause as Error).message}`;
  }
}

let shellConfirmSequence = 0;

function shellConfirmCall(command: string): ToolCallPart {
  shellConfirmSequence += 1;
  return {
    type: "tool-call",
    callId: `command-shell-${shellConfirmSequence}`,
    name: "bash",
    arguments: { command },
  };
}

function conversationTarget(
  core: AppCore,
  switchers: ReadonlyMap<string, (agentName: string | undefined) => boolean>,
): ConversationTarget | undefined {
  const focused = core.layout.focused();
  const ids = core.layout.panes();
  const ordered = focused === undefined ? ids : [focused, ...ids.filter((id) => id !== focused)];
  for (const id of ordered) {
    const pane = core.panes.get(id);
    if (!(pane instanceof ConversationPane)) continue;
    return {
      confirmShell: (command) => pane.confirmMutation(shellConfirmCall(command)),
      submitPrompt: (text) => pane.submitPrompt(text),
      switchAgent: (agentName) => switchers.get(id)?.(agentName) ?? false,
    };
  }
  return undefined;
}

export function attachOnFork(
  trees: SessionTreePort,
  sessions: SessionPort | undefined,
  attachments: Map<string, SessionAttachment>,
): SessionTreePort {
  const escrow = async (sessionId: string): Promise<boolean> => {
    if (sessions === undefined) return false;
    const attachment = await sessions.open(sessionId);
    if (attachment === undefined) return false;
    escrowUntilClaimed(attachments, sessions, sessionId, attachment);
    return true;
  };
  return {
    ...trees,
    fork: async (sessionId, entryId) => {
      const forkedId = await trees.fork(sessionId, entryId);
      if (forkedId !== undefined) await escrow(forkedId);
      return forkedId;
    },
    attach: escrow,
  };
}

function escrowUntilClaimed(
  attachments: Map<string, SessionAttachment>,
  sessions: SessionPort,
  sessionId: string,
  attachment: SessionAttachment,
): void {
  attachments.set(sessionId, attachment);
  const claimWindow = setTimeout(() => {
    if (attachments.delete(sessionId)) sessions.release?.(sessionId);
  }, 0);
  claimWindow.unref?.();
}

export interface PaneSessionIndex {
  bind(paneId: string, sessionId: () => string | undefined, busy?: () => boolean): void;
  closed(paneId: string): void;
  size(): number;
  paneFor(sessionId: string): string | undefined;
  busy(sessionId: string): boolean;
}

interface PaneSessionBinding {
  sessionId: () => string | undefined;
  busy: () => boolean;
}

export function paneSessionIndex(sessions: SessionPort | undefined): PaneSessionIndex {
  const bindings = new Map<string, PaneSessionBinding>();
  const paneFor = (sessionId: string): string | undefined => {
    for (const [paneId, binding] of bindings) {
      if (binding.sessionId() === sessionId) return paneId;
    }
    return undefined;
  };
  return {
    bind: (paneId, sessionId, busy = () => false) => {
      bindings.set(paneId, { sessionId, busy });
    },
    closed: (paneId) => {
      const sessionId = bindings.get(paneId)?.sessionId();
      bindings.delete(paneId);
      if (sessionId !== undefined) sessions?.release?.(sessionId);
    },
    size: () => bindings.size,
    paneFor,
    busy: (sessionId) => {
      const paneId = paneFor(sessionId);
      return paneId === undefined ? false : (bindings.get(paneId)?.busy() ?? false);
    },
  };
}

export function startFreshSession(
  sessions: SessionPort | undefined,
  notify: () => void,
  wire: (attachment: SessionAttachment) => void,
  live: () => boolean,
): void {
  if (sessions === undefined) return;
  void sessions
    .create()
    .then((created) => {
      if (created === undefined) return;
      if (!live()) {
        sessions.release?.(created.id);
        return;
      }
      wire(created);
      notify();
    })
    .catch(() => {});
}

function adoptSession(
  pane: ConversationPane,
  agent: Agent | undefined,
  attachment: SessionAttachment,
): void {
  pane.sessionId = attachment.id;
  reconcileTitle(pane, attachment);
  if (agent === undefined) return;
  attachment.replay(agent.bus);
}

function reconcileTitle(pane: ConversationPane, attachment: SessionAttachment): void {
  if (attachment.name !== undefined) {
    pane.adoptTitle(attachment.name);
    return;
  }
  const settled = pane.titled();
  if (settled !== undefined) void attachment.rename?.(settled).catch(() => {});
}

function persistingTitler(
  titler: Titler | undefined,
  session: () => SessionAttachment | undefined,
): Titler | undefined {
  if (titler === undefined) return undefined;
  return async (conversation) => {
    const title = await titler(conversation);
    if (title !== undefined)
      void session()
        ?.rename?.(title)
        .catch(() => {});
    return title;
  };
}

export interface SessionLifecycleOptions {
  pane: ConversationPane;
  agent: Agent;
  attachment: SessionAttachment;
  afterTurn?: (turn: SessionTurn) => Promise<readonly Message[]>;
  rebuild?: (history: readonly Message[]) => Agent | undefined;
}

export function bindSessionLifecycle(options: SessionLifecycleOptions): void {
  const { pane, attachment } = options;
  let persisted = attachment.history.length;
  pane.bindAfterTurn(async () => {
    const agent = pane.currentAgent() ?? options.agent;
    const fresh = agent.history().slice(persisted);
    persisted += fresh.length;
    for (const message of fresh) await attachment.append(message);
    const joined =
      (await options.afterTurn?.({ sessionId: attachment.id, history: agent.history() })) ?? [];
    if (joined.length === 0 || pane.disposed()) return;
    const next = options.rebuild?.([...agent.history(), ...joined]);
    if (next === undefined) return;
    persisted = next.history().length;
    pane.swapAgent(next);
  });
}

function buildBody(core: AppCore, theme: Theme, screen: Screen) {
  const rects = core.layout.rects(screen);
  const focused = core.layout.focused();
  if (rects.size === 0) {
    return Box(
      { width: screen.width, height: screen.height, flexDirection: "row" },
      emptyView(theme),
    );
  }
  const idleMain = core.layout.emptyMainRect(screen);
  const dropPreview = core.dragPreview();
  const sweep = rampPositions([...core.panes.keys()]);
  return Box(
    { width: screen.width, height: screen.height },
    ...[...rects].map(([id, rect]) =>
      placedBox(rect, paneViewFor(core, theme, id, rect, id === focused, sweep.get(id) ?? 0)),
    ),
    ...(idleMain === undefined ? [] : [placedBox(idleMain, idleMainView(theme))]),
    ...(dropPreview === undefined ? [] : [dropPreviewBox(dropPreview, theme)]),
  );
}

function dropPreviewBox(rect: Rect, theme: Theme) {
  return Box({
    position: "absolute",
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
    zIndex: 5,
    border: true,
    borderStyle: "rounded",
    borderColor: theme.accent,
    overflow: "hidden",
  });
}

function placedBox(rect: Rect, view: PaneView) {
  return Box(
    {
      position: "absolute",
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      flexDirection: "column",
      overflow: "hidden",
    },
    view,
  );
}

function idleMainView(theme: Theme) {
  return Box(
    {
      flexGrow: 1,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      overflow: "hidden",
    },
    Text({ content: "· main ·", fg: theme.textDim }),
    Text({ content: "ctrl+k s starts a session here", fg: theme.textDim }),
    Text({ content: "ctrl+k shift+l/h pushes a docked pane in", fg: theme.textDim }),
  );
}

function paneViewFor(
  core: AppCore,
  theme: Theme,
  id: string,
  rect: Rect,
  focused: boolean,
  rampPosition: number,
): PaneView {
  if (rect.width < minPaneSize.width || rect.height < minPaneSize.height) {
    return overflowedView(theme);
  }
  const view = core.panes.get(id)?.view({
    theme,
    focused,
    width: rect.width,
    height: rect.height,
    borderColor: paneBorder(theme, rampPosition, focused),
  });
  return view ?? emptyView(theme);
}

function overflowedView(theme: Theme) {
  return Box(
    {
      flexGrow: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.panel,
      overflow: "hidden",
    },
    Text({ content: "⋯", fg: theme.textDim }),
  );
}

function emptyView(theme: Theme) {
  return Box(
    { flexGrow: 1, flexDirection: "column", alignItems: "center", justifyContent: "center" },
    Text({ content: "no sessions open", fg: theme.textDim }),
    Text({ content: "ctrl+k s starts one · ctrl+p commands · ctrl+q quits", fg: theme.textDim }),
  );
}

function statusBar(core: AppCore, theme: Theme, labelOption: string | (() => string) | undefined) {
  const label = typeof labelOption === "function" ? labelOption() : labelOption;
  const hint =
    core.notice !== ""
      ? core.notice
      : core.leaderArmed
        ? "nav · h/j/k/l focus  H/J/K/L move  s split  x close  z zoom  c cycle  ,/. dock width · esc done"
        : `${label ?? "keywork"} · ${core.layout.panes().length} panes · ctrl+k nav · ctrl+p commands`;
  return Box(
    {
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: theme.panel,
    },
    Text({
      content: hint,
      fg: core.notice !== "" || core.leaderArmed ? theme.accent : theme.textDim,
    }),
    Text({ content: core.lastKey, fg: theme.textDim }),
  );
}

function paletteOverlay(core: AppCore, theme: Theme, screen: Screen) {
  const matches = core.paletteMatches();
  const frame = paletteFrame(screen, matches.length);
  const innerWidth = overlayInnerWidth(frame);
  const rows = trayRows(matches, core.paletteIndex, innerWidth, theme);
  return Box(
    {
      ...overlayPosition(frame),
      zIndex: 20,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accent,
      backgroundColor: theme.panel,
      title: " commands ",
      titleAlignment: "center",
      flexDirection: "column",
      overflow: "hidden",
      paddingTop: 1,
      paddingBottom: 1,
    },
    Text({ content: clipLine(` › ${core.paletteQuery}▌`, innerWidth), fg: theme.text }),
    ...(rows.length > 0 ? rows : [Text({ content: "  no matching commands", fg: theme.textDim })]),
  );
}

function overlayPosition(frame: { x: number; y: number; width: number; height: number }) {
  return {
    position: "absolute",
    left: frame.x + frameChrome.border,
    top: frame.y + frameChrome.border,
    width: frame.width,
    height: frame.height,
  } as const;
}

function overlayInnerWidth(frame: { width: number }): number {
  return Math.max(0, frame.width - 2);
}

function overlayRow(
  left: { content: string; fg: string },
  right: { content: string; fg: string },
  width: number,
) {
  const room = Math.max(0, width - right.content.length);
  return Box(
    { flexDirection: "row", height: 1, overflow: "hidden" },
    Text({ content: clipLine(left.content, Math.max(0, room - 1)).padEnd(room), fg: left.fg }),
    Text({ content: right.content, fg: right.fg }),
  );
}

function presetOverlay(core: AppCore, theme: Theme, screen: Screen) {
  const rows = presetRows(core, theme);
  if (rows === undefined) return undefined;
  const frame = helpFrame(screen, rows.length);
  return Box(
    {
      ...overlayPosition(frame),
      zIndex: 20,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accent,
      backgroundColor: theme.panel,
      title: " permissions ",
      titleAlignment: "center",
      flexDirection: "column",
      overflow: "hidden",
      paddingTop: 1,
      paddingBottom: 1,
    },
    ...rows,
  );
}

function presetRows(core: AppCore, theme: Theme) {
  const confirmation = core.presetConfirmation();
  if (confirmation !== undefined) {
    return [
      Text({
        content: ` ${confirmation.from} → ${confirmation.to} loosens permissions`,
        fg: theme.text,
      }),
      Text({ content: " y confirm · n cancel", fg: theme.accent }),
    ];
  }
  const picker = core.presetPicker();
  if (picker === undefined) return undefined;
  const rows = picker.names.map((name, index) =>
    Text({
      content: `${index === picker.index ? "▸" : " "} ${name}${name === picker.active ? " · active" : ""}`,
      fg: index === picker.index ? theme.accent : theme.text,
    }),
  );
  if (!picker.names.includes(picker.active)) {
    rows.push(Text({ content: `  ${picker.active} · active (edited config)`, fg: theme.textDim }));
  }
  return rows;
}

function helpOverlay(keymap: Keymap, theme: Theme, screen: Screen) {
  const actions = keymap.actions();
  const frame = helpFrame(screen, actions.length);
  const innerWidth = overlayInnerWidth(frame);
  const rows = actions.map((action) =>
    overlayRow(
      { content: ` ${keymap.describe(action) ?? ""}`, fg: theme.accent },
      { content: `${bindingHelp[action] ?? action} `, fg: theme.text },
      innerWidth,
    ),
  );
  return Box(
    {
      ...overlayPosition(frame),
      zIndex: 10,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accentSoft,
      backgroundColor: theme.panel,
      title: " keywork keys ",
      titleAlignment: "center",
      flexDirection: "column",
      overflow: "hidden",
      paddingTop: 1,
      paddingBottom: 1,
    },
    ...rows,
    Box(
      { flexDirection: "row", justifyContent: "center" },
      Text({ content: "esc closes", fg: theme.textDim }),
    ),
  );
}
