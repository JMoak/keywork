import { statSync } from "node:fs";
import { release as osRelease } from "node:os";
import { resolve } from "node:path";
import { keepAwake, openInteractiveShell, probePtySupport } from "@keywork/engine";
import {
  type CliRenderer,
  createCliRenderer,
  createHostClipboard,
  type KeyEvent,
  type MouseEvent,
  type PasteEvent,
} from "@opentui/core";
import { AppCore, type AppCoreOptions } from "./app-core.ts";
import { arcIndexOf, arcJumpCommands, firstArcIntroducer } from "./arc-index.ts";
import { ArcPane } from "./arc-pane.ts";
import { arcThemeCommand } from "./arc-theme.ts";
import type { ArcAttire, ArcsPort } from "./arcs.ts";
import { ArcsPane } from "./arcs-pane.ts";
import { botJumpCommands } from "./bot-commands.ts";
import { announcingCreations, type BotEntry, type BotSummary, type BotsPort } from "./bots.ts";
import { BotsPane } from "./bots-pane.ts";
import { type BrowserDisk, realBrowserDisk } from "./browser-model.ts";
import { BrowserPane } from "./browser-pane.ts";
import {
  type BugBundleFacts,
  bugCommand,
  EventRecorder,
  type RecordedEvent,
  sessionShape,
} from "./bug-bundle.ts";
import { detectCapabilities, type GlyphSupport } from "./capability.ts";
import { commitDraftCommand, gitIn } from "./commit-draft.ts";
import type { GaugeStyle } from "./context-gauge.ts";
import {
  ContextPane,
  type ContextPort,
  type ContextReadings,
  servedContext,
} from "./context-pane.ts";
import type { Titler } from "./conversation-model.ts";
import type { TranscriptElevation } from "./conversation-pane.ts";
import { copyCommands } from "./copy-commands.ts";
import {
  crashLogFile,
  doctorCommands,
  installFatalGuards,
  recordCrash,
  recoveredNotice,
} from "./crash-log.ts";
import { definedOnly } from "./defined.ts";
import {
  announcingFileChanges,
  type DiffPort,
  eitherChange,
  FileChangeFeed,
} from "./diff-model.ts";
import { DiffPane } from "./diff-pane.ts";
import {
  type ExtensionsPort,
  extensionFailureNotice,
  registerExtensions,
  shadowedExtensionNotice,
} from "./extension-commands.ts";
import {
  type ExtensionHostPort,
  extensionStartupNotice,
  registerHostedCommands,
  watchExtensionNotices,
} from "./extension-host.ts";
import { externalEditorFor } from "./external-editor.ts";
import { FileIndex, fileJumpSource, fileJumpsAllowed } from "./file-index.ts";
import type { FileReader } from "./file-model.ts";
import { FilePane } from "./file-pane.ts";
import type { CheckpointsPort } from "./fork.ts";
import { FrameCoalescer, type FrameScheduler } from "./frame-scheduler.ts";
import { fullRect, type Rect, type Screen } from "./geometry.ts";
import { herdrReporter } from "./herdr.ts";
import { type ClipboardPort, type ClipboardRead, imageFromBytes } from "./image-paste.ts";
import type { ConnectionsPort, InferencePort } from "./inference-port.ts";
import { applyKeybindings, type KeybindingSource, watchKeybindings } from "./keybindings.ts";
import { chordOf } from "./keys.ts";
import { type Closer, closeOnce, defaultCloseTimeoutMs, runClosers } from "./lifecycle.ts";
import { McpPane, type McpPanePort, mcpDropWatcher } from "./mcp-pane.ts";
import type { DecisionsView } from "./memory-decisions.ts";
import { MemoryPane, type MemoryPanePort } from "./memory-pane.ts";
import type { DigestTreatment, GardenHeat } from "./memory-rows.ts";
import { Animator } from "./motion.ts";
import {
  type NotificationPolicy,
  Notifier,
  transportFor,
  type WorkSnapshot,
} from "./notifications.ts";
import {
  disableFocusReporting,
  enableFocusReporting,
  focusEventsIn,
  type TerminalFacts,
  TerminalReporter,
  terminalSupport,
  type WindowTitleState,
} from "./osc.ts";
import type { PresetsPort } from "./overlays/index.ts";
import { type PageThresholdOverrides, resolvePageThresholds } from "./page.ts";
import type { Palette, PaletteOverrides } from "./palette.ts";
import type { PaneIntents } from "./pane.ts";
import { drawnRect } from "./pane-geometry.ts";
import type { PaneFactories } from "./pane-kinds.ts";
import type { PermissionsPort } from "./permissions-model.ts";
import { pointerEventOf } from "./pointer.ts";
import { rendererHold } from "./renderer-hold.ts";
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
import { type SessionPaneDeps, SessionPanes } from "./session-panes.ts";
import { SessionTreePane, type SessionTreePort } from "./session-tree-pane.ts";
import { followTerminalTheme, systemThemeName } from "./system-theme.ts";
import {
  mirrorSourceOverPanes,
  type TerminalPanePort,
  terminalPaneFactory,
} from "./terminal-pane.ts";
import { embeddedTerminalSurfaces } from "./terminal-surface.ts";
import {
  dressedIn,
  registerThemeCommands,
  startupThemes,
  type Theme,
  ThemeSwitch,
} from "./theme.ts";
import {
  appFrame,
  discardFrame,
  type FocusOutline,
  type FrameInputs,
  frameInset,
  pointerPlane,
  screenWithin,
} from "./view/frame.ts";
import { overlayView } from "./view/overlays.ts";
import { switchWorkspace } from "./workspace-commands.ts";
import type { WorkspacesPort } from "./workspace-picker.ts";
import { readinessNotice, type WorkspaceSetupPort } from "./workspace-setup.ts";
import type { WorkspaceState } from "./workspace-state.ts";
import { WorkspacesPane } from "./workspaces-pane.ts";

