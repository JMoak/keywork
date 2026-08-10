export interface CommandSpec {
  name: string;
  description: string;
  aliases?: readonly string[];
  shortcut?: string;
  run(): void;
}

export interface CommandMatch {
  command: CommandSpec;
  score: number;
}

export class CommandRegistry {
  private readonly commands: CommandSpec[] = [];

  register(command: CommandSpec): void {
    this.commands.push(command);
  }

  all(): readonly CommandSpec[] {
    return this.commands;
  }

  search(query: string): CommandSpec[] {
    const trimmed = query.trim().toLowerCase();
    if (trimmed === "") return [...this.commands];
    return this.commands
      .map((command) => ({ command, score: bestScore(command, trimmed) }))
      .filter((match): match is CommandMatch => match.score !== undefined)
      .sort((left, right) => right.score - left.score)
      .map((match) => match.command);
  }

  run(input: string): boolean {
    const name = input.trim().toLowerCase();
    const exact = this.commands.find(
      (command) => command.name === name || command.aliases?.includes(name),
    );
    if (exact === undefined) return false;
    exact.run();
    return true;
  }
}

function bestScore(command: CommandSpec, query: string): number | undefined {
  const candidates = [command.name, ...(command.aliases ?? [])];
  const scores = candidates
    .map((candidate) => fuzzyScore(query, candidate))
    .filter((score): score is number => score !== undefined);
  return scores.length === 0 ? undefined : Math.max(...scores);
}

export function fuzzyScore(query: string, candidate: string): number | undefined {
  if (query === candidate) return 1000;
  if (candidate.startsWith(query)) return 500 + query.length - candidate.length / 100;
  let score = 0;
  let at = 0;
  let previousHit = -2;
  for (const character of query) {
    const found = candidate.indexOf(character, at);
    if (found === -1) return undefined;
    score += found === previousHit + 1 ? 10 : 1;
    if (found === 0 || candidate[found - 1] === "-") score += 5;
    previousHit = found;
    at = found + 1;
  }
  return score - candidate.length / 100;
}
