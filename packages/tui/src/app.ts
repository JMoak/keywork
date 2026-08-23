import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
  type CliRenderer,
  createCliRenderer,
  type KeyEvent,
  type MouseEvent,
  type PasteEvent,
} from "@opentui/core";
import { AppCore, type AppCoreOptions } from "./app-core.ts";
import { arcIndexOf } from "./arc-index.ts";
import type { ArcsPort } from "./arcs.ts";
import { ArcsPane } from "./arcs-pane.ts";
import { BrowserPane } from "./browser-pane.ts";
import { detectCapabilities, type GlyphSupport } from "./capability.ts";
import type { Titler } from "./conversation-model.ts";
import {
  crashLogFile,
  doctorCommand,
  installFatalGuards,
  recordCrash,
  recoveredNotice,
} from "./crash-log.ts";
import { definedOnly } from "./defined.ts";
import {
  type ExtensionsPort,
  extensionFailureNotice,
  registerExtensions,
  shadowedExtensionNotice,
} from "./extension-commands.ts";
import { FilePane } from "./file-pane.ts";
import { type Flavor, FlavorSwitch, registerFlavorCommands, startupFlavors } from "./flavor.ts";
import type { CheckpointsPort } from "./fork.ts";
import { FrameCoalescer, type FrameScheduler } from "./frame-scheduler.ts";
import type { ConnectionsPort, InferencePort } from "./inference-port.ts";
import { chordOf } from "./keys.ts";
import { type Closer, closeOnce, defaultCloseTimeoutMs, runClosers } from "./lifecycle.ts";
import { McpPane, type McpPanePort, mcpDropWatcher } from "./mcp-pane.ts";
import { MemoryPane, type MemoryPanePort } from "./memory-pane.ts";
import { Animator } from "./motion.ts";
import type { PresetsPort } from "./overlays/index.ts";
import { type PageThresholdOverrides, resolvePageThresholds } from "./page.ts";
import type { PaneFactories } from "./pane-kinds.ts";
import { pointerEventOf } from "./pointer.ts";
import { loadRestorePlan, statKind, type WorkspacePort } from "./restore-plan.ts";
import {
  type AfterTurn,
  type AgentFactory,
  attachOnFork,
  type Compactor,
  paneSessionIndex,
  type SessionPort,
  sessionEscrow,
} from "./session-attachment.ts";
import { SessionPanes } from "./session-panes.ts";
import { SessionTreePane, type SessionTreePort } from "./session-tree-pane.ts";
import type { ThemeOverrides } from "./theme.ts";
import {
  appFrame,
  discardFrame,
  type FrameInputs,
  frameChrome,
  pointerPlane,
  screenWithin,
} from "./view/frame.ts";
import { overlayView } from "./view/overlays.ts";
import type { WorkspacesPort } from "./workspace-picker.ts";
import { readinessNotice, type WorkspaceSetupPort } from "./workspace-setup.ts";
import type { WorkspaceState } from "./workspace-state.ts";

export interface AppOptions {
  themeOverrides?: ThemeOverrides;
  flavors?: readonly Flavor[];
  page?: PageThresholdOverrides;
  glyphs?: GlyphSupport;
  agentFactory?: AgentFactory;
  afterTurn?: AfterTurn;
  compact?: Compactor;
  closers?: readonly Closer[];
  closeTimeoutMs?: number;
  createRenderer?: () => Promise<CliRenderer>;
  exit?: (code: number) => void;
  presets?: PresetsPort;
  inference?: InferencePort;
  connections?: ConnectionsPort;
  titler?: Titler;
  statusLabel?: string | (() => string);
  checkpoints?: CheckpointsPort;
  workspace?: WorkspacePort;
  sessions?: SessionPort;
  sessionTrees?: SessionTreePort;
  arcs?: ArcsPort;
  workspaces?: WorkspacesPort;
  workspaceSetup?: WorkspaceSetupPort;
  memory?: MemoryPanePort;
  mcp?: McpPanePort;
  extensions?: ExtensionsPort;
}