export interface AppOptions {
  paletteOverrides?: PaletteOverrides;
  theme?: string;
  keybindings?: KeybindingSource;
  pointer?: "on" | "off";
  masthead?: "on" | "off";
  motion?: "full" | "reduced";
  tips?: "on" | "off";
  scrim?: "on" | "off";
  dim?: "on" | "off";
  gauge?: GaugeStyle;
  elevation?: TranscriptElevation;
  doctorReport?: () => Promise<string>;
  gardenHeat?: GardenHeat;
  themes?: readonly Theme[];
  page?: PageThresholdOverrides;
  glyphs?: GlyphSupport;
  hyperlinks?: boolean;
  focusOutline?: FocusOutline;
  agentFactory?: AgentFactory;
  shellEscape?: SessionPaneDeps["shellEscape"];
  spillFile?: SessionPaneDeps["spillFile"];
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
  exportSession?: AppCoreOptions["exportSession"];
  workspace?: WorkspacePort;
  sessions?: SessionPort;
  sessionTrees?: SessionTreePort;
  arcs?: ArcsPort;
  bots?: BotsPort;
  workspaces?: WorkspacesPort;
  workspaceSetup?: WorkspaceSetupPort;
  memory?: MemoryPanePort;
  memoryDigest?: DigestTreatment;
  clock?: () => number;
  mcp?: McpPanePort;
  diff?: DiffPort;
  notices?: NoticeSource;
  extensions?: ExtensionsPort;
  extensionHost?: ExtensionHostPort;
  permissions?: PermissionsPort;
  contextReadings?: ContextReadings;
  files?: WorkspaceFilesPort;
  terminal?: TerminalSeams;
  terminalPane?: TerminalPanePort;
  notifications?: NotificationPolicy;
  inbox?: InboxSource;
  bugReport?: BugReportPort;
}

export interface WorkspaceFilesPort {
  disk: BrowserDisk;
  read: FileReader;
}

export interface BugReportPort {
  version?: string;
  config?: () => unknown;
  dir?: string;
}

export interface NoticeSource {
  subscribe(post: (text: string) => void): () => void;
}

export interface InboxSource {
  subscribe(listener: (waiting: number) => void): () => void;
}

export interface TerminalSeams {
  write?: (bytes: string) => void;
  facts?: TerminalFacts;
  input?: InputTap;
}

export type InputTap = (listener: (bytes: string) => void) => () => void;

