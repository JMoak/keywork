import { toError } from "@keywork/shared";
import type { CommandRegistry, CommandSpec } from "./commands.ts";

export interface ExtensionCommandEntry {
  name: string;
  description?: string;
  needsArgs: boolean;
  render(args: string, confirmShell: (command: string) => Promise<boolean>): Promise<string>;
}

export interface ExtensionsPort {
  commands: readonly ExtensionCommandEntry[];
  failures: readonly string[];
}

export interface ConversationTarget {
  confirmShell(command: string): Promise<boolean>;
  submitPrompt(text: string): void;
  bot(): string | undefined;
  switchBot(name: string | undefined): boolean;
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
  return extensions.commands.flatMap((command) => {
    const outcome = registry.register(extensionCommand(command, seams));
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
