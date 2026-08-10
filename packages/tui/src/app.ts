import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { Agent, Message, ToolGuard } from "@keywork/engine";
import {
  Box,
  createCliRenderer,
  type KeyEvent,
  type MouseEvent,
  type PasteEvent,
  Text,
} from "@opentui/core";
import { AppCore, bindingHelp, helpFrame, paletteFrame } from "./app-core.ts";
import { BrowserPane } from "./browser-pane.ts";
import type { Titler } from "./conversation-model.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { FilePane } from "./file-pane.ts";
import type { Keymap } from "./keymap.ts";
import { chordOf } from "./keys.ts";
import { dockColumnWidth, type LayoutNode, type Screen } from "./layout.ts";
import type { PaneView } from "./pane.ts";
import { pointerEventOf } from "./pointer.ts";
import { resolveTheme, type Theme } from "./theme.ts";
import { parseWorkspaceState, type WorkspacePane, type WorkspaceState } from "./workspace-state.ts";

export interface CheckpointsPort {
  capture(): Promise<void>;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
}

export interface SessionAttachment {
  id: string;
  history: readonly Message[];
  replay(bus: Agent["bus"]): void;
  append(message: Message): Promise<void>;
}

export interface SessionPort {
  open(id: string): Promise<SessionAttachment | undefined>;
  create(): Promise<SessionAttachment | undefined>;
}

export interface WorkspacePort {
  load(): Promise<unknown>;
  save(state: WorkspaceState): void;
  flush(): void;
}

export interface AppOptions {
  themeOverrides?: Record<string, string>;
  agentFactory?: (guard: ToolGuard, history?: readonly Message[]) => Agent;
  titler?: Titler;
  statusLabel?: string;
  checkpoints?: CheckpointsPort;
  workspace?: WorkspacePort;
  sessions?: SessionPort;
}

export async function runApp(options: AppOptions = {}): Promise<void> {
  const theme = resolveTheme(options.themeOverrides);
  const restored = await loadRestorePlan(options);
  const renderer = await createCliRenderer({ exitOnCtrlC: false, enableMouseMovement: true });
  const chrome = { border: 1, statusRows: 1 };
  const screen = (): Screen => ({
    width: Math.max(0, renderer.width - 2 * chrome.border),
    height: Math.max(0, renderer.height - 2 * chrome.border - chrome.statusRows),
  });
  const checkpoints = options.checkpoints;
  const core = new AppCore({
    screen,
    createPane: (id, notify, commands, resumeSessionId) => {
      let pane: ConversationPane | undefined;
      const guard: ToolGuard = {
        confirm: (call) => pane?.confirmMutation(call) ?? Promise.resolve(true),
        ...(checkpoints !== undefined && { beforeMutation: () => checkpoints.capture() }),
      };
      const attachment =
        resumeSessionId === undefined ? undefined : restored?.attachments.get(resumeSessionId);
      const agent = options.agentFactory?.(guard, attachment?.history);
      pane = new ConversationPane(id, agent, notify, options.titler, commands);
      wireSession(pane, agent, attachment, options.sessions, notify);
      return pane;
    },
    createFilePane: (id, path, notify) => new FilePane(id, process.cwd(), path, notify),
    createBrowserPane: (id, root, notify, intents) =>
      new BrowserPane(id, resolve(process.cwd(), root), notify, intents),
    isDirectory: (path) =>
      statSync(resolve(process.cwd(), path), { throwIfNoEntry: false })?.isDirectory() === true,
    ...(checkpoints !== undefined && { undo: checkpoints }),
    ...(restored !== undefined && { restoreWorkspace: restored.state }),
    ...(options.workspace !== undefined && {
      saveWorkspace: (state: WorkspaceState) => options.workspace?.save(state),
    }),
    onExit: () => {
      renderer.destroy();
      options.workspace?.flush();
      process.exit(0);
    },
  });

  let armedExpiry: ReturnType<typeof setTimeout> | undefined;
  const watchArmedExpiry = (): void => {
    if (armedExpiry !== undefined) clearTimeout(armedExpiry);
    if (!core.leaderArmed) return;
    armedExpiry = setTimeout(() => {
      core.expireArmed(performance.now());
      render();
    }, core.keymap.timeoutMs + 50);
  };

  const render = (): void => {
    watchArmedExpiry();
    for (const child of [...renderer.root.getChildren()]) renderer.root.remove(child);
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
    renderer.requestRender();
  };

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    const chord = chordOf(key);
    if (chord === undefined) return;
    core.handleKey(chord, key.sequence, performance.now(), key.eventType === "repeat");
    render();
  });

  renderer.keyInput.on("paste", (event: PasteEvent) => {
    core.handlePaste(new TextDecoder().decode(event.bytes));
    render();
  });

  renderer.root.onMouse = (event: MouseEvent) => {
    const pointer = pointerEventOf(event);
    if (pointer === undefined) return;
    core.handleMouse(
      { ...pointer, x: pointer.x - chrome.border, y: pointer.y - chrome.border },
      performance.now(),
    );
    render();
  };

  renderer.on("resize", () => render());

  renderer.auto();
  core.bindNotify(render);
  core.start();
  render();
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
  }
}

function statKind(path: string) {
  return statSync(path, { throwIfNoEntry: false });
}