export async function runApp(launchOptions: AppOptions = {}): Promise<void> {
  const fileChanges = new FileChangeFeed();
  const options = announcingBotCreations(announcingFileChanges(launchOptions, fileChanges));
  const themes = new ThemeSwitch(
    startupThemes(options.paletteOverrides, options.themes, options.theme),
  );
  const escrow = sessionEscrow(options.sessions);
  const restore = await loadRestorePlan(options, escrow);
  if (restore.kind === "failed") recordCrash("restore", restore.cause);
  const pointerOn = options.pointer !== "off";
  const renderer = await (options.createRenderer ?? (() => defaultRenderer(pointerOn)))();
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const frames = new FrameCoalescer(microtaskFrame, () => paint());
  const render = (): void => frames.request();
  const animator = new Animator({
    onFrame: render,
    reducedMotion: options.motion === "reduced",
  });
  const introduceFirstArc = firstArcIntroducer((slug) => core.introduceArcPane(slug));
  const arcIndex = arcIndexOf(options.arcs, (listed) => {
    introduceFirstArc(listed);
    sessions.resyncArcs();
    render();
  });
  const arcAttire: ArcAttire = (slug) => {
    const worn = arcIndex.listed().find((arc) => arc.slug === slug)?.theme;
    return worn === undefined ? undefined : themes.paletteNamed(worn);
  };
  const paneAttire = (id: string): Palette | undefined => {
    const arc = sessions.arcOf(id) ?? arcPaneSlug(core, id);
    return arc === undefined ? undefined : arcAttire(arc);
  };
  const paneSessions = paneSessionIndex(options.sessions);
  const trees =
    options.sessionTrees === undefined
      ? undefined
      : attachOnFork(options.sessionTrees, options.sessions, escrow);
  const glyphs = options.glyphs ?? detectCapabilities();
  const terminal = terminalOf(options, glyphs);
  const recorder = new EventRecorder();
  const awake = keepAwake();
  const herdr = herdrReporter({ env: options.terminal?.facts?.env ?? process.env });
  const sessions = new SessionPanes({
    core: () => core,
    escrow,
    paneSessions,
    arcIndex,
    animator,
    page: resolvePageThresholds(options.page),
    glyphs,
    hyperlinks: options.hyperlinks ?? terminalSupport(options.terminal?.facts).hyperlinks,
    workspaceFiles: () =>
      fileJumpsAllowed(options.workspaceSetup?.readiness()) ? fileIndex.entries() : [],
    ...definedOnly({
      agentFactory: recordingAgents(options.agentFactory, recorder),
      shellEscape: options.shellEscape,
      spillFile: options.spillFile,
      sessions: options.sessions,
      trees,
      checkpoints: options.checkpoints,
      titler: options.titler,
      afterTurn: options.afterTurn,
      compact: options.compact,
      arcs: options.arcs,
      masthead: options.masthead,
      gauge: options.gauge,
      elevation: options.elevation,
      botOf: botLookup(options.bots),
      now: options.clock,
      botSpend: botSpendLookup(options.bots),
    }),
  });
  const armed = armedExpiryWatch(() => core, render);
  const fileIndex = new FileIndex(process.cwd(), realBrowserDisk, render);
  let inboxWaiting = 0;
  const unsubscribeInbox = options.inbox?.subscribe((waiting) => {
    inboxWaiting = waiting;
    render();
  });
  let stopFocusWatch: () => void = () => {};
  let stopThemeFollow: () => void = () => {};
  // opentui emits destroy before writing its own teardown, which blanks the title we pop
  const shutDownWithRenderer = (): void => queueMicrotask(() => core.shutdown());
  let releaseFatalGuards: () => void = () => {};
  const core: AppCore = new AppCore({
    screen: () => screenWithin(renderer, themes.active.chromeWeight),
    drawnRect: (rect: Rect, screen: Screen) =>
      drawnRect(rect, fullRect(screen), {
        chrome: themes.active.chromeWeight,
        gap: themes.active.gap,
      }),
    ...paneFactories(options, sessions, trees, paneSessions, arcIndex, arcAttire, () => core),
    createTerminalPane: terminalPaneFactory({
      cwd: process.cwd(),
      trusted: () => options.terminalPane?.trusted === true,
      spawn: options.terminalPane?.spawn ?? openInteractiveShell,
      pty: options.terminalPane?.pty ?? probePtySupport(),
      surfaces: embeddedTerminalSurfaces(renderer),
      mirror: mirrorSourceOverPanes(() => core.panes),
    }),
    ...(options.diff !== undefined && {
      createDiffPane: (id: string, notify: () => void, intents: PaneIntents) =>
        new DiffPane(id, notify, intents, {
          ...options.diff,
          changes: eitherChange(fileChanges, options.diff?.follow),
          turns: () => sessions.focused()?.pane.model.turnRecords() ?? [],
          verbs: {
            undo: () => runOrSay(core, "undo", "nothing to undo here · undo needs checkpoints"),
            redo: () => runOrSay(core, "redo", "nothing to redo here · redo needs checkpoints"),
          },
        }),
    }),
    ...hostPorts(options, sessions),
    externalEditor: externalEditorFor({
      env: options.terminal?.facts?.env ?? process.env,
      hold: rendererHold({
        renderer,
        write: terminal.write,
        modes: () => ({
          focusReporting: terminal.notifier.transport !== "off",
          themeReports: terminal.interactive && themes.names().includes(systemThemeName),
        }),
        afterResume: () => {
          terminal.reporter.refresh();
          render();
        },
      }),
    }),
    ...definedOnly({ clipboard: hostClipboardPort() }),
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
      unsubscribeNotices?.();
      unsubscribeExtensionNotices?.();
      unwatchKeybindings();
      arcIndex.dispose();
      fileIndex.dispose();
      paneSessions.closeAll();
      escrow.releaseAll();
      unsubscribeInbox?.();
      stopFocusWatch();
      stopThemeFollow();
      awake.dispose();
      herdr.release();
      renderer.off("destroy", shutDownWithRenderer);
      renderer.destroy();
      terminal.reporter.end();
      options.workspace?.seal();
      void runClosers(
        options.closers ?? [],
        options.closeTimeoutMs ?? defaultCloseTimeoutMs,
        (error) => console.error(error.message),
      ).finally(() => exit(0));
    }),
  });
  const unsubscribeMcp = options.mcp?.subscribe?.(mcpDropWatcher((text) => core.postNotice(text)));
  const unsubscribeNotices = options.notices?.subscribe((text) => core.postNotice(text));
  const unsubscribeExtensionNotices =
    options.extensionHost === undefined
      ? undefined
      : watchExtensionNotices(options.extensionHost, {
          notice: (text) => {
            core.postNotice(text);
            render();
          },
          post: (text) => sessions.postNotice(text),
        });
  const paint = (): void => {
    armed.watch();
    try {
      paintFrame(
        renderer,
        core,
        {
          theme: themes.palette,
          screen: screenWithin(renderer, themes.active.chromeWeight),
          chrome: themes.active.chromeWeight,
          gap: themes.active.gap,
          dim: options.dim === "on",
          instruments: themes.active.instruments,
          glyphs,
          ...(options.focusOutline !== undefined && { focusOutline: options.focusOutline }),
          arcOrdinal: arcIndex.ordinalOf,
          arcAttire,
          paneAttire,
          arcOf: (id) => sessions.arcOf(id),
          label:
            typeof options.statusLabel === "function" ? options.statusLabel() : options.statusLabel,
          focusedArc: sessions.focused()?.pane.arc,
        },
        options.scrim === "on",
      );
      terminal.reporter.report(focusedWindowTitle(sessions, terminal.notifier.terminalFocused));
      terminal.notifier.observe(workSnapshot(sessions, inboxWaiting));
      awake.turnRunning(sessions.working());
      herdr.report({ working: sessions.working(), blocked: sessions.awaiting().length > 0 });
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
  registerHostCommands(core, options, sessions, themes, render, terminal);
  if (options.arcs !== undefined) {
    core.registry.register(
      arcThemeCommand({
        arcs: options.arcs,
        themeNames: () => themes.names(),
        focusedArc: () => arcPaneSlug(core, core.layout.focused()) ?? sessions.focused()?.pane.arc,
        notice: (text) => core.postNotice(text),
        settle: (work) => core.settle(work),
      }),
    );
  }
  core.registry.register(
    bugCommand({
      facts: () => bugFacts(options, sessions, terminal, glyphs, recorder.recent()),
      notice: (text) => core.postNotice(text),
      post: (text) => sessions.postNotice(text),
      ...definedOnly({ dir: options.bugReport?.dir }),
    }),
  );
  core.registry.addSource(() => arcJumpCommands(core, arcIndex.listed()));
  const bots = options.bots;
  if (bots !== undefined) core.registry.addSource(() => botJumpCommands(core, bots));
  core.registry.addSource(
    fileJumpSource(fileIndex, {
      openFile: (path) => core.openFile(path),
      allowed: () => fileJumpsAllowed(options.workspaceSetup?.readiness()),
    }),
  );
  if (pointerOn) renderer.root.add(pointerPlane());
  wireInput(
    renderer,
    core,
    contain,
    render,
    () => frameInset(themes.active.chromeWeight),
    pointerOn,
    () => animator.settleAll(),
  );
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
  terminal.reporter.begin();
  stopFocusWatch = watchFocus(terminal, options.terminal?.input ?? stdinTap, (focused) =>
    sessions.focused()?.pane.model.terminalFocusChanged(focused),
  );
  stopThemeFollow = watchTheme(terminal, options.terminal?.input ?? stdinTap, {
    themes,
    overrides: options.paletteOverrides,
    repaint: render,
  });
  renderer.once("destroy", shutDownWithRenderer);
  renderer.auto();
  core.bindNotify(render);
  core.start();
  const keybindingSeams = {
    keymap: core.keymap,
    source: options.keybindings ?? { read: async () => ({}) },
    notice: (text: string): void => {
      core.postNotice(text);
      render();
    },
    aside: (text: string): void => {
      if (!sessions.postNotice(text)) core.postNotice(text);
      render();
    },
  };
  if (options.keybindings !== undefined) await applyKeybindings(keybindingSeams);
  const unwatchKeybindings = watchKeybindings(keybindingSeams);
  if (options.theme !== undefined && themes.active.name !== options.theme) {
    core.postNotice(`no theme named "${options.theme}" · wearing ${themes.active.name}`);
  }
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
  arcAttire: ArcAttire,
  core: () => AppCore,
): PaneFactories {
  const { arcs, memory, mcp, workspaces, bots } = options;
  const botOf = botLookup(bots);
  return {
    createPane: sessions.createPane,
    createContextPane: (id, notify, intents) =>
      new ContextPane(id, notify, intents, contextPortOf(options.contextReadings, sessions)),
    ...(bots !== undefined && {
      createBotsPane: (id: string, notify: () => void) =>
        new BotsPane(id, notify, {
          bots,
          open: (name) => core().openBotPane(name),
          create: () => core().botCommand({ verb: "new", name: undefined }),
          release: () => core().botCommand({ verb: "switch", name: undefined }),
          boundHere: () => sessions.focused()?.pane.bot,
          subscribe: (changed) => bots.subscribe?.(changed) ?? (() => {}),
          ...(options.clock !== undefined && { now: options.clock }),
        }),
    }),
    createFilePane: (id, path, notify, fileOptions) =>
      new FilePane(id, process.cwd(), path, notify, fileOptions, options.files?.read),
    createBrowserPane: (id, root, notify, intents) =>
      options.files === undefined
        ? new BrowserPane(id, resolve(process.cwd(), root), notify, intents)
        : new BrowserPane(id, root, notify, intents, options.files.disk),
    ...(trees !== undefined && {
      createSessionTreePane: (id, notify, intents, targetSession, sessionId, groupBy) =>
        new SessionTreePane(id, notify, intents, trees, targetSession, {
          ...(sessionId !== undefined && { sessionId }),
          ...(groupBy !== undefined && { groupBy }),
          ...(botOf !== undefined && { botSigil: (name: string) => botOf(name)?.sigil }),
          presence: paneSessions,
          arcOrdinal: arcIndex.ordinalOf,
          arcAttire,
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
            arcAttire,
            ...(arc !== undefined && { drilled: { kind: "arc", slug: arc } }),
          }),
        createArcPane: (id, notify, intents, targetSession, slug) => {
          const returnDelta = arcs.returnDelta?.bind(arcs);
          return new ArcPane(id, notify, intents, {
            slug,
            sessions: trees,
            currentSession: targetSession,
            presence: paneSessions,
            arcOrdinal: arcIndex.ordinalOf,
            arcAttire,
            ...(returnDelta !== undefined && { returnDelta: () => returnDelta(slug) }),
          });
        },
      }),
    ...(memory !== undefined && {
      createMemoryPane: (id, notify, intents, _targetSession, revival) =>
        new MemoryPane(id, notify, memory, {
          intents,
          focusedArc: () => sessions.focused()?.pane.arc,
          decisions: () => focusedDecisions(sessions),
          arcOrdinal: arcIndex.ordinalOf,
          arcAttire,
          ...(options.memoryDigest !== undefined && { digestTreatment: options.memoryDigest }),
          ...(options.gardenHeat !== undefined && { gardenHeat: options.gardenHeat }),
          ...(options.clock !== undefined && { now: options.clock }),
          ...(options.arcs?.subscribe !== undefined && { subscribe: options.arcs.subscribe }),
          ...(revival !== undefined && { revival: { lens: "garden", ...revival } }),
        }),
    }),
    ...(mcp !== undefined && {
      createMcpPane: (id: string, notify: () => void) => new McpPane(id, notify, mcp),
    }),
    ...(workspaces !== undefined && {
      createWorkspacesPane: (id: string, notify: () => void, intents: PaneIntents) =>
        new WorkspacesPane(id, notify, intents, {
          workspaces,
          liveTurns: () => sessions.busyCount(),
          switchTo: (slug) =>
            switchWorkspace(
              {
                workspaces,
                notice: (text) => core().postNotice(text),
                shutdown: () => core().shutdown(),
              },
              slug,
            ),
          ...(options.clock !== undefined && { now: options.clock }),
        }),
    }),
  };
}

function arcPaneSlug(core: AppCore, id: string | undefined): string | undefined {
  const descriptor = id === undefined ? undefined : core.panes.get(id)?.describe?.();
  return descriptor?.kind === "arc" ? descriptor.arc : undefined;
}

function runOrSay(core: AppCore, command: string, otherwise: string): void {
  if (!core.runCommand(command)) core.postNotice(otherwise);
}

function announcingBotCreations(options: AppOptions): AppOptions {
  return options.bots === undefined
    ? options
    : { ...options, bots: announcingCreations(options.bots) };
}

function contextPortOf(readings: ContextReadings | undefined, sessions: SessionPanes): ContextPort {
  if (readings === undefined) return focusedContext(sessions);
  return servedContext(readings, () => {
    const found = sessions.focused();
    return found === undefined
      ? readings.fallback?.()
      : { name: found.pane.titled() ?? found.id, sessionId: found.pane.sessionId };
  });
}

function focusedContext(sessions: SessionPanes): ContextPort {
  return {
    target: () => {
      const found = sessions.focused();
      if (found === undefined) return undefined;
      const { model } = found.pane;
      return {
        name: found.pane.titled() ?? found.id,
        map: model.contextMap(),
        compact: () => model.compact(),
      };
    },
  };
}

function focusedDecisions(sessions: SessionPanes): DecisionsView | undefined {
  const found = sessions.focused();
  if (found === undefined) return undefined;
  const { model } = found.pane;
  return {
    session: found.pane.titled() ?? found.id,
    decisions: model.ledger.memoryDecisions(),
    actionOf: (callId) => model.toolWords(callId),
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
    currentEffort: () => sessions.currentEffort(),
    switchModel: (reference) => sessions.switchModel(reference),
    ...definedOnly({
      undo: options.checkpoints,
      exportSession: options.exportSession,
      presets: options.presets,
      inference: options.inference,
      connections: options.connections,
      workspaces: options.workspaces,
      workspaceSetup: options.workspaceSetup,
      arcs: options.arcs,
      bots: options.bots,
      extensionHost: options.extensionHost,
      permissions: options.permissions,
    }),
    ...(options.arcs !== undefined && { focusedArc: sessions.focusedArcPort() }),
    ...(options.bots !== undefined && { focusedBot: sessions.focusedBotPort() }),
    ...(options.permissions !== undefined && {
      focusedPermissions: sessions.focusedPermissionsPort(options.permissions),
    }),
    tips: {
      enabled: options.tips !== "off",
      ...(options.clock !== undefined && { now: options.clock }),
    },
  };
}

function registerHostCommands(
  core: AppCore,
  options: AppOptions,
  sessions: SessionPanes,
  themes: ThemeSwitch,
  render: () => void,
  terminal: Terminal,
): void {
  const notice = (text: string): void => core.postNotice(text);
  for (const command of copyCommands({
    conversation: () => sessions.focused()?.pane.model,
    write: terminal.write,
    notice,
    clipboard: terminal.clipboard,
  })) {
    core.registry.register(command);
  }
  core.registry.register(
    commitDraftCommand({
      conversation: () => sessions.focused()?.pane.model,
      git: gitIn(process.cwd()),
      write: terminal.write,
      notice,
      clipboard: terminal.clipboard,
    }),
  );
  for (const command of doctorCommands({
    logFile: crashLogFile,
    exists: (path) => statKind(path)?.isFile() === true,
    openFile: core.intents.openFile,
    notice,
    ...(options.doctorReport !== undefined && { report: options.doctorReport }),
    post: (text) => sessions.postNotice(text),
  })) {
    core.registry.register(command);
  }
  registerThemeCommands(core.registry, themes, { repaint: render, notice });
  const extensions = options.extensions;
  if (extensions !== undefined) {
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
  const host = options.extensionHost;
  if (host === undefined) return;
  const shadowed = registerHostedCommands(core.registry, host, {
    notice,
    post: (text) => sessions.postNotice(text),
  });
  for (const text of [extensionStartupNotice(host), shadowedExtensionNotice(shadowed)]) {
    if (text !== undefined) notice(text);
  }
}

interface Terminal {
  readonly reporter: TerminalReporter;
  readonly notifier: Notifier;
  readonly write: (bytes: string) => void;
  readonly clipboard: boolean;
  readonly interactive: boolean;
}

function terminalOf(options: AppOptions, glyphs: GlyphSupport): Terminal {
  const write = options.terminal?.write ?? ((bytes: string) => void process.stdout.write(bytes));
  const support = terminalSupport(options.terminal?.facts);
  const transport = transportFor(options.notifications ?? "auto", options.terminal?.facts);
  return {
    reporter: new TerminalReporter(write, support, glyphs),
    notifier: new Notifier(write, transport),
    write,
    clipboard: support.clipboard,
    interactive: support.title,
  };
}

function watchFocus(
  terminal: Terminal,
  tap: InputTap,
  attend: (focused: boolean) => void,
): () => void {
  if (terminal.notifier.transport === "off") return () => {};
  terminal.write(enableFocusReporting);
  const release = tap((bytes) => {
    for (const event of focusEventsIn(bytes)) {
      terminal.notifier.focusChanged(event);
      attend(event === "focus-in");
    }
  });
  return () => {
    release();
    terminal.write(disableFocusReporting);
  };
}

interface ThemeWatch {
  readonly themes: ThemeSwitch;
  readonly overrides: PaletteOverrides | undefined;
  readonly repaint: () => void;
}

function watchTheme(terminal: Terminal, tap: InputTap, watch: ThemeWatch): () => void {
  if (!terminal.interactive || !watch.themes.names().includes(systemThemeName)) return () => {};
  return followTerminalTheme({
    transport: { write: terminal.write, onData: tap },
    closet: watch.themes,
    dress: (theme) => dressedIn(theme, watch.overrides),
    repaint: watch.repaint,
  });
}

const stdinTap: InputTap = (listener) => {
  const onData = (chunk: Buffer | string): void => listener(chunk.toString());
  process.stdin.on("data", onData);
  return () => void process.stdin.off("data", onData);
};

function focusedWindowTitle(sessions: SessionPanes, terminalFocused: boolean): WindowTitleState {
  const focused = sessions.focused();
  if (focused === undefined) return { state: "idle" };
  return {
    name: focused.pane.titled() ?? focused.id,
    state: focused.pane.lifecycle(),
    ...(!terminalFocused && { spend: focused.pane.spend() }),
  };
}

function recordingAgents(
  factory: AgentFactory | undefined,
  recorder: EventRecorder,
): AgentFactory | undefined {
  if (factory === undefined) return undefined;
  return (guard, history, seams, bot) => {
    const agent = factory(guard, history, seams, bot);
    recorder.follow(agent.bus);
    return agent;
  };
}

function hostClipboardPort(): ClipboardPort | undefined {
  try {
    const host = createHostClipboard();
    return { read: () => readHostClipboard(host) };
  } catch {
    return undefined;
  }
}

async function readHostClipboard(
  host: ReturnType<typeof createHostClipboard>,
): Promise<ClipboardRead> {
  const result = await host.read({ preferredTypes: clipboardTypes });
  if (result.status !== "read")
    return { kind: result.status === "empty" ? "empty" : "unsupported" };
  const { mimeType, bytes } = result.representation;
  if (mimeType === "text/plain") return { kind: "text", text: new TextDecoder().decode(bytes) };
  const image = imageFromBytes(bytes, mimeType);
  return image === undefined ? { kind: "unsupported" } : { kind: "image", image };
}

const clipboardTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
] as const;

function bugFacts(
  options: AppOptions,
  sessions: SessionPanes,
  terminal: Terminal,
  glyphs: GlyphSupport,
  events: readonly RecordedEvent[],
): BugBundleFacts {
  const env = options.terminal?.facts?.env ?? process.env;
  const focused = sessions.focused();
  const model = focused?.pane.model;
  return {
    version: options.bugReport?.version,
    os: { platform: process.platform, release: osRelease(), arch: process.arch },
    bun: process.versions.bun,
    terminal: {
      TERM: env.TERM,
      TERM_PROGRAM: env.TERM_PROGRAM,
      TERM_PROGRAM_VERSION: env.TERM_PROGRAM_VERSION,
      COLORTERM: env.COLORTERM,
      windowsTerminal: env.WT_SESSION !== undefined,
      multiplexer: env.TMUX !== undefined || env.ZELLIJ !== undefined || env.STY !== undefined,
      ssh: env.SSH_CONNECTION !== undefined || env.SSH_TTY !== undefined,
      glyphTier: glyphs.glyphTier,
      notifications: terminal.notifier.transport,
    },
    config: options.bugReport?.config?.(),
    events,
    ...(model !== undefined && {
      session: sessionShape(model.currentAgent()?.history() ?? [], model.entries, [], {
        id: focused?.pane.sessionId,
        model: sessions.currentModel(),
      }),
    }),
  };
}

function workSnapshot(sessions: SessionPanes, inbox: number): WorkSnapshot {
  const focused = sessions.focused();
  return {
    title: focused === undefined ? "keywork" : (focused.pane.titled() ?? focused.id),
    asks: sessions.awaiting(),
    inbox,
  };
}

function botLookup(
  bots: BotsPort | undefined,
): ((name: string) => BotEntry | undefined) | undefined {
  if (bots === undefined) return undefined;
  return (name) => bots.defined().find((bot) => bot.name === name);
}

function botSpendLookup(
  bots: BotsPort | undefined,
): ((name: string) => Promise<BotSummary | undefined>) | undefined {
  if (bots === undefined) return undefined;
  return async (name) => (await bots.list()).find((bot) => bot.name === name);
}

function paintFrame(
  renderer: CliRenderer,
  core: AppCore,
  inputs: FrameInputs,
  scrim: boolean,
): void {
  discardFrame(renderer.root);
  renderer.root.add(appFrame(core, inputs));
  const overlay = overlayView(core, { ...inputs, scrim });
  if (overlay !== undefined) renderer.root.add(overlay);
  renderer.requestRender();
}

function wireInput(
  renderer: CliRenderer,
  core: AppCore,
  contain: (scope: string, work: () => void) => void,
  render: () => void,
  inset: () => number,
  pointerOn: boolean,
  settleMotion: () => void,
): void {
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    contain("key", () => {
      settleMotion();
      const chord = chordOf(key);
      if (chord === undefined) return;
      core.handleKey(chord, key.sequence, performance.now(), key.eventType === "repeat");
    });
    render();
  });
  renderer.keyInput.on("paste", (event: PasteEvent) => {
    contain("paste", () =>
      core.handlePaste(new TextDecoder().decode(event.bytes), {
        mimeType: event.metadata?.mimeType,
        kind: event.metadata?.kind,
        bytes: event.bytes,
      }),
    );
    render();
  });
  if (pointerOn) {
    renderer.root.onMouse = (event: MouseEvent) => {
      contain("mouse", () => {
        const pointer = pointerEventOf(event);
        if (pointer === undefined) return;
        const handled = core.handleMouse({
          ...pointer,
          x: pointer.x - inset(),
          y: pointer.y - inset(),
        });
        if (pointer.type !== "move" || handled || core.overlayOpen) render();
      });
    };
  }
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

function defaultRenderer(pointerOn: boolean): Promise<CliRenderer> {
  return createCliRenderer({
    exitOnCtrlC: false,
    useMouse: pointerOn,
    enableMouseMovement: pointerOn,
  });
}
