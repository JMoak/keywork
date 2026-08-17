export const usage = `keywork: a coding agent you drive from the keyboard

Usage:
  keywork [panes] [--fresh]                                 tiled multi-session workspace
  keywork run "<prompt>" [--model <model>] [--json] [--debug]
              [--session-dir <dir>]                         one-shot headless run
  keywork sessions [list|tree|fork] [id] [ref]              inspect and fork session trees
  keywork setup                                             connect a model provider
  keywork init                                              set up the workspace at its anchor
  keywork link <dir>                                        widen the workspace to another folder
  keywork trust | untrust                                   grant or revoke workspace trust
  keywork doctor                                            show what your terminal supports
  keywork chat [--model <model>] [--continue]
               [--resume <session-id>]                      engine smoke REPL (debug)
`;

export const nonInteractiveUsage = `keywork: no command given and no terminal attached. Scripts want \`keywork run "<prompt>" [--json]\`.

${usage}`;

export type Dispatch =
  | { kind: "command"; command: string; rest: string[] }
  | { kind: "usage"; exitCode: number };

export function dispatchCommand(argv: readonly string[], interactive: boolean): Dispatch {
  const [first] = argv;
  if (first !== undefined && !first.startsWith("-")) {
    return { kind: "command", command: first, rest: argv.slice(1) };
  }
  if (interactive) return { kind: "command", command: "panes", rest: [...argv] };
  return { kind: "usage", exitCode: 1 };
}
