import { toError } from "@keywork/shared";
import type { CommandRegistry, CommandSpec } from "./commands.ts";

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

export interface ShadowedExtension {
  name: string;
  claimedBy: string;
}

export function registerExtensions(
  registry: CommandRegistry,
  extensions: ExtensionsPort,
  seams: ExtensionSeams,
): ShadowedExtension[] {
  const specs = [
    ...extensions.commands.map((command) => extensionCommand(command, seams)),
    ...agentCommands(extensions.agents, seams),
  ];
  return specs.flatMap((spec) => {
    const outcome = registry.register(spec);
    return outcome.kind === "collision"
      ? [{ name: outcome.name, claimedBy: outcome.claimedBy }]
      : [];
  });
}

export function extensionFailureNotice(failures: readonly string[]): string | undefined {
  const first = failures[0];
  if (first === undefined) return undefined;
  const more = failures.length - 1;
  return more === 0 ? `skipped extension ${first}` : `skipped extension ${first} (+${more} more)`;
}

export function shadowedExtensionNotice(
  shadowed: readonly ShadowedExtension[],
): string | undefined {
  const first = shadowed[0];
  if (first === undefined) return undefined;
  const more = shadowed.length - 1;
  const lead = `/${first.name} is taken by /${first.claimedBy} · the extension command is skipped`;
  return more === 0 ? lead : `${lead} (+${more} more)`;
}

function extensionCommand(command: ExtensionCommandEntry, seams: ExtensionSeams): CommandSpec {
  return {
    name: command.name,
    description: command.description ?? `workspace command: /${command.name}`,
    ...(command.needsArgs && { needsArgs: true as const }),
    run: (args) => runExtensionCommand(command, args ?? "", seams),
  };
}

function agentCommands(
  agents: readonly ExtensionAgentEntry[],
  seams: ExtensionSeams,
): CommandSpec[] {
  if (agents.length === 0) return [];
  return [
    {
      name: "agent-none",
      description: "switch this pane back to the default agent",
      run: () => switchAgent(undefined, seams),
    },
    ...agents.map((agent) => ({
      name: `agent-${agent.name}`,
      description: agent.description ?? `switch this pane to the ${agent.name} agent`,
      run: () => switchAgent(agent.name, seams),
    })),
  ];
}

function switchAgent(name: string | undefined, seams: ExtensionSeams): void {
  const target = seams.conversation();
  if (target === undefined) {
    seams.notice("no conversation pane here");
    return;
  }
  if (!target.switchAgent(name)) {
    seams.notice("agent busy · finish the turn first");
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
      seams.notice(`/${command.name} failed: ${toError(cause).message}`);
    });
}
