import type { Dirent } from "node:fs";
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { countOccurrences, toUnixEol } from "@keywork/shared";
import type { LayerSource } from "../extensions/layers.ts";
import type { SkillDefinition } from "../extensions/skills.ts";
import { parseDocument } from "../memory/frontmatter.ts";
import { type FileDelta, fileDelta } from "../memory/ledger.ts";
import {
  type AgentAuthoredSkill,
  authorOf,
  claimAgentAuthored,
  createAgentAuthored,
  keyworkAuthor,
  reviseAgentAuthored,
} from "./authorship.ts";
import {
  agentActor,
  archiveCandidates,
  type CurationCandidate,
  type CurationThresholds,
  curatorActor,
  isPinned,
  type SkillArchive,
  type SkillLedgerEntry,
  type SkillVersion,
  withPin,
} from "./curator.ts";
import { validatedSkillDescription, validatedSkillName } from "./spec.ts";
import type { SkillTelemetry, SkillTelemetrySnapshot } from "./telemetry.ts";

export interface SkillGenesis {
  root: string;
  source: LayerSource;
  convention: string;
  author?: string | undefined;
}

export type SkillChangeKind = "patch" | "rewrite" | "create" | "archive" | "restore" | "pin";

export interface SkillChange {
  kind: SkillChangeKind;
  skill: SkillDefinition;
  delta: FileDelta;
}

export interface SkillView {
  skill: SkillDefinition;
  files: string[];
}

export interface SkillEvidenceRow {
  name: string;
  authoredBy: string | undefined;
  pinned: boolean;
}

export interface SkillHistory {
  entries: SkillLedgerEntry[];
  versions: SkillVersion[];
}

export interface ArchiveOutcome {
  name: string;
  dryRun: boolean;
  version?: SkillVersion;
}

export interface CurationOptions {
  telemetry: SkillTelemetrySnapshot;
  dryRun?: boolean | undefined;
  now?: Date | undefined;
  thresholds?: CurationThresholds | undefined;
  actor?: string | undefined;
}

export interface CurationOutcome {
  dryRun: boolean;
  candidates: CurationCandidate[];
  archived: ArchiveOutcome[];
}

export interface SkillLibraryOptions {
  skills: readonly SkillDefinition[];
  genesis?: SkillGenesis | undefined;
  telemetry?: SkillTelemetry | undefined;
  archive?: SkillArchive | undefined;
  onChange?: ((change: SkillChange) => void) | undefined;
}

export class UnknownSkillError extends Error {
  constructor(name: string, available: readonly string[]) {
    super(`unknown skill "${name}"; available: ${available.join(", ") || "(none)"}`);
    this.name = "UnknownSkillError";
  }
}

export class SkillPatchError extends Error {
  constructor(skillName: string, detail: string) {
    super(`cannot patch skill "${skillName}": ${detail}`);
    this.name = "SkillPatchError";
  }
}

export class ReferenceOutsideSkillError extends Error {
  constructor(skillName: string, path: string) {
    super(
      `"${path}" is not inside skill "${skillName}"; reference paths stay within the skill's directory`,
    );
    this.name = "ReferenceOutsideSkillError";
  }
}

export class SkillGenesisUnavailableError extends Error {
  constructor() {
    super("no place to create skills: this workspace has no trusted project root");
    this.name = "SkillGenesisUnavailableError";
  }
}

export class SkillArchiveUnavailableError extends Error {
  constructor() {
    super("no skill archive here: archive, restore and history need a trusted project root");
    this.name = "SkillArchiveUnavailableError";
  }
}

export class PinnedSkillError extends Error {
  constructor(skillName: string) {
    super(`skill "${skillName}" is pinned; unpin it before archiving`);
    this.name = "PinnedSkillError";
  }
}

export class SkillLibrary {
  private readonly byName: Map<string, SkillDefinition>;
  private readonly genesis: SkillGenesis | undefined;
  private readonly telemetry: SkillTelemetry | undefined;
  private readonly archiveStore: SkillArchive | undefined;
  private readonly onChange: ((change: SkillChange) => void) | undefined;

  constructor(options: SkillLibraryOptions) {
    this.byName = new Map(options.skills.map((skill) => [skill.name, skill]));
    this.genesis = options.genesis;
    this.telemetry = options.telemetry;
    this.archiveStore = options.archive;
    this.onChange = options.onChange;
  }

  skills(): SkillDefinition[] {
    return [...this.byName.values()];
  }

  canCreate(): boolean {
    return this.genesis !== undefined;
  }

  find(name: string): SkillDefinition {
    const skill = this.byName.get(name);
    if (skill === undefined) throw new UnknownSkillError(name, [...this.byName.keys()]);
    return skill;
  }

  async use(name: string): Promise<SkillDefinition> {
    const skill = this.find(name);
    await this.telemetry?.record(name, "use");
    return skill;
  }

