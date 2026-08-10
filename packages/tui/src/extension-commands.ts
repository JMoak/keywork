import type { CommandRegistry } from "./commands.ts";

export interface ExtensionCommandEntry {
  name: string;
  description?: string;
  needsArgs: boolean;
  render(args: string, confirmShell: (command: string) => Promise<boolean>): Promise<string>;
}

export interface ExtensionAgentEntry {
  name: string;
  description?: string;
}

export interface ExtensionsPort {
  commands: readonly ExtensionCommandEntry[];
  agents: readonly ExtensionAgentEntry[];
  failures: readonly string[];
}

export interface ConversationTarget {
  confirmShell(command: string): Promise<boolean>;
  submitPrompt(text: string): void;
  switchAgent(name: string | undefined): boolean;
}

export interface ExtensionSeams {
  conversation(): ConversationTarget | undefined;
  notice(text: string): void;
}

export function registerExtensions(
  registry: CommandRegistry,
  extensions: ExtensionsPort,
  seams: ExtensionSeams,
): void {
  for (const command of extensions.commands) {
    registry.register({
      name: command.name,
      description: command.description ?? `workspace command: /${command.name}`,
      ...(command.needsArgs && { needsArgs: true as const }),
      run: (args) => runExtensionCommand(command, args ?? "", seams),
    });
  }
  registerAgents(registry, extensions.agents, seams);
}

export function extensionFailureNotice(failures: readonly string[]): string | undefined {
  const first = failures[0];
  if (first === undefined) return undefined;
  const more = failures.length - 1;
  return more === 0 ? `extension skipped: ${first}` : `extension skipped: ${first} (+${more} more)`;
}

function registerAgents(
  registry: CommandRegistry,
  agents: readonly ExtensionAgentEntry[],
  seams: ExtensionSeams,
): void {
  if (agents.length === 0) return;
  for (const agent of agents) {
    registry.register({
      name: `agent-${agent.name}`,
      description: agent.description ?? `switch this pane to the ${agent.name} agent`,
      run: () => switchAgent(agent.name, seams),
    });
  }
  registry.register({
    name: "agent-none",
    description: "switch this pane back to the default agent",
    run: () => switchAgent(undefined, seams),
  });
}

function switchAgent(name: string | undefined, seams: ExtensionSeams): void {
  const target = seams.conversation();
  if (target === undefined) {
    seams.notice("no conversation pane to switch");
    return;
  }
  if (!target.switchAgent(name)) {
    seams.notice("agent switch unavailable — finish the running turn first");
    return;
  }
  seams.notice(name === undefined ? "agent → default" : `agent → ${name}`);
}

function runExtensionCommand(
  command: ExtensionCommandEntry,
  args: string,
  seams: ExtensionSeams,
): void {
  const target = seams.conversation();
  if (target === undefined) {
    seams.notice(`/${command.name}: no conversation pane to run in`);
    return;
  }
  void command
    .render(args, (shell) => target.confirmShell(shell))
    .then((prompt) => target.submitPrompt(prompt))
    .catch((cause: unknown) => {
      seams.notice(`/${command.name} failed: ${(cause as Error).message}`);
    });
}
