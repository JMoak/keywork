import { basename, isAbsolute, relative, sep } from "node:path";
import type { PromptOrigin } from "../bus.ts";
import { skillConventionDirs } from "../extensions/skills.ts";
import type { Provenance } from "../memory/notes.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { AfterSave } from "./after-save.ts";
import { confinedPath, realLocation, type ToolScope } from "./confine.ts";

export interface FileToolOptions {
  afterSave?: AfterSave | undefined;
  vault?: MemoryStore | undefined;
  origin?: OriginSource | undefined;
}

export type OriginSource = () => PromptOrigin | undefined;

export type WriteTarget = OpenFile | VaultNote;

export interface OpenFile {
  kind: "open";
  path: string;
}

export interface VaultNote {
  kind: "vault-note";
  path: string;
  vault: MemoryStore;
  note: string;
}

export class ProtectedPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtectedPathError";
  }
}

export function writeTarget(
  scope: ToolScope,
  path: string,
  vault: MemoryStore | undefined,
): WriteTarget {
  const target = confinedPath(scope, path);
  const real = realLocation(target) ?? target;
  const note = vault === undefined ? undefined : vaultNote(vault, target, real, path);
  if (note !== undefined) return note;
  if ([target, real].some(isInstructionFile))
    throw new ProtectedPathError(instructionFileRefusal(path));
  if (isInSkillDir(real)) throw new ProtectedPathError(skillDirRefusal(path));
  return { kind: "open", path: target };
}

export async function proposeVaultNote(
  target: VaultNote,
  content: string,
  path: string,
  origin?: OriginSource,
): Promise<string> {
  const provenance: Provenance = origin?.() === undefined ? "agent" : "untrusted";
  await target.vault.proposeNoteFile(target.note, content, provenance);
  return `staged ${path} as a memory proposal with provenance ${provenance}; it lands once the user approves it in the review inbox`;
}

const instructionFileNames = new Set(["agents.md", "claude.md"]);
const skillDirSegments = skillConventionDirs.map((dir) => dir.toLowerCase().split("/"));

function vaultNote(
  vault: MemoryStore,
  target: string,
  real: string,
  path: string,
): VaultNote | undefined {
  const note = insideVault(vault, real);
  if (note === undefined) return undefined;
  if (!vault.isNotePath(note)) throw new ProtectedPathError(vaultStructureRefusal(path));
  return { kind: "vault-note", path: target, vault, note };
}

function insideVault(vault: MemoryStore, real: string): string | undefined {
  const root = realLocation(vault.vaultRoot) ?? vault.vaultRoot;
  const inside = relative(root, real);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
  return inside.split(sep).join("/");
}

function isInstructionFile(path: string): boolean {
  return instructionFileNames.has(basename(path).toLowerCase());
}

function isInSkillDir(path: string): boolean {
  const segments = path.toLowerCase().split(/[\\/]/);
  return skillDirSegments.some((dir) =>
    segments.some((_, start) => dir.every((name, offset) => segments[start + offset] === name)),
  );
}

function vaultStructureRefusal(path: string): string {
  return `${path} is part of the memory vault's own structure, which keywork maintains; the agent may only propose atomic notes (a <Title>.md file) there`;
}

function instructionFileRefusal(path: string): string {
  return `${path} is a human-authored instruction file and the agent can't change it; put the suggested change in your reply for the user`;
}

function skillDirRefusal(path: string): string {
  return `${path} is inside a skill directory; change skills with skill_create, skill_patch or skill_rewrite`;
}