  async view(name: string): Promise<SkillView> {
    const skill = this.find(name);
    await this.telemetry?.record(name, "view");
    return { skill, files: await referenceFilesUnder(skill.dir) };
  }

  async reference(name: string, path: string): Promise<string> {
    const skill = this.find(name);
    const content = await readFile(referencePath(skill, path), "utf8");
    await this.telemetry?.record(name, "reference");
    return content;
  }

  async patch(name: string, oldText: string, newText: string): Promise<SkillDefinition> {
    const previous = this.find(name);
    const claimed = await claimAgentAuthored(previous.file);
    const body = patchedBody(name, claimed.body, oldText, newText);
    return this.revise("patch", previous, claimed, { ...claimed.frontmatter }, body, agentActor);
  }

  async rewrite(name: string, body: string, description?: string): Promise<SkillDefinition> {
    const previous = this.find(name);
    const claimed = await claimAgentAuthored(previous.file);
    const frontmatter =
      description === undefined
        ? { ...claimed.frontmatter }
        : { ...claimed.frontmatter, description: validatedSkillDescription(description) };
    return this.revise("rewrite", previous, claimed, frontmatter, body, agentActor);
  }

  async create(name: string, summary: string, body: string): Promise<SkillDefinition> {
    if (this.genesis === undefined) throw new SkillGenesisUnavailableError();
    const skillName = validatedSkillName(name);
    const description = validatedSkillDescription(summary);
    if (this.byName.has(skillName)) {
      throw new Error(`skill "${skillName}" already exists; patch it instead of creating another`);
    }
    const dir = join(this.genesis.root, this.genesis.convention, skillName);
    const file = join(dir, "SKILL.md");
    await mkdir(dir, { recursive: true });
    const author = this.genesis.author ?? keyworkAuthor;
    const content = await createAgentAuthored(file, author, {
      frontmatter: { name: skillName, description },
      body,
    });
    const skill: SkillDefinition = {
      name: skillName,
      description,
      body: body.trim(),
      dir,
      file,
      source: this.genesis.source,
      convention: this.genesis.convention,
      authoredBy: author,
    };
    this.byName.set(skillName, skill);
    await this.telemetry?.record(skillName, "create");
    await this.archiveStore?.record({ actor: agentActor, action: "create", skill: skillName });
    this.onChange?.({ kind: "create", skill, delta: fileDelta(file, null, content) });
    return skill;
  }

  async evidence(): Promise<SkillEvidenceRow[]> {
    const rows: SkillEvidenceRow[] = [];
    for (const skill of this.byName.values()) {
      rows.push({
        name: skill.name,
        authoredBy: skill.authoredBy,
        pinned: await this.isPinned(skill),
      });
    }
    return rows;
  }

  async pin(name: string, actor: string): Promise<SkillDefinition> {
    return this.setPin(name, actor, true);
  }

  async unpin(name: string, actor: string): Promise<SkillDefinition> {
    return this.setPin(name, actor, false);
  }

  async archive(name: string, actor: string, dryRun = false): Promise<ArchiveOutcome> {
    const archive = this.requireArchive();
    const skill = this.find(name);
    const claimed = await claimAgentAuthored(skill.file);
    if (isPinned(claimed.frontmatter)) throw new PinnedSkillError(name);
    if (dryRun) return { name, dryRun: true };
    const version = await archive.snapshot(name, skill.dir);
    await rm(skill.dir, { recursive: true, force: true });
    this.byName.delete(name);
    await archive.record({ actor, action: "archive", skill: name, version: version.stamp });
    this.onChange?.({ kind: "archive", skill, delta: fileDelta(skill.file, claimed.raw, null) });
    return { name, dryRun: false, version };
  }

  async restore(name: string, stamp: string, actor: string): Promise<SkillDefinition> {
    const archive = this.requireArchive();
    const version = await archive.version(name, stamp);
    const live = this.byName.get(name);
    const place = live === undefined ? this.genesisPlace(name) : placeOf(live);
    const before = live === undefined ? null : (await claimAgentAuthored(live.file)).raw;
    if (live !== undefined) await archive.snapshot(name, live.dir);
    await rm(place.dir, { recursive: true, force: true });
    await mkdir(place.dir, { recursive: true });
    await cp(version.dir, place.dir, { recursive: true });
    const skill = await this.loadSkill(name, place);
    this.byName.set(name, skill);
    await archive.record({ actor, action: "restore", skill: name, version: stamp });
    const after = await readFile(skill.file, "utf8");
    this.onChange?.({ kind: "restore", skill, delta: fileDelta(skill.file, before, after) });
    return skill;
  }

  async history(name: string): Promise<SkillHistory> {
    const archive = this.requireArchive();
    return { entries: await archive.history(name), versions: await archive.versions(name) };
  }

