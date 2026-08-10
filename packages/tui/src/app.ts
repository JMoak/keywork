import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { Agent, ToolGuard } from "@keywork/engine";
import { Box, createCliRenderer, type KeyEvent, type MouseEvent, Text } from "@opentui/core";
import { AppCore, bindingHelp, helpFrame, paletteFrame } from "./app-core.ts";
import { BrowserPane } from "./browser-pane.ts";
import type { Titler } from "./conversation-model.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { FilePane } from "./file-pane.ts";
import type { Keymap } from "./keymap.ts";
import { chordOf } from "./keys.ts";
import type { LayoutNode, Screen } from "./layout.ts";
import type { PaneView } from "./pane.ts";
import { pointerEventOf } from "./pointer.ts";
import { resolveTheme, type Theme } from "./theme.ts";

export interface CheckpointsPort {
  capture(): Promise<void>;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
}

export interface AppOptions {
  themeOverrides?: Record<string, string>;
  agentFactory?: (guard: ToolGuard) => Agent;
  titler?: Titler;
  statusLabel?: string;
  checkpoints?: CheckpointsPort;
}

export async function runApp(options: AppOptions = {}): Promise<void> {
  const theme = resolveTheme(options.themeOverrides);
  const renderer = await createCliRenderer({ exitOnCtrlC: false, enableMouseMovement: true });
  const screen = (): Screen => ({ width: renderer.width, height: renderer.height });
  const checkpoints = options.checkpoints;
  const core = new AppCore({
    screen,
    createPane: (id, notify, commands) => {
      let pane: ConversationPane | undefined;
      const guard: ToolGuard = {
        confirm: (call) => pane?.confirmMutation(call) ?? Promise.resolve(true),
        ...(checkpoints !== undefined && { beforeMutation: () => checkpoints.capture() }),
      };
      pane = new ConversationPane(
        id,
        options.agentFactory?.(guard),
        notify,
        options.titler,
        commands,
      );
      return pane;
    },
    createFilePane: (id, path, notify) => new FilePane(id, process.cwd(), path, notify),
    createBrowserPane: (id, root, notify, intents) =>
      new BrowserPane(id, resolve(process.cwd(), root), notify, intents),
    isDirectory: (path) =>
      statSync(resolve(process.cwd(), path), { throwIfNoEntry: false })?.isDirectory() === true,
    ...(checkpoints !== undefined && { undo: checkpoints }),
    onExit: () => {
      renderer.destroy();
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
    core.handleKey(chord, key.sequence, performance.now());
    render();
  });

  renderer.root.onMouse = (event: MouseEvent) => {
    const pointer = pointerEventOf(event);
    if (pointer === undefined) return;
    core.handleMouse(pointer, performance.now());
    render();
  };

  renderer.auto();
  core.bindNotify(render);
  core.start();
  render();
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
  const dockPercent = `${Math.round(dock.ratio * 100)}%` as const;
  const dockColumn = Box(
    { width: dockPercent, flexDirection: "column" },
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