function wireSession(
  pane: ConversationPane,
  agent: Agent | undefined,
  attachment: SessionAttachment | undefined,
  sessions: SessionPort | undefined,
  notify: () => void,
): void {
  if (attachment !== undefined) {
    adoptSession(pane, agent, attachment);
    return;
  }
  if (agent === undefined || sessions === undefined) return;
  void sessions
    .create()
    .then((created) => {
      if (created === undefined) return;
      adoptSession(pane, agent, created);
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
  if (agent === undefined) return;
  attachment.replay(agent.bus);
  recordTurns(agent, attachment);
}

function recordTurns(agent: Agent, attachment: SessionAttachment): void {
  let persisted = attachment.history.length;
  let writes: Promise<void> = Promise.resolve();
  const record = (): void => {
    const fresh = agent.history().slice(persisted);
    persisted += fresh.length;
    writes = writes
      .then(async () => {
        for (const message of fresh) await attachment.append(message);
      })
      .catch(() => {});
  };
  agent.bus.on("turn.completed", record);
  agent.bus.on("turn.interrupted", record);
}

function buildBody(core: AppCore, theme: Theme, screen: Screen) {
  const rects = core.layout.rects(screen);
  const focused = core.layout.focused();
  const zoomed = core.layout.zoomed();
  const paneView = (id: string): PaneView | undefined => {
    const rect = rects.get(id) ?? { x: 0, y: 0, width: screen.width, height: screen.height };
    return core.panes.get(id)?.view({
      theme,
      focused: id === focused,
      width: rect.width,
      height: rect.height,
    });
  };
  if (zoomed !== undefined) {
    return Box({ flexGrow: 1, flexDirection: "row" }, paneView(zoomed) ?? emptyView(theme));
  }
  const dock = core.layout.dock();
  const main = treeView(core.layout.root(), paneView);
  if (dock === undefined) {
    return Box({ flexGrow: 1, flexDirection: "row" }, main ?? emptyView(theme));
  }
  const dockColumn = Box(
    { width: dockColumnWidth(screen.width, dock.ratio), flexDirection: "column" },
    ...dock.panes.map(paneView),
  );
  const mainArea = Box({ flexGrow: 1, flexDirection: "row" }, main ?? emptyView(theme));
  return Box(
    { flexGrow: 1, flexDirection: "row" },
    ...(dock.side === "left" ? [dockColumn, mainArea] : [mainArea, dockColumn]),
  );
}

function treeView(
  node: LayoutNode | undefined,
  paneView: (id: string) => PaneView | undefined,
): PaneView | undefined {
  if (node === undefined) return undefined;
  if (node.kind === "leaf") return paneView(node.id);
  return Box(
    { flexDirection: node.orientation, flexGrow: 1, flexBasis: 0 },
    treeView(node.first, paneView),
    treeView(node.second, paneView),
  );
}

function emptyView(theme: Theme) {
  return Box(
    { flexGrow: 1, flexDirection: "column", alignItems: "center", justifyContent: "center" },
    Text({ content: "no sessions open", fg: theme.textDim }),
    Text({ content: "ctrl+k s starts one · ctrl+p commands · ctrl+q quits", fg: theme.textDim }),
  );
}

function statusBar(core: AppCore, theme: Theme, label: string | undefined) {
  const hint =
    core.notice !== ""
      ? core.notice
      : core.leaderArmed
        ? "nav · h/j/k/l focus  H/J/K/L swap  s split  x close  z zoom  d/D dock  u undock · esc done"
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
  const rows = matches.map((command, index) => {
    const active = index === core.paletteIndex;
    const shortcut = command.shortcut === undefined ? "" : `  ${command.shortcut}`;
    return Box(
      { flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1 },
      Text({
        content: `${active ? "▸" : " "} ${command.name} — ${command.description}`,
        fg: active ? theme.accent : theme.text,
      }),
      Text({ content: shortcut, fg: theme.textDim }),
    );
  });
  const frame = paletteFrame(screen, matches.length);
  return Box(
    {
      position: "absolute",
      left: frame.x,
      top: frame.y,
      width: frame.width,
      height: frame.height,
      zIndex: 20,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accent,
      backgroundColor: theme.panel,
      title: " commands ",
      titleAlignment: "center",
      flexDirection: "column",
      paddingTop: 1,
      paddingBottom: 1,
    },
    Text({ content: ` › ${core.paletteQuery}▌`, fg: theme.text }),
    ...(rows.length > 0 ? rows : [Text({ content: "  no matching commands", fg: theme.textDim })]),
  );
}

function helpOverlay(keymap: Keymap, theme: Theme, screen: Screen) {
  const rows = keymap
    .actions()
    .map((action) => ({ action, keys: keymap.describe(action) ?? "" }))
    .map(({ action, keys }) =>
      Box(
        { flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1 },
        Text({ content: keys, fg: theme.accent }),
        Text({ content: bindingHelp[action] ?? action, fg: theme.text }),
      ),
    );
  const frame = helpFrame(screen, rows.length);
  return Box(
    {
      position: "absolute",
      left: frame.x,
      top: frame.y,
      width: frame.width,
      height: frame.height,
      zIndex: 10,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accentSoft,
      backgroundColor: theme.panel,
      title: " keywork keys ",
      titleAlignment: "center",
      flexDirection: "column",
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
