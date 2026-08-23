import { actionCovering, appActions } from "./app-actions.ts";
import type { AppCore } from "./app-core.ts";
import type { CommandSpec } from "./commands.ts";
import { type PaneKind, paneKindAvailable } from "./pane-kinds.ts";

export function registerCoreCommands(core: AppCore): void {
  const shortcut = (action: string | undefined): Pick<CommandSpec, "shortcut"> => {
    const keys = action === undefined ? undefined : core.keymap.describe(action);
    return keys === undefined ? {} : { shortcut: keys };
  };
  for (const [name, action] of Object.entries(appActions)) {
    if (!("command" in action)) continue;
    const { aliases, ...command } = action.command;
    core.registry.register({
      ...command,
      ...(aliases !== undefined && { aliases }),
      ...shortcut(name),
      run: () => action.invoke(core),
    });
  }
  for (const command of builtinCommands(core)) {
    core.registry.register({ ...command, ...shortcut(actionCovering(command.name)) });
  }
  core.registry.addSource(() => jumpCommands(core));
}

function builtinCommands(core: AppCore): CommandSpec[] {
  const { options } = core;
  const available = (kind: PaneKind) => paneKindAvailable(options, kind);
  return [
    ...dockCommands(core),
    {
      name: "undock",
      description: "return this pane to the main area",
      run: () => core.undockPane(),
    },
    ...when(available("file"), {
      name: "open",
      aliases: ["view"],
      description: "open a file viewer pane: /open <path>",
      needsArgs: true,
      run: (args) => {
        if (args !== undefined && args !== "") core.openPath(args);
      },
    }),
    ...when(available("browser"), {
      name: "browse",
      aliases: ["files"],
      description: "open the file browser: /browse [dir]",
      run: (args) =>
        args === undefined || args === "" ? core.summon("browser") : core.openBrowser(args),
    }),
    ...when(available("session-tree"), {
      name: "tree",
      aliases: ["session-tree", "sessions"],
      description: "open the session tree: /tree",
      run: () => core.summon("session-tree"),
    }),
    ...when(available("memory"), {
      name: "memory",
      description: "open the memory pane: /memory",
      run: () => core.summon("memory"),
    }),
    ...when(available("arcs"), {
      name: "arcs",
      description: "open the arcs node: /arcs",
      run: () => core.summon("arcs"),
    }),
    ...when(available("mcp"), {
      name: "mcp",
      description: "open the MCP status pane: /mcp",
      run: () => core.summon("mcp"),
    }),
    ...when(options.workspaces !== undefined, {
      name: "workspace",
      aliases: ["workspaces"],
      description:
        "switch or create a workspace over this root: /workspace [slug | new <slug> | default]",
      run: (args) => core.openWorkspaceCommand(args),
    }),
    ...when(options.workspaceSetup !== undefined, {
      name: "init",
      aliases: ["trust"],
      description: "trust this folder and set up its workspace, memory and arcs included: /init",
      run: () => core.openWorkspaceSetup(),
    }),
    ...when(options.arcs !== undefined, {
      name: "arc",
      description:
        "bind this session to an arc: /arc [slug | new [slug] | none | close | abandon <slug>]",
      run: (args) => core.openArcCommand(args),
    }),
    ...when(options.presets !== undefined, {
      name: "preset",
      aliases: ["presets"],
      description: "switch the permissions preset: /preset",
      run: () => core.openPresetPicker(),
    }),
    ...when(options.inference !== undefined, {
      name: "model",
      aliases: ["models"],
      description: "pick the model for this session: /model [provider/model]",
      run: (args) => core.openModelPicker(args),
    }),
    ...when(options.connections !== undefined, {
      name: "connect",
      aliases: ["setup", "new-provider"],
      description: "add or verify an inference provider: /connect [target|url]",
      run: (args) => core.openConnect(args),
    }),
    ...undoCommands(core),
    {
      name: "exit",
      description: "close this pane · quits keywork if it's the last",
      run: () => core.closePane(),
    },
    {
      name: "exit-all",
      aliases: ["exitall", "quit"],
      description: "close every pane and quit keywork",
      run: () => core.shutdown(),
    },
  ];
}

function dockCommands(core: AppCore): CommandSpec[] {
  return (["left", "right"] as const).flatMap((side) => [
    {
      name: `dock-${side}`,
      description: `dock this pane to the ${side} edge`,
      aliases: [`dock${side}`],
      run: () => core.dockPane(side),
    },
    {
      name: `dock-${side}-wider`,
      description: `widen the ${side} dock`,
      run: () => core.resizeDockSide(side, 0.05),
    },
    {
      name: `dock-${side}-narrower`,
      description: `narrow the ${side} dock`,
      run: () => core.resizeDockSide(side, -0.05),
    },
  ]);
}

function undoCommands(core: AppCore): CommandSpec[] {
  const undo = core.options.undo;
  if (undo === undefined) return [];
  const announce = (outcome: Promise<boolean>, done: string, empty: string) =>
    core.settle(outcome.then((changed) => core.postNotice(changed ? done : empty)));
  return [
    {
      name: "undo",
      description: "undo the last agent file change",
      run: () => announce(undo.undo(), "files put back", "nothing to undo"),
    },
    {
      name: "redo",
      description: "redo the last undone change",
      run: () => announce(undo.redo(), "files redone", "nothing to redo"),
    },
  ];
}

function jumpCommands(core: AppCore): CommandSpec[] {
  const focused = core.layout.focused();
  const targets = core.layout
    .panes()
    .filter((id) => id !== focused)
    .map((id) => ({ id, title: core.panes.get(id)?.title().trim().split(" ·")[0] ?? id }));
  const titleCounts = new Map<string, number>();
  for (const { title } of targets) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  return targets.map(({ id, title }) => {
    const distinct = (titleCounts.get(title) ?? 0) > 1 ? `${title} ${id}` : title;
    return {
      name: `go-${distinct}`,
      label: distinct,
      description: "jump to this pane",
      jump: true as const,
      run: () => core.focusPane(id),
    };
  });
}

function when(condition: boolean, command: CommandSpec): CommandSpec[] {
  return condition ? [command] : [];
}
