export const usage = `keywork: a coding agent you drive from the keyboard

Usage:
  keywork [panes] [--fresh] [--workspace <slug>]            tiled multi-session workspace
  keywork run "<prompt>" [--model <model>] [--json] [--debug]
              [--preset careful|standard|open]
              [--session-dir <dir>]                         one-shot headless run
  keywork sessions [list|tree|fork] [id] [ref]              inspect and fork session trees
  keywork connect [target|url]                              add or verify an inference provider
                                                            (setup is an alias)
  keywork init                                              set up the workspace at its anchor
  keywork workspace [list|new|use|rm] [slug]                named workspaces over this root
  keywork link <dir>                                        widen the workspace to another folder
  keywork trust | untrust                                   grant or revoke workspace trust
  keywork doctor                                            show what your terminal supports
  keywork --version                                         print the version and exit
  keywork chat [--model <model>] [--continue]
               [--resume <session-id>]                      engine smoke REPL (debug)

Exit codes (keywork run): 0 completed · 1 failed · 2 usage · 3 unresolved · 4 denied · 130 interrupted
`;

export const nonInteractiveUsage = `Scripts want \`keywork run "<prompt>" [--json]\`.

${usage}`;

export const exitCodes = {
  completed: 0,
  failed: 1,
  usage: 2,
  unresolved: 3,
  denied: 4,
  interrupted: 130,
} as const;

export type ExitClass = keyof typeof exitCodes;

export type WithoutTerminal =
  | { behavior: "runs" }
  | { behavior: "runs"; note: string }
  | { behavior: "refused"; reason: string };

export const withoutTerminal: Readonly<Record<string, WithoutTerminal>> = {
  "": { behavior: "refused", reason: "no command given and no terminal attached" },
  panes: { behavior: "refused", reason: "panes needs a terminal" },
  chat: { behavior: "refused", reason: "chat needs a terminal" },
  run: { behavior: "runs", note: "--json streams one event per line for scripts" },
  sessions: { behavior: "runs", note: "fork cleanup confirmations are skipped, never assumed" },
  connect: { behavior: "runs", note: "answers are read line by line from stdin" },
  setup: { behavior: "runs", note: "answers are read line by line from stdin" },
  init: { behavior: "runs", note: "confirmations are skipped, never assumed" },
  workspace: { behavior: "runs", note: "removal confirmations are skipped, never assumed" },
  link: { behavior: "runs", note: "confirmations are skipped, never assumed" },
  trust: { behavior: "runs" },
  untrust: { behavior: "runs" },
  doctor: { behavior: "runs" },
  help: { behavior: "runs" },
};

export type Dispatch =
  | { kind: "command"; command: string; rest: string[] }
  | { kind: "version" }
  | { kind: "usage"; exitCode: typeof exitCodes.usage; reason: string };

const versionFlags = new Set(["--version", "-V"]);

export function dispatchCommand(argv: readonly string[], interactive: boolean): Dispatch {
  const [first] = argv;
  if (first !== undefined && versionFlags.has(first)) return { kind: "version" };
  const command = first !== undefined && !first.startsWith("-") ? first : undefined;
  const rest = command === undefined ? [...argv] : argv.slice(1);
  if (command === undefined && interactive) return { kind: "command", command: "panes", rest };
  const posture = withoutTerminal[command ?? ""];
  if (!interactive && posture?.behavior === "refused") {
    return { kind: "usage", exitCode: exitCodes.usage, reason: posture.reason };
  }
  return { kind: "command", command: command ?? "panes", rest };
}
