import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Frontmatter, FrontmatterMap } from "../memory/frontmatter.ts";
import { isFrontmatterMap } from "../memory/frontmatter.ts";
import { isMissingFileError, writeFileAtomic } from "../memory/vault-files.ts";
import { metadataKey } from "./authorship.ts";
import type { SkillActivity, SkillTelemetrySnapshot } from "./telemetry.ts";

export const skillLedgerActions = [
  "create",
  "patch",
  "rewrite",
  "archive",
  "restore",
  "pin",
  "unpin",
] as const;

export type SkillLedgerAction = (typeof skillLedgerActions)[number];

export const agentActor = "agent";
export const curatorActor = "curator";
export const userActor = "user";

export interface SkillLedgerEntry {
  at: string;
  actor: string;
  action: SkillLedgerAction;
  skill: string;
  version?: string;
  detail?: string;
}

export interface SkillVersion {
  stamp: string;
  dir: string;
  file: string;
}

export interface SkillArchiveOptions {
  root: string;
  now?: (() => Date) | undefined;
}

export interface ArchivedSkill {
  name: string;
  version: SkillVersion;
}

export const pinnedKey = "pinned";
export const skillArchiveDirName = "skills-archive";
export const skillLedgerFileName = "ledger.jsonl";
export const skillFileName = "SKILL.md";

export class SkillVersionNotFoundError extends Error {
  constructor(skill: string, stamp: string) {
    super(`skill "${skill}" has no archived version ${stamp}`);
    this.name = "SkillVersionNotFoundError";
  }
}

export class SkillArchive {
  readonly root: string;
  private readonly now: () => Date;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: SkillArchiveOptions) {
    this.root = options.root;
    this.now = options.now ?? (() => new Date());
  }

  async snapshot(name: string, dir: string): Promise<SkillVersion> {
    const version = this.versionAt(name, this.freshStamp(await this.versions(name)));
    await mkdir(version.dir, { recursive: true });
    await cp(dir, version.dir, { recursive: true });
    return version;
  }

  async versions(name: string): Promise<SkillVersion[]> {
    const stamps = await dirNames(join(this.root, name));
    return stamps.sort().map((stamp) => this.versionAt(name, stamp));
  }

  async version(name: string, stamp: string): Promise<SkillVersion> {
    const found = (await this.versions(name)).find((candidate) => candidate.stamp === stamp);
    if (found === undefined) throw new SkillVersionNotFoundError(name, stamp);
    return found;
  }

  async archived(): Promise<ArchivedSkill[]> {
    const names = await dirNames(this.root);
    const result: ArchivedSkill[] = [];
    for (const name of names.sort()) {
      const latest = (await this.versions(name)).at(-1);
      if (latest !== undefined) result.push({ name, version: latest });
    }
    return result;
  }

  async forget(name: string): Promise<void> {
    await rm(join(this.root, name), { recursive: true, force: true });
  }

  record(entry: Omit<SkillLedgerEntry, "at">): Promise<void> {
    const line = `${JSON.stringify({ at: this.now().toISOString(), ...entry })}\n`;
    this.pending = this.pending.then(() => this.append(line));
    return this.pending;
  }

  async history(name: string): Promise<SkillLedgerEntry[]> {
    return (await this.ledger()).filter((entry) => entry.skill === name);
  }

  async ledger(): Promise<SkillLedgerEntry[]> {
    const raw = await readOrEmpty(this.ledgerFile());
    return raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        const parsed = ledgerEntrySchema.safeParse(parseJson(line));
        return parsed.success ? [ledgerEntryOf(parsed.data)] : [];
      });
  }

  private ledgerFile(): string {
    return join(this.root, skillLedgerFileName);
  }

  private async append(line: string): Promise<void> {
    const existing = await readOrEmpty(this.ledgerFile());
    await writeFileAtomic(this.ledgerFile(), `${existing}${line}`);
  }

  private versionAt(name: string, stamp: string): SkillVersion {
    const dir = join(this.root, name, stamp);
    return { stamp, dir, file: join(dir, skillFileName) };
  }

  private freshStamp(taken: readonly SkillVersion[]): string {
    const base = this.now().toISOString().replace(/[:.]/g, "-");
    const stamps = new Set(taken.map((version) => version.stamp));
    let stamp = base;
    for (let suffix = 2; stamps.has(stamp); suffix += 1) stamp = `${base}-${suffix}`;
    return stamp;
  }
}

export function isPinned(frontmatter: Frontmatter): boolean {
  return metadataOf(frontmatter)[pinnedKey] === "true";
}

export function withPin(frontmatter: Frontmatter, pinned: boolean): Frontmatter {
  const { [pinnedKey]: _previous, ...metadata } = metadataOf(frontmatter);
  const next: FrontmatterMap = pinned ? { ...metadata, [pinnedKey]: "true" } : metadata;
  return { ...frontmatter, [metadataKey]: next };
}

export interface CurationCandidate {
  name: string;
  idleDays: number;
  uses: number;
}

export interface CurationThresholds {
  archiveIdleDays: number;
}

export const defaultSkillCurationThresholds: CurationThresholds = { archiveIdleDays: 30 };

export function archiveCandidates(
  skills: readonly { name: string; authoredBy: string | undefined; pinned: boolean }[],
  telemetry: SkillTelemetrySnapshot,
  now: Date,
  thresholds: CurationThresholds = defaultSkillCurationThresholds,
): CurationCandidate[] {
  const candidates: CurationCandidate[] = [];
  for (const skill of skills) {
    const activity = telemetry[skill.name];
    if (skill.authoredBy === undefined || skill.pinned || activity === undefined) continue;
    const idle = idleDays(activity, now);
    if (activity.counts.use === 0 && idle >= thresholds.archiveIdleDays)
      candidates.push({ name: skill.name, idleDays: Math.floor(idle), uses: 0 });
  }
  return candidates;
}

const dayMs = 86_400_000;

const ledgerEntrySchema = z.object({
  at: z.string(),
  actor: z.string(),
  action: z.enum(skillLedgerActions),
  skill: z.string(),
  version: z.string().optional(),
  detail: z.string().optional(),
});

function ledgerEntryOf(parsed: z.infer<typeof ledgerEntrySchema>): SkillLedgerEntry {
  const { at, actor, action, skill, version, detail } = parsed;
  return {
    at,
    actor,
    action,
    skill,
    ...(version !== undefined && { version }),
    ...(detail !== undefined && { detail }),
  };
}

function idleDays(activity: SkillActivity, now: Date): number {
  const last = Date.parse(activity.lastActivityAt);
  return Number.isNaN(last) ? 0 : (now.getTime() - last) / dayMs;
}

function metadataOf(frontmatter: Frontmatter): FrontmatterMap {
  const metadata = frontmatter[metadataKey];
  return isFrontmatterMap(metadata) ? metadata : {};
}

async function dirNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return "";
    throw error;
  }
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
