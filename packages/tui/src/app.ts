import type { Agent } from "@keywork/engine";
import { Box, createCliRenderer, type KeyEvent, Text } from "@opentui/core";
import type { Titler } from "./conversation-model.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { Keymap } from "./keymap.ts";
import { chordOf, formatChord } from "./keys.ts";
import { type Direction, Layout, type LayoutNode, type Screen } from "./layout.ts";
import type { Pane, PaneView } from "./pane.ts";
import { resolveTheme, type Theme } from "./theme.ts";

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
  "help.toggle": ["leader /", "f1"],
  "app.quit": "ctrl+q",
} as const;

const bindingHelp: Record<string, string> = {
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
  "help.toggle": "this overlay",
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
]);

export interface AppOptions {
  themeOverrides?: Record<string, string>;
  agentFactory?: () => Agent;
  titler?: Titler;
  statusLabel?: string;
}

export async function runApp(options: AppOptions = {}): Promise<void> {
  const theme = resolveTheme(options.themeOverrides);
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const layout = new Layout();
  const keymap = new Keymap({ leader: "ctrl+k", bindings: appBindings });
  const panes = new Map<string, Pane>();
  let nextSession = 1;
  let leaderArmed = false;
  let helpVisible = false;
  let lastKey = "";

  const screen = (): Screen => ({ width: renderer.width, height: renderer.height });
  const notify = (): void => render();

  const openPane = (): void => {
    const id = `session-${nextSession}`;
    nextSession += 1;
    panes.set(id, new ConversationPane(id, options.agentFactory?.(), notify, options.titler));
    layout.open(id, screen());
  };

  const closePane = (): void => {
    const id = layout.focused();
    if (id === undefined || panes.size <= 1) return;
    panes.get(id)?.dispose?.();
    panes.delete(id);
    layout.close(id);
  };

  const shutdown = (): void => {
    for (const pane of panes.values()) pane.dispose?.();
    renderer.destroy();
    process.exit(0);
  };

  const apply = (action: string): void => {
    const focusDirection = focusDirections[action];
    const swapDirection = swapDirections[action];
    if (action === "pane.split") openPane();
    else if (action === "pane.close") closePane();
    else if (action === "pane.zoom") layout.zoomToggle();
    else if (action === "help.toggle") helpVisible = !helpVisible;
    else if (focusDirection !== undefined) layout.moveFocus(focusDirection, screen());
    else if (swapDirection !== undefined) layout.swap(swapDirection, screen());
    else if (action === "app.quit") shutdown();
  };

  const render = (): void => {
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
          borderColor: leaderArmed ? theme.accent : theme.border,
        },
        buildBody(layout, panes, theme, screen()),
        statusBar(layout, leaderArmed, theme, lastKey, options.statusLabel),
      ),
    );
    if (helpVisible) renderer.root.add(helpOverlay(keymap, theme, screen()));
    renderer.requestRender();
  };

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    const chord = chordOf(key);
    if (chord === undefined) return;
    lastKey = formatChord(chord);
    if (chord.ctrl && chord.name === "q") return shutdown();
    if (helpVisible && chord.name === "escape") {
      helpVisible = false;
      render();
      return;
    }
    const now = performance.now();
    const result = keymap.press(chord, now);
    leaderArmed = result.type === "leader-pending";
    if (result.type === "action") {
      apply(result.action);
      if (stickyActions.has(result.action)) {
        keymap.arm(now);
        leaderArmed = true;
      }
    } else if (result.type === "pass") routeToFocusedPane(chord, key.sequence);
    render();
  });

  const routeToFocusedPane = (chord: ReturnType<typeof chordOf>, sequence: string | undefined) => {
    const id = layout.focused();
    if (id === undefined || chord === undefined) return;
    panes.get(id)?.handleKey?.(chord, sequence);
  };

  renderer.auto();
  openPane();
  render();
}

function buildBody(layout: Layout, panes: Map<string, Pane>, theme: Theme, screen: Screen) {
  const rects = layout.rects(screen);
  const focused = layout.focused();
  const zoomed = layout.zoomed();
  const paneView = (id: string): PaneView | undefined => {
    const rect = rects.get(id) ?? { x: 0, y: 0, width: screen.width, height: screen.height };
    return panes.get(id)?.view({
      theme,
      focused: id === focused,
      width: rect.width,
      height: rect.height,
    });
  };
  const body = zoomed !== undefined ? paneView(zoomed) : treeView(layout.root(), paneView);
  return Box({ flexGrow: 1, flexDirection: "row" }, body ?? emptyView(theme));
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
    { flexGrow: 1, alignItems: "center", justifyContent: "center" },
    Text({ content: "ctrl+k s opens a session", fg: theme.textDim }),
  );
}

function statusBar(
  layout: Layout,
  leaderArmed: boolean,
  theme: Theme,
  lastKey: string,
  label: string | undefined,
) {
  const hint = leaderArmed
    ? "nav · h/j/k/l focus  H/J/K/L swap  s split  x close  z zoom  / keys · esc done"
    : `${label ?? "keywork"} · ${layout.panes().length} panes · ctrl+k nav · ctrl+k / keys`;
  return Box(
    {
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: theme.panel,
    },
    Text({ content: hint, fg: leaderArmed ? theme.accent : theme.textDim }),
    Text({ content: lastKey, fg: theme.textDim }),
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
  const width = Math.min(52, screen.width - 4);
  const height = rows.length + 4;
  return Box(
    {
      position: "absolute",
      left: Math.max(2, Math.floor((screen.width - width) / 2)),
      top: Math.max(1, Math.floor((screen.height - height) / 2)),
      width,
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
