import {
  coreTools,
  describeExtensions,
  type EngineEvents,
  EventBus,
  ExtensionHost,
  type ExtensionLoadReport,
  type ExtensionNotice,
  loadExtensions,
} from "@keywork/engine";
import type { ExtensionHostPort } from "@keywork/tui";
import { type CommandIo, resolveCommandIo } from "./command-io.ts";
import { workspaceToolScope } from "./compose.ts";
import { exitCodes } from "./dispatch.ts";

export interface ExtensionsRoots {
  cwd: string;
  projectTrusted: boolean;
  userRoot: string;
  workspaceSlug?: string | undefined;
}

export const extensionsUsage = "usage: keywork extensions";

export async function extensionsCommand(
  args: readonly string[],
  roots: ExtensionsRoots,
  io: CommandIo = {},
): Promise<number> {
  const { print, printError } = resolveCommandIo(io);
  const [subcommand] = args;
  if (subcommand !== undefined) {
    printError(`keywork extensions: unexpected argument "${subcommand}"\n${extensionsUsage}`);
    return exitCodes.usage;
  }
  const host = new ExtensionHost({
    bus: new EventBus<EngineEvents>(),
    reservedToolNames: coreTools(
      workspaceToolScope(roots.cwd, roots.projectTrusted, roots.workspaceSlug),
    ).map((tool) => tool.name),
  });
  try {
    const report = await loadExtensions(
      { userRoot: roots.userRoot, projectRoot: roots.cwd, projectTrusted: roots.projectTrusted },
      host,
    );
    for (const line of describeExtensionHost(host, report)) print(line);
    return exitCodes.completed;
  } finally {
    await host.dispose();
  }
}

export function describeExtensionHost(host: ExtensionHost, report: ExtensionLoadReport): string[] {
  return describeExtensions({
    statuses: host.extensions(),
    skipped: report.skipped,
    registrations: (name) => host.registrations(name),
  });
}

export function extensionHostPort(
  host: ExtensionHost,
  report: ExtensionLoadReport,
): ExtensionHostPort {
  return {
    extensions: () => host.extensions(),
    registrations: (name) => host.registrations(name),
    skipped: report.skipped,
    commands: () => host.commands(),
    runCommand: (name, args) => host.runCommand(name, args),
    onNotice: (listener) => host.onNotice(listener),
  };
}

export function headlessNoticeLine(prefix: string, notice: ExtensionNotice): string | undefined {
  if (notice.level === "info") return undefined;
  return `${prefix}: ${notice.extension}: ${notice.message}`;
}
