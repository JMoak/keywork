import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  canonicalTrustPath,
  listWorkspaces,
  namedWorkspaceDir,
  openWorkspace,
  resolveAnchor,
  slugProblem,
  type WorkspaceSlot,
  writeNamedWorkspaceDeclaration,
} from "@keywork/shared";
import type { WorkspaceChoice, WorkspacesPort } from "@keywork/tui";
import { exitCodes } from "./dispatch.ts";
import { keyworkHome } from "./paths.ts";

export interface WorkspaceRecall {
  recall(cwd: string): string | undefined;
  remember(cwd: string, slug: string | undefined): void;
}

export function workspaceRecallFile(home: string = keyworkHome()): string {
  return join(home, "workspace-mru.json");
}

export function fileWorkspaceRecall(file: string = workspaceRecallFile()): WorkspaceRecall {
  return {
    recall: (cwd) => emptyToUndefined(readRecall(file)[canonicalTrustPath(cwd)]),
    remember: (cwd, slug) => {
      const recalled = readRecall(file);
      recalled[canonicalTrustPath(cwd)] = slug ?? "";
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(recalled, null, 2)}\n`, "utf8");
    },
  };
}

export function selectWorkspace(
  cwd: string,
  requested: string | undefined,
  recall: WorkspaceRecall,
  warn: (line: string) => void,
): string | undefined {
  const slug = requested ?? recall.recall(cwd);
  if (slug === undefined || openWorkspace(cwd, slug) !== undefined) return slug;
  warn(
    requested === undefined
      ? `keywork: the last-used workspace "${slug}" is gone, opening the default`
      : `keywork: no workspace named "${slug}" here, opening the default · keywork workspace list`,
  );
  return undefined;
}

export interface WorkspaceCommandIo {
  print?: (line: string) => void;
  printError?: (line: string) => void;
}

export type WorkspaceConfirm = (question: string) => Promise<boolean>;

export async function workspaceCommand(
  args: readonly string[],
  cwd: string,
  io: WorkspaceCommandIo = {},
  confirm?: WorkspaceConfirm,
  recall: WorkspaceRecall = fileWorkspaceRecall(),
): Promise<number> {
  const print = io.print ?? console.log;
  const printError = io.printError ?? console.error;
  const root = resolveAnchor(cwd).root;
  const [subcommand = "list", slug] = args;
  switch (subcommand) {
    case "list":
      return printWorkspaces(root, recall.recall(cwd), print);
    case "new":
      return createWorkspace(root, slug, print, printError);
    case "use":
      return useWorkspace(cwd, slug, recall, print, printError);
    case "rm":
    case "prune":
      return removeWorkspace(cwd, root, slug, recall, print, printError, confirm);
    default:
      printError(
        `keywork workspace: unknown subcommand "${subcommand}" (expected list, new, use, or rm)`,
      );
      return exitCodes.usage;
  }
}

export interface WorkspacesPortOptions {
  cwd: string;
  current: string | undefined;
  recall: WorkspaceRecall;
  requestSwitch(slug: string | undefined): void;
}

export function workspacesPort(options: WorkspacesPortOptions): WorkspacesPort {
  const root = resolveAnchor(options.cwd).root;
  return {
    list: async () => listWorkspaces(root).map((slot) => choiceOf(slot, options.current)),
    create: async (slug) => {
      if (openWorkspace(options.cwd, slug) !== undefined) {
        throw new Error(`a workspace named ${slug} already exists · /workspace ${slug} opens it`);
      }
      writeNamedWorkspaceDeclaration(root, slug, { name: nameFromSlug(slug) });
    },
    use: async (slug) => {
      if (slug !== undefined && openWorkspace(options.cwd, slug) === undefined) {
        throw new Error(`no workspace named ${slug} · /workspace new ${slug} creates it`);
      }
      options.recall.remember(options.cwd, slug);
      options.requestSwitch(slug);
    },
  };
}

export function nameFromSlug(slug: string): string {
  return slug.split("-").filter(Boolean).join(" ");
}

function choiceOf(slot: WorkspaceSlot, current: string | undefined): WorkspaceChoice {
  return {
    slug: slot.slug,
    name: slot.problem === undefined ? (slot.name ?? "default") : "(unavailable)",
    declared: slot.declared,
    current: slot.slug === current,
    notes: noteCount(slot.vaultPath),
  };
}

function printWorkspaces(
  root: string,
  recalled: string | undefined,
  print: (line: string) => void,
): number {
  for (const slot of listWorkspaces(root)) {
    const mark = slot.slug === recalled ? "*" : " ";
    const label = (slot.slug ?? "default").padEnd(20);
    print(`${mark} ${label} ${slotName(slot).padEnd(24)} ${relative(root, slot.vaultPath)}`);
  }
  print(`root ${root} · * opens next`);
  return 0;
}

function slotName(slot: WorkspaceSlot): string {
  if (slot.problem !== undefined) return `(unavailable · ${slot.problem})`;
  return slot.declared ? (slot.name ?? "") : "(not set up yet)";
}

function createWorkspace(
  root: string,
  slug: string | undefined,
  print: (line: string) => void,
  printError: (line: string) => void,
): number {
  if (slug === undefined) {
    printError("usage: keywork workspace new <slug>");
    return 1;
  }
  const problem = slugProblem(slug);
  if (problem !== undefined) {
    printError(`"${slug}" isn't a workspace slug · ${problem}`);
    return 1;
  }
  if (existsSync(namedWorkspaceDir(root, slug))) {
    printError(`a workspace named ${slug} already exists here`);
    return 1;
  }
  const file = writeNamedWorkspaceDeclaration(root, slug, { name: nameFromSlug(slug) });
  print(`workspace ${slug} ready at ${dirname(file)}`);
  print(`open it with: keywork workspace use ${slug}`);
  return 0;
}

