import type { Direction } from "./geometry.ts";
import type { SummonableKind } from "./pane-kinds.ts";

export interface ActionTarget {
  splitPane(arc: "inherit" | "new"): void;
  closePane(): void;
  zoomPane(): void;
  focusToward(direction: Direction): void;
  movePane(direction: Direction): void;
  cyclePane(): void;
  pinPane(): void;
  resizeDock(delta: number): void;
  resizePane(delta: number): void;
  summon(kind: SummonableKind): void;
  toggleHelp(): void;
  openPalette(initialQuery?: string): void;
  shutdown(): void;
}

export interface ActionCommand {
  name: string;
  description: string;
  aliases?: string[];
}

export type AppAction = {
  chords: string | readonly string[];
  help: string;
  sticky?: true;
  chainable?: true;
  invoke: (target: ActionTarget) => void;
} & ({ command: ActionCommand } | { coveredBy: string });

export const appActions: Record<string, AppAction> = {
  "pane.split": {
    chords: "leader s",
    help: "new session pane",
    sticky: true,
    invoke: (target) => target.splitPane("inherit"),
    command: { name: "split", description: "open a new session pane in this arc" },
  },
  "pane.splitArc": {
    chords: "leader shift+s",
    help: "new session in a new arc",
    sticky: true,
    invoke: (target) => target.splitPane("new"),
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
    invoke: (target) => target.closePane(),
    coveredBy: "exit",
  },
  "pane.zoom": {
    chords: "leader z",
    help: "zoom pane (toggle)",
    sticky: true,
    invoke: (target) => target.zoomPane(),
    command: { name: "zoom", description: "zoom the focused pane" },
  },
  "focus.left": {
    chords: ["leader h", "leader left"],
    help: "focus left",
    sticky: true,
    invoke: (target) => target.focusToward("left"),
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
    invoke: (target) => target.focusToward("down"),
    command: { name: "move-down", description: "focus the pane below", aliases: ["movedown"] },
  },
  "focus.up": {
    chords: ["leader k", "leader up"],
    help: "focus up",
    sticky: true,
    invoke: (target) => target.focusToward("up"),
    command: { name: "move-up", description: "focus the pane above", aliases: ["moveup"] },
  },
  "focus.right": {
    chords: ["leader l", "leader right"],
    help: "focus right",
    sticky: true,
    invoke: (target) => target.focusToward("right"),
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
    invoke: (target) => target.movePane("left"),
    command: { name: "push-left", description: "move this pane left", aliases: ["pushleft"] },
  },
  "move.down": {
    chords: "leader shift+j",
    help: "move pane down",
    sticky: true,
    invoke: (target) => target.movePane("down"),
    command: { name: "push-down", description: "move this pane down", aliases: ["pushdown"] },
  },
  "move.up": {
    chords: "leader shift+k",
    help: "move pane up",
    sticky: true,
    invoke: (target) => target.movePane("up"),
    command: { name: "push-up", description: "move this pane up", aliases: ["pushup"] },
  },
  "move.right": {
    chords: "leader shift+l",
    help: "move pane right",
    sticky: true,
    invoke: (target) => target.movePane("right"),
    command: { name: "push-right", description: "move this pane right", aliases: ["pushright"] },
  },
  "dock.cycle": {
    chords: "leader c",
    help: "cycle pane main → left → right",
    sticky: true,
    invoke: (target) => target.cyclePane(),
    command: {
      name: "dock-cycle",
      description: "move this pane to its next home: main → left → right",
      aliases: ["cycle"],
    },
  },
  "dock.pin": {
    chords: "leader p",
    help: "pin docked pane (toggle)",
    chainable: true,
    invoke: (target) => target.pinPane(),
    command: {
      name: "pin",
      description: "pin this docked pane to the head of its dock (toggle)",
    },
  },
  "dock.grow": {
    chords: "leader .",
    help: "widen this pane's dock",
    sticky: true,
    invoke: (target) => target.resizeDock(0.05),
    command: { name: "dock-wider", description: "widen this pane's dock" },
  },
  "dock.shrink": {
    chords: "leader ,",
    help: "narrow this pane's dock",
    sticky: true,
    invoke: (target) => target.resizeDock(-0.05),
    command: { name: "dock-narrower", description: "narrow this pane's dock" },
  },
  "pane.grow": {
    chords: "leader shift+.",
    help: "grow the focused pane",
    sticky: true,
    invoke: (target) => target.resizePane(0.05),
    command: { name: "grow", description: "grow the focused pane", aliases: ["pane-grow"] },
  },
  "pane.shrink": {
    chords: "leader shift+,",
    help: "shrink the focused pane",
    sticky: true,
    invoke: (target) => target.resizePane(-0.05),
    command: { name: "shrink", description: "shrink the focused pane", aliases: ["pane-shrink"] },
  },
  "browser.summon": {
    chords: "leader f",
    help: "file browser",
    chainable: true,
    invoke: (target) => target.summon("browser"),
    coveredBy: "browse",
  },
  "tree.summon": {
    chords: "leader t",
    help: "session tree",
    chainable: true,
    invoke: (target) => target.summon("session-tree"),
    coveredBy: "tree",
  },
  "memory.summon": {
    chords: "leader m",
    help: "memory pane",
    chainable: true,
    invoke: (target) => target.summon("memory"),
    coveredBy: "memory",
  },
  "arcs.summon": {
    chords: "leader a",
    help: "arcs node",
    chainable: true,
    invoke: (target) => target.summon("arcs"),
    coveredBy: "arcs",
  },
  "help.toggle": {
    chords: ["leader /", "f1"],
    help: "this overlay",
    invoke: (target) => target.toggleHelp(),
    command: { name: "keys", description: "show the hotkeys overlay", aliases: ["help"] },
  },
  "palette.go": {
    chords: "ctrl+p",
    help: "quick open (/ commands)",
    invoke: (target) => target.openPalette(),
    command: { name: "go", description: "jump to a pane (type > for commands)" },
  },
  "palette.commands": {
    chords: ["leader i", "ctrl+shift+p"],
    help: "command palette",
    invoke: (target) => target.openPalette("/"),
    command: {
      name: "palette",
      description: "open the command palette",
      aliases: ["commands"],
    },
  },
  "app.quit": {
    chords: "ctrl+q",
    help: "quit",
    invoke: (target) => target.shutdown(),
    coveredBy: "exit-all",
  },
};

export const actionCommandNames: Record<string, string> = Object.fromEntries(
  Object.entries(appActions).map(([name, action]) => [name, commandNameOf(action)]),
);

export const appBindings: Record<string, string | readonly string[]> = Object.fromEntries(
  Object.entries(appActions).map(([name, action]) => [name, action.chords]),
);

export const bindingHelp: Record<string, string> = Object.fromEntries(
  Object.entries(appActions).map(([name, action]) => [name, action.help]),
);

export const stickyActions: ReadonlySet<string> = new Set(
  Object.entries(appActions)
    .filter(([, action]) => action.sticky)
    .map(([name]) => name),
);

export const chainActions: ReadonlySet<string> = new Set(
  Object.entries(appActions)
    .filter(([, action]) => action.sticky || action.chainable)
    .map(([name]) => name),
);

export function actionCovering(commandName: string): string | undefined {
  return Object.entries(appActions).find(
    ([, action]) => "coveredBy" in action && action.coveredBy === commandName,
  )?.[0];
}

function commandNameOf(action: AppAction): string {
  return "command" in action ? action.command.name : action.coveredBy;
}
