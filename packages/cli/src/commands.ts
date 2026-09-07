import { homedir } from "node:os";
import {
  type BotDefinition,
  bashTool,
  bundledSkillsRoot,
  type CommandDefinition,
  type CommandRuntime,
  discoverSkills,
  type ExtensionLoadFailure,
  fileEmbedder,
  type LayerRoots,
  loadBots,
  loadCommands,
  type SkillDefinition,
  type ToolCallPart,
  type ToolGuard,
} from "@keywork/engine";

export interface WorkspaceExtensions {
  commands: CommandDefinition[];
  bots: BotDefinition[];
  skills: SkillDefinition[];
  failures: ExtensionLoadFailure[];
}

export interface CommandInvocation {
  command: CommandDefinition;
  args: string;
}

export async function loadWorkspaceExtensions(
  cwd: string,
  projectTrusted: boolean,
  userRoot = homedir(),
): Promise<WorkspaceExtensions> {
  const roots: LayerRoots = { userRoot, ...(projectTrusted && { projectRoot: cwd }) };
  const [commands, bots, skills] = await Promise.all([
    loadCommands(roots),
    loadBots(roots),
    discoverSkills({ ...roots, bundledRoot: bundledSkillsRoot }),
  ]);
  return {
    commands: commands.commands,
    bots: bots.bots,
    skills: skills.skills,
    failures: [...commands.failures, ...bots.failures, ...skills.failures],
  };
}

export interface SlashLine {
  name: string;
  args: string;
}

export function parseSlashLine(line: string): SlashLine | undefined {
  if (!line.startsWith("/")) return undefined;
  const [name = "", ...rest] = line.slice(1).split(/\s+/);
  return name === "" ? undefined : { name, args: rest.join(" ").trim() };
}

export function resolveSlashCommand(
  commands: readonly CommandDefinition[],
  line: string,
): CommandInvocation | undefined {
  const slash = parseSlashLine(line);
  if (slash === undefined) return undefined;
  const command = commands.find((candidate) => candidate.name === slash.name);
  return command === undefined ? undefined : { command, args: slash.args };
}

export function commandRuntime(cwd: string, guard: ToolGuard): CommandRuntime {
  return {
    runShell: guardedShellRunner(cwd, guard),
    embedFile: fileEmbedder(cwd),
  };
}

export function slashCompleter(names: readonly string[]): (line: string) => [string[], string] {
  const sorted = [...new Set(names)].sort();
  return (line) => {
    if (!line.startsWith("/") || line.includes(" ")) return [[], line];
    const matches = sorted.map((name) => `/${name}`).filter((name) => name.startsWith(line));
    return [matches, line];
  };
}

function guardedShellRunner(cwd: string, guard: ToolGuard): (command: string) => Promise<string> {
  const bash = bashTool(cwd);
  let nextCallId = 0;
  return async (command) => {
    nextCallId += 1;
    const call: ToolCallPart = {
      type: "tool-call",
      callId: `command-shell-${nextCallId}`,
      name: "bash",
      arguments: { command },
    };
    const approved = (await guard.confirm?.(call)) ?? true;
    if (!approved) throw new Error(`you declined the shell interpolation: ${command}`);
    return bash.execute({ command });
  };
}