function useWorkspace(
  cwd: string,
  slug: string | undefined,
  recall: WorkspaceRecall,
  print: (line: string) => void,
  printError: (line: string) => void,
): number {
  if (slug === undefined) {
    printError("usage: keywork workspace use <slug|default>");
    return 1;
  }
  const chosen = slug === "default" ? undefined : slug;
  if (chosen !== undefined && openWorkspace(cwd, chosen) === undefined) {
    printError(`no workspace named ${chosen} here · keywork workspace new ${chosen} creates it`);
    return 1;
  }
  recall.remember(cwd, chosen);
  print(`the next keywork launch from here opens ${chosen ?? "the default workspace"}`);
  return 0;
}

async function removeWorkspace(
  cwd: string,
  root: string,
  slug: string | undefined,
  recall: WorkspaceRecall,
  print: (line: string) => void,
  printError: (line: string) => void,
  confirm: WorkspaceConfirm | undefined,
): Promise<number> {
  if (slug === undefined || slug === "default") {
    printError("usage: keywork workspace rm <slug> · the default workspace is never removed");
    return 1;
  }
  const dir = namedWorkspaceDir(root, slug);
  if (!existsSync(dir)) {
    printError(`no workspace named ${slug} here`);
    return 1;
  }
  const notes = noteCount(join(dir, "memory"));
  if (notes > 0) {
    if (confirm === undefined) {
      printError(
        `workspace ${slug} holds ${notes} memory ${notes === 1 ? "file" : "files"} · run this from a terminal to confirm the removal`,
      );
      return 1;
    }
    if (!(await confirm(`remove workspace ${slug} and its ${notes} memory files? [y/N] `))) {
      print("okay, kept");
      return 1;
    }
  }
  rmSync(dir, { recursive: true, force: true });
  if (recall.recall(cwd) === slug) recall.remember(cwd, undefined);
  print(`removed workspace ${slug}`);
  return 0;
}

function noteCount(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).reduce((count, entry) => {
      if (entry.isDirectory()) return count + noteCount(join(dir, entry.name));
      return entry.name.endsWith(".md") ? count + 1 : count;
    }, 0);
  } catch {
    return 0;
  }
}

function readRecall(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  return onlyStringEntries(parseJsonOrEmpty(raw));
}

function parseJsonOrEmpty(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function onlyStringEntries(parsed: unknown): Record<string, string> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") entries[key] = value;
  }
  return entries;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