export async function runApp(options: AppOptions = {}): Promise<void> {
  const flavors = new FlavorSwitch([
    ...startupFlavors(options.themeOverrides),
    ...(options.flavors ?? []),
  ]);
  const escrow = sessionEscrow(options.sessions);
  const restore = await loadRestorePlan(options, escrow);
  if (restore.kind === "failed") recordCrash("restore", restore.cause);
  const renderer = await (options.createRenderer ?? defaultRenderer)();
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const frames = new FrameCoalescer(microtaskFrame, () => paint());
  const render = (): void => frames.request();
  const animator = new Animator({ onFrame: render });
  const arcIndex = arcIndexOf(options.arcs, render);
  const paneSessions = paneSessionIndex(options.sessions);
  const trees =
    options.sessionTrees === undefined
      ? undefined
      : attachOnFork(options.sessionTrees, options.sessions, escrow);
  const sessions = new SessionPanes({
    core: () => core,
    escrow,
    paneSessions,
    arcIndex,
    animator,
    page: resolvePageThresholds(options.page),
    glyphs: options.glyphs ?? detectCapabilities(),
    ...definedOnly({
      agentFactory: options.agentFactory,
      sessions: options.sessions,
      trees,
      checkpoints: options.checkpoints,
      titler: options.titler,
      afterTurn: options.afterTurn,
      compact: options.compact,
      arcs: options.arcs,
    }),
  });
  const armed = armedExpiryWatch(() => core, render);
  const unsubscribeMcp = options.mcp?.subscribe?.(mcpDropWatcher((text) => core.postNotice(text)));
  let releaseFatalGuards: () => void = () => {};
  const core: AppCore = new AppCore({
    screen: () => screenWithin(renderer),
    ...paneFactories(options, sessions, trees, paneSessions, arcIndex),
    ...hostPorts(options, sessions),
    ...(restore.kind === "restore" && { restoreWorkspace: restore.state }),
    ...(options.workspace !== undefined && {
      saveWorkspace: (state: WorkspaceState) => options.workspace?.save(state),
    }),
    onPaneClosed: (id) => {
      sessions.forget(id);
      paneSessions.closed(id);
      arcIndex.changed();
    },
    onExit: closeOnce(() => {
      releaseFatalGuards();
      animator.settleAll();
      armed.stop();
      frames.dispose();
      unsubscribeMcp?.();
      arcIndex.dispose();
      paneSessions.closeAll();
      escrow.releaseAll();
      renderer.destroy();
      options.workspace?.seal();
      void runClosers(
        options.closers ?? [],
        options.closeTimeoutMs ?? defaultCloseTimeoutMs,
        (error) => console.error(error.message),
      ).finally(() => exit(0));
    }),
  });
  const paint = (): void => {
    armed.watch();
    try {
      paintFrame(renderer, core, {
        theme: flavors.theme,
        screen: screenWithin(renderer),
        instruments: flavors.active.instruments,
        arcOrdinal: arcIndex.ordinalOf,
        arcOf: (id) => sessions.arcOf(id),
        label:
          typeof options.statusLabel === "function" ? options.statusLabel() : options.statusLabel,
        focusedArc: sessions.focused()?.pane.arc,
      });
    } catch (cause) {
      recordCrash("render", cause);
    }
  };
  const contain = (scope: string, work: () => void): void => {
    try {
      work();
    } catch (cause) {
      recordCrash(scope, cause);
      core.postNotice(recoveredNotice);
    }
  };
  registerHostCommands(core, options, sessions, flavors, render);
  renderer.root.add(pointerPlane());
  wireInput(renderer, core, contain, render);
  releaseFatalGuards = installFatalGuards({
    recover: () => {
      core.postNotice(recoveredNotice);
      render();
    },
    abandon: () => {
      try {
        renderer.destroy();
      } catch {}
      console.error(`keywork hit repeated fatal errors · details in ${crashLogFile}`);
      exit(1);
    },
  });
  renderer.auto();
  core.bindNotify(render);
  core.start();
  const readiness = options.workspaceSetup?.readiness();
  const blocker = readiness === undefined ? undefined : readinessNotice(readiness);
  if (blocker !== undefined) core.postNotice(blocker);
  if (restore.kind === "failed") {
    core.postNotice(`couldn't restore the last workspace · details in ${crashLogFile}`);
  }
  arcIndex.changed();
  render();
}