  async curate(options: CurationOptions): Promise<CurationOutcome> {
    const dryRun = options.dryRun ?? true;
    const candidates = archiveCandidates(
      await this.evidence(),
      options.telemetry,
      options.now ?? new Date(),
      options.thresholds,
    );
    const archived: ArchiveOutcome[] = [];
    for (const candidate of candidates) {
      archived.push(await this.archive(candidate.name, options.actor ?? curatorActor, dryRun));
    }
    return { dryRun, candidates, archived };
  }

  private async setPin(name: string, actor: string, pinned: boolean): Promise<SkillDefinition> {
    const previous = this.find(name);
    const claimed = await claimAgentAuthored(previous.file);
    const frontmatter = withPin(claimed.frontmatter, pinned);
    return this.revise(
      pinned ? "pin" : "unpin",
      previous,
      claimed,
      frontmatter,
      claimed.body,
      actor,
    );
  }

  private async isPinned(skill: SkillDefinition): Promise<boolean> {
    if (skill.authoredBy === undefined) return false;
    try {
      const raw = await readFile(skill.file, "utf8");
      return isPinned(parseDocument(raw, skill.file).frontmatter);
    } catch {
      return false;
    }
  }

  private async revise(
    kind: "patch" | "rewrite" | "pin" | "unpin",
    previous: SkillDefinition,
    claimed: AgentAuthoredSkill,
    frontmatter: AgentAuthoredSkill["frontmatter"],
    body: string,
    actor: string,
  ): Promise<SkillDefinition> {
    const snapshot = await this.archiveStore?.snapshot(previous.name, previous.dir);
    const content = await reviseAgentAuthored(claimed, { frontmatter, body });
    const description = frontmatter.description;
    const skill: SkillDefinition = {
      ...previous,
      body: body.trim(),
      description: typeof description === "string" ? description : previous.description,
      authoredBy: claimed.author,
    };
    this.byName.set(skill.name, skill);
    if (kind === "patch" || kind === "rewrite") await this.telemetry?.record(skill.name, kind);
    await this.archiveStore?.record({
      actor,
      action: kind,
      skill: skill.name,
      ...(snapshot !== undefined && { version: snapshot.stamp }),
    });
    const changeKind: SkillChangeKind = kind === "unpin" ? "pin" : kind;
    this.onChange?.({
      kind: changeKind,
      skill,
      delta: fileDelta(claimed.file, claimed.raw, content),
    });
    return skill;
  }

  private requireArchive(): SkillArchive {
    if (this.archiveStore === undefined) throw new SkillArchiveUnavailableError();
    return this.archiveStore;
  }

  private genesisPlace(name: string): SkillPlace {
    if (this.genesis === undefined) throw new SkillGenesisUnavailableError();
    const dir = join(this.genesis.root, this.genesis.convention, name);
    return {
      dir,
      file: join(dir, "SKILL.md"),
      source: this.genesis.source,
      convention: this.genesis.convention,
    };
  }

  private async loadSkill(name: string, place: SkillPlace): Promise<SkillDefinition> {
    const raw = await readFile(place.file, "utf8");
    const { frontmatter, body } = parseDocument(raw, place.file);
    const description = frontmatter.description;
    return {
      name,
      description: typeof description === "string" ? description : "",
      body: body.trim(),
      dir: place.dir,
      file: place.file,
      source: place.source,
      convention: place.convention,
      authoredBy: authorOf(frontmatter),
    };
  }
}

interface SkillPlace {
  dir: string;
  file: string;
  source: LayerSource;
  convention: string;
}

const maxReferenceDepth = 3;

function placeOf(skill: SkillDefinition): SkillPlace {
  return { dir: skill.dir, file: skill.file, source: skill.source, convention: skill.convention };
}

function patchedBody(skillName: string, body: string, oldText: string, newText: string): string {
  const content = toUnixEol(body);
  const search = toUnixEol(oldText);
  const occurrences = countOccurrences(content, search);
  if (occurrences === 0) {
    throw new SkillPatchError(
      skillName,
      "oldText not found; view the skill and match it exactly, or rewrite it",
    );
  }
  if (occurrences > 1) {
    throw new SkillPatchError(
      skillName,
      `oldText matches ${occurrences} places; add surrounding context`,
    );
  }
  return content.replace(search, toUnixEol(newText));
}

function referencePath(skill: SkillDefinition, path: string): string {
  const target = resolve(skill.dir, path);
  const inside = relative(skill.dir, target);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new ReferenceOutsideSkillError(skill.name, path);
  }
  return target;
}

async function referenceFilesUnder(dir: string): Promise<string[]> {
  const files: string[] = [];
  await collectFiles(dir, dir, 0, files);
  return files.sort();
}

async function collectFiles(
  root: string,
  dir: string,
  depth: number,
  files: string[],
): Promise<void> {
  if (depth > maxReferenceDepth) return;
  for (const entry of await readdirOrEmpty(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(root, path, depth + 1, files);
    else if (entry.isFile() && !(depth === 0 && entry.name === "SKILL.md")) {
      files.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
}

async function readdirOrEmpty(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
