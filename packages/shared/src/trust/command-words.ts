export interface GitInvocation {
  readonly head: readonly string[];
  readonly subcommand: string | undefined;
  readonly args: readonly string[];
}

export function commandWords(part: string): string[] {
  return part.trim().split(/\s+/);
}

export function programName(program: string): string {
  const base = program.split(/[\\/]/).at(-1) ?? program;
  return base.toLowerCase().replace(/\.exe$/, "");
}

export function gitInvocation(words: readonly string[]): GitInvocation | undefined {
  const [program, ...rest] = words;
  if (program === undefined || programName(program) !== "git") return undefined;
  const optionsEnd = globalOptionsLength(rest);
  const subcommand = rest[optionsEnd];
  return {
    head: subcommand === undefined ? [] : words.slice(0, optionsEnd + 2),
    subcommand,
    args: rest.slice(optionsEnd + 1),
  };
}

const gitOptionsTakingAValue = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
]);

function globalOptionsLength(words: readonly string[]): number {
  let length = 0;
  while (words[length]?.startsWith("-")) {
    length += gitOptionsTakingAValue.has(words[length] ?? "") ? 2 : 1;
  }
  return Math.min(length, words.length);
}
