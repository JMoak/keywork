import { join } from "node:path";
import {
  type ArchiveOutcome,
  discoverSkills,
  readSkillTelemetry,
  SkillArchive,
  type SkillHistory,
  type SkillLedgerEntry,
  SkillLibrary,
  skillArchiveDirName,
  skillConventionDirs,
  userActor,
} from "@keywork/engine";
import { type CommandIo, resolveCommandIo } from "./command-io.ts";
import { exitCodes } from "./dispatch.ts";
import { skillTelemetryFile, workspaceIdentity } from "./paths.ts";

export interface SkillsRoots {
  cwd: string;
  projectTrusted: boolean;
  userRoot: string;
  workspaceSlug?: string | undefined;
}

export interface SkillsCommandFlags {
  apply?: boolean | undefined;
  restore?: string | undefined;
}

export const skillsUsage = [
  "usage: keywork skills history <name> [--restore <version>]",
  "       keywork skills pin|unpin <name>",
  "       keywork skills archive <name> [--apply]",
  "       keywork skills curate [--apply]",
].join("\n");

export async function skillsCommand(
  args: readonly string[],
  roots: SkillsRoots,
  io: CommandIo = {},
  flags: SkillsCommandFlags = {},
): Promise<number> {
  const { print, printError } = resolveCommandIo(io);
  const [subcommand, name] = args;
  try {
    switch (subcommand) {
      case "history":
        return await historyCommand(roots, requireName(name), flags, print);
      case "pin":
      case "unpin":
        return await pinCommand(roots, requireName(name), subcommand === "pin", print);
      case "archive":
        return await archiveCommand(roots, requireName(name), flags.apply === true, print);
      case "curate":
        return await curateCommand(roots, flags.apply === true, print);
      default:
        printError(
          subcommand === undefined
            ? skillsUsage
            : `keywork skills: unknown subcommand "${subcommand}" (expected history, pin, unpin, archive, or curate)`,
        );
        return exitCodes.usage;
    }
  } catch (cause) {
    printError(`keywork skills: ${cause instanceof Error ? cause.message : String(cause)}`);
    return exitCodes.usage;
  }
}

export async function openSkillsLibrary(roots: SkillsRoots): Promise<SkillLibrary> {
  const { skills } = await discoverSkills({
    ...(roots.projectTrusted && { projectRoot: roots.cwd }),
    userRoot: roots.userRoot,
  });
  return new SkillLibrary({
    skills,
    ...(roots.projectTrusted && {
      genesis: { root: roots.cwd, source: "project", convention: skillConventionDirs[0] ?? "" },
      archive: new SkillArchive({ root: skillArchiveRoot(roots.cwd) }),
    }),
  });
}

export function skillArchiveRoot(cwd: string): string {
  return join(cwd, ".keywork", skillArchiveDirName);
}

export function describeHistory(name: string, history: SkillHistory): string[] {
  const entries = history.entries.map(describeLedgerEntry);
  const versions = history.versions.map((version) => `  version ${version.stamp}`);
  if (entries.length === 0 && versions.length === 0) return [`no history for ${name} yet`];
  return [...entries, ...(versions.length === 0 ? [] : ["archived versions:", ...versions])];
}

type Print = (line: string) => void;

async function historyCommand(
  roots: SkillsRoots,
  name: string,
  flags: SkillsCommandFlags,
  print: Print,
): Promise<number> {
  const library = await openSkillsLibrary(roots);
  if (flags.restore !== undefined) {
    const skill = await library.restore(name, flags.restore, userActor);
    print(`restored ${skill.name} from version ${flags.restore}`);
    return exitCodes.completed;
  }
  for (const line of describeHistory(name, await library.history(name))) print(line);
  return exitCodes.completed;
}

async function pinCommand(
  roots: SkillsRoots,
  name: string,
  pinned: boolean,
  print: Print,
): Promise<number> {
  const library = await openSkillsLibrary(roots);
  if (pinned) await library.pin(name, userActor);
  else await library.unpin(name, userActor);
  print(
    `${pinned ? "pinned" : "unpinned"} ${name} · ${pinned ? "exempt from" : "back in"} curation`,
  );
  return exitCodes.completed;
}

async function archiveCommand(
  roots: SkillsRoots,
  name: string,
  apply: boolean,
  print: Print,
): Promise<number> {
  const library = await openSkillsLibrary(roots);
  print(describeArchive(await library.archive(name, userActor, !apply)));
  return exitCodes.completed;
}

async function curateCommand(roots: SkillsRoots, apply: boolean, print: Print): Promise<number> {
  const library = await openSkillsLibrary(roots);
  const telemetry = await readSkillTelemetry(
    skillTelemetryFile(workspaceIdentity(roots.cwd, roots.workspaceSlug), roots.userRoot),
  );
  const outcome = await library.curate({ telemetry, dryRun: !apply, actor: userActor });
  if (outcome.candidates.length === 0) {
    print("nothing to curate · every agent skill is pinned or recently used");
    return exitCodes.completed;
  }
  for (const candidate of outcome.candidates)
    print(`- ${candidate.name} · unused for ${candidate.idleDays} days`);
  for (const archived of outcome.archived) print(describeArchive(archived));
  if (outcome.dryRun) print("dry run · --apply archives these");
  return exitCodes.completed;
}

function describeArchive(outcome: ArchiveOutcome): string {
  if (outcome.dryRun) return `would archive ${outcome.name} · --apply does it`;
  return `archived ${outcome.name} as version ${outcome.version?.stamp ?? "?"} · keywork skills history ${outcome.name} restores it`;
}

function describeLedgerEntry(entry: SkillLedgerEntry): string {
  const version = entry.version === undefined ? "" : ` · version ${entry.version}`;
  return `${entry.at} ${entry.actor} ${entry.action} ${entry.skill}${version}`;
}

function requireName(name: string | undefined): string {
  if (name === undefined || name.trim() === "") throw new Error("a skill name is required");
  return name;
}
