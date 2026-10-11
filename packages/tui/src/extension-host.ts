import {
  describeExtensions,
  type ExtensionNotice,
  type ExtensionRegistrations,
  type ExtensionStatus,
  extensionLoadNotices,
  type OwnedCommand,
  type SkippedExtensionLayer,
  summarizeExtensions,
} from "@keywork/engine";
import { toError } from "@keywork/shared";
import type { CommandRegistry, CommandSpec } from "./commands.ts";
import type { ShadowedExtension } from "./extension-commands.ts";

export interface ExtensionHostPort {
  extensions(): readonly ExtensionStatus[];
  registrations(name: string): ExtensionRegistrations;
  skipped: readonly SkippedExtensionLayer[];
  commands(): readonly OwnedCommand[];
  runCommand(name: string, args: string): Promise<string | undefined>;
  onNotice(listener: (notice: ExtensionNotice) => void): () => void;
}

export interface ExtensionHostSeams {
  notice(text: string): void;
  post(text: string): boolean;
}

export const extensionsCommandName = "extensions";

export function routeExtensionNotice(notice: ExtensionNotice, seams: ExtensionHostSeams): void {
  const line = `${notice.extension}: ${notice.message}`;
  if (notice.level === "info") seams.post(line);
  else seams.notice(line);
}

export function watchExtensionNotices(
  port: ExtensionHostPort,
  seams: ExtensionHostSeams,
): () => void {
  return port.onNotice((notice) => routeExtensionNotice(notice, seams));
}

export function extensionStartupNotice(port: ExtensionHostPort): string | undefined {
  const [first, ...rest] = extensionLoadNotices({ statuses: port.extensions() });
  if (first === undefined) return undefined;
  return rest.length === 0 ? first : `${first} (+${rest.length} more)`;
}

export function registerHostedCommands(
  registry: CommandRegistry,
  port: ExtensionHostPort,
  seams: ExtensionHostSeams,
): ShadowedExtension[] {
  return port.commands().flatMap((command) => {
    const outcome = registry.register(hostedCommand(command, port, seams));
    return outcome.kind === "collision"
      ? [{ name: outcome.name, claimedBy: outcome.claimedBy }]
      : [];
  });
}

export function extensionListingCommand(
  port: ExtensionHostPort,
  seams: ExtensionHostSeams,
): CommandSpec {
  return {
    name: extensionsCommandName,
    description: "list loaded extensions, their standing and what each registered: /extensions",
    run: () => {
      const listing = describeExtensions({
        statuses: port.extensions(),
        skipped: port.skipped,
        registrations: (name) => port.registrations(name),
      });
      if (!seams.post(listing.join("\n"))) seams.notice(standingSummary(port.extensions()));
    },
  };
}

function standingSummary(statuses: readonly ExtensionStatus[]): string {
  const { active, quarantined } = summarizeExtensions(statuses);
  const head = `${active} active · ${quarantined} quarantined`;
  return `extensions: ${head} · open a conversation to print the list into`;
}

function hostedCommand(
  command: OwnedCommand,
  port: ExtensionHostPort,
  seams: ExtensionHostSeams,
): CommandSpec {
  return {
    name: command.name,
    description: command.description ?? `${command.extension} extension command: /${command.name}`,
    run: (args) => {
      void port
        .runCommand(command.name, args ?? "")
        .then((output) => {
          if (output !== undefined && !seams.post(output)) seams.notice(output);
        })
        .catch((cause: unknown) => {
          seams.notice(`/${command.name} failed: ${toError(cause).message}`);
        });
    },
  };
}
