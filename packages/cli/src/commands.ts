import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentDefinition,
  bashTool,
  type CommandDefinition,
  type CommandRuntime,
  discoverSkills,
  type ExtensionLoadFailure,
  fileEmbedder,
  loadAgents,
  loadCommands,
  type SkillDefinition,
  type ToolCallPart,
  type ToolGuard,
} from "@keywork/engine";

export interface WorkspaceExtensions {
  commands: CommandDefinition[];
  agents: AgentDefinition[];
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
  userRoot = join(homedir(), ".keywork"),
): Promise<WorkspaceExtensions> {
  const projectDir = (kind: string) =>
    projectTrusted ? { projectDir: join(cwd, ".keywork", kind) } : {};
  const [commands, agents, skillLoad] = await Promise.all([
    loadCommands({ userDir: join(userRoot, "commands"), ...projectDir("commands") }),
    loadAgents({ userDir: join(userRoot, "agents"), ...projectDir("agents") }),
    projectTrusted ? discoverSkills(cwd) : Promise.resolve({ skills: [], failures: [] }),
  ]);
  return {
    commands: commands.commands,
    agents: agents.agents,
    skills: skillLoad.skills,
    failures: [...commands.failures, ...agents.failures, ...skillLoad.failures],
  };
}

export function resolveSlashCommand(
  commands: readonly CommandDefinition[],
  line: string,
): CommandInvocation | undefined {
  if (!line.startsWith("/")) return undefined;
  const [head = "", ...rest] = line.slice(1).split(/\s+/);
  const command = commands.find((candidate) => candidate.name === head);
  return command === undefined ? undefined : { command, args: rest.join(" ").trim() };
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
    if (!approved) throw new Error(`shell interpolation declined: ${command}`);
    return bash.execute({ command });
  };
}
