import { commandWords, gitInvocation, programName } from "./command-words.ts";

export type DestructiveRemembrance = "exact-command" | "nothing";

export function destructiveRemembrance(part: string): DestructiveRemembrance | undefined {
  const words = commandWords(part);
  return destructiveCommands.find((command) => command.matches(words))?.remembered;
}

export function isDestructiveCommand(part: string): boolean {
  return destructiveRemembrance(part) !== undefined;
}

type WordsMatcher = (words: readonly string[]) => boolean;

interface DestructiveCommand {
  readonly matches: WordsMatcher;
  readonly remembered: DestructiveRemembrance;
}

const destructiveCommands: readonly DestructiveCommand[] = [
  {
    matches: runsProgram("rm", "rmdir", "rd", "del", "erase", "remove-item"),
    remembered: "exact-command",
  },
  { matches: runsGit("branch", (args) => args.includes("-D")), remembered: "exact-command" },
  { matches: runsGit("push", (args) => args.some(forcesPush)), remembered: "nothing" },
  { matches: runsGit("reset", (args) => args.includes("--hard")), remembered: "nothing" },
  { matches: runsGit("clean", () => true), remembered: "nothing" },
  { matches: runsGit("checkout", discardsWorkingTree), remembered: "nothing" },
];

function runsProgram(...names: string[]): WordsMatcher {
  return ([program]) => program !== undefined && names.includes(programName(program));
}

function runsGit(subcommand: string, argumentsMatch: WordsMatcher): WordsMatcher {
  return (words) => {
    const git = gitInvocation(words);
    return git?.subcommand === subcommand && argumentsMatch(git.args);
  };
}

function forcesPush(arg: string): boolean {
  return arg.startsWith("--force") || /^-[A-Za-z]*f/.test(arg) || arg.startsWith("+");
}

function discardsWorkingTree(args: readonly string[]): boolean {
  return args.includes("--") || args.includes(".");
}