function paneFactories(
  options: AppOptions,
  sessions: SessionPanes,
  trees: SessionTreePort | undefined,
  paneSessions: ReturnType<typeof paneSessionIndex>,
  arcIndex: ReturnType<typeof arcIndexOf>,
): PaneFactories {
  const { arcs, memory, mcp } = options;
  return {
    createPane: sessions.createPane,
    createFilePane: (id, path, notify, fileOptions) =>
      new FilePane(id, process.cwd(), path, notify, fileOptions),
    createBrowserPane: (id, root, notify, intents) =>
      new BrowserPane(id, resolve(process.cwd(), root), notify, intents),
    ...(trees !== undefined && {
      createSessionTreePane: (id, notify, intents, targetSession, sessionId) =>
        new SessionTreePane(id, notify, intents, trees, targetSession, {
          ...(sessionId !== undefined && { sessionId }),
          presence: paneSessions,
          arcOrdinal: arcIndex.ordinalOf,
        }),
    }),
    ...(trees !== undefined &&
      arcs !== undefined && {
        createArcsPane: (id, notify, intents, targetSession, arc) =>
          new ArcsPane(id, notify, intents, {
            arcs,
            sessions: trees,
            currentSession: targetSession,
            presence: paneSessions,
            arcOrdinal: arcIndex.ordinalOf,
            ...(arc !== undefined && { drilled: { kind: "arc", slug: arc } }),
          }),
      }),
    ...(memory !== undefined && {
      createMemoryPane: (id: string, notify: () => void) => new MemoryPane(id, notify, memory),
    }),
    ...(mcp !== undefined && {
      createMcpPane: (id: string, notify: () => void) => new McpPane(id, notify, mcp),
    }),
  };
}

function hostPorts(
  options: AppOptions,
  sessions: SessionPanes,
): Omit<AppCoreOptions, "screen" | "onExit" | keyof PaneFactories> {
  return {
    isDirectory: (path) =>
      statSync(resolve(process.cwd(), path), { throwIfNoEntry: false })?.isDirectory() === true,
    currentModel: () => sessions.currentModel(),
    switchModel: (reference) => sessions.switchModel(reference),
    ...definedOnly({
      undo: options.checkpoints,
      presets: options.presets,
      inference: options.inference,
      connections: options.connections,
      workspaces: options.workspaces,
      workspaceSetup: options.workspaceSetup,
      arcs: options.arcs,
    }),
    ...(options.arcs !== undefined && { focusedArc: sessions.focusedArcPort() }),
  };
}

function registerHostCommands(
  core: AppCore,
  options: AppOptions,
  sessions: SessionPanes,
  flavors: FlavorSwitch,
  render: () => void,
): void {
  const notice = (text: string): void => core.postNotice(text);
  core.registry.register(
    doctorCommand({
      logFile: crashLogFile,
      exists: (path) => statKind(path)?.isFile() === true,
      openFile: core.intents.openFile,
      notice,
    }),
  );
  registerFlavorCommands(core.registry, flavors, { repaint: render, notice });
  const extensions = options.extensions;
  if (extensions === undefined) return;
  const shadowed = registerExtensions(core.registry, extensions, {
    conversation: () => sessions.conversationTarget(),
    notice,
  });
  for (const text of [
    extensionFailureNotice(extensions.failures),
    shadowedExtensionNotice(shadowed),
  ]) {
    if (text !== undefined) notice(text);
  }
}

function paintFrame(renderer: CliRenderer, core: AppCore, inputs: FrameInputs): void {
  discardFrame(renderer.root);
  renderer.root.add(appFrame(core, inputs));
  const overlay = overlayView(core, inputs);
  if (overlay !== undefined) renderer.root.add(overlay);
  renderer.requestRender();
}

function wireInput(
  renderer: CliRenderer,
  core: AppCore,
  contain: (scope: string, work: () => void) => void,
  render: () => void,
): void {
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
    contain("mouse", () => {
      const pointer = pointerEventOf(event);
      if (pointer === undefined) return;
      core.handleMouse({
        ...pointer,
        x: pointer.x - frameChrome.border,
        y: pointer.y - frameChrome.border,
      });
      if (pointer.type !== "move" || core.overlayOpen || core.draggingPane() !== undefined) {
        render();
      }
    });
  };
  renderer.on("resize", render);
}

function armedExpiryWatch(core: () => AppCore, render: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    stop,
    watch: (): void => {
      stop();
      if (!core().leaderArmed) return;
      timer = setTimeout(() => {
        core().expireArmed(performance.now());
        render();
      }, core().keymap.timeoutMs + 50);
      timer.unref?.();
    },
  };
}

const microtaskFrame: FrameScheduler = (run) => {
  let live = true;
  queueMicrotask(() => {
    if (live) run();
  });
  return () => {
    live = false;
  };
};

function defaultRenderer(): Promise<CliRenderer> {
  return createCliRenderer({ exitOnCtrlC: false, enableMouseMovement: true });
}
