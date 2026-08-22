import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { slugProblem } from "@keywork/shared";
import { type Frontmatter, parseDocument, serializeDocument } from "../frontmatter.ts";
import { MemoryInertError, MemoryStore, type Note } from "../store.ts";
import { isMissingFileError } from "../vault-files.ts";
import { ArcOpenQuestions, questionsDir } from "./questions.ts";

export type ArcStatus = "active" | "archived";

export interface ArcRecord {
  slug: string;
  status: ArcStatus;
  created: string;
  archived?: string;
  delivered?: string;
  abandoned: boolean;
}

export interface ArcRegistryOptions {
  vaultRoot: string;
  trusted: boolean;
  now?: () => Date;
  secrets?: Record<string, string>;
  openQuestionCap?: number;
}

export class InvalidArcSlugError extends Error {
  constructor(
    readonly slug: string,
    detail: string,
  ) {
    super(`invalid arc slug "${slug}": ${detail}`);
    this.name = "InvalidArcSlugError";
  }
}

export class ArcExistsError extends Error {
  constructor(readonly slug: string) {
    super(`an arc named "${slug}" already exists`);
    this.name = "ArcExistsError";
  }
}

export class MissingArcError extends Error {
  constructor(readonly slug: string) {
    super(`no arc named "${slug}"`);
    this.name = "MissingArcError";
  }
}

export class ArcNotActiveError extends Error {
  constructor(
    readonly slug: string,
    readonly status: ArcStatus,
  ) {
    super(`arc "${slug}" is ${status}, not active`);
    this.name = "ArcNotActiveError";
  }
}

export const arcMocName = "MOC";
const arcMocFile = `${arcMocName}.md`;
const arcReservedPaths = [arcMocFile, `${questionsDir}/`];

export function arcMocLink(slug: string): string {
  return `arcs/${slug}/${arcMocName}`;
}

export class ArcRegistry {
  readonly trusted: boolean;
  private readonly root: string;
  private readonly now: () => Date;
  private readonly secrets: Record<string, string>;
  private readonly openQuestionCap: number | undefined;
  private readonly stores = new Map<string, MemoryStore>();

  constructor(options: ArcRegistryOptions) {
    this.root = options.vaultRoot;
    this.trusted = options.trusted;
    this.now = options.now ?? (() => new Date());
    this.secrets = options.secrets ?? {};
    this.openQuestionCap = options.openQuestionCap;
  }

  async createArc(slug: string): Promise<ArcRecord> {
    this.gate();
    validateArcSlug(slug);
    if ((await this.readArc(slug)) !== undefined) throw new ArcExistsError(slug);
    const record: ArcRecord = {
      slug,
      status: "active",
      created: this.now().toISOString(),
      abandoned: false,
    };
    await this.writeMoc(slug, recordFrontmatter(record), `arc ${slug}\n`);
    return record;
  }

  async listArcs(): Promise<ArcRecord[]> {
    if (!this.trusted) return [];
    const records: ArcRecord[] = [];
    for (const slug of await this.listArcDirs()) {
      const record = await this.readArc(slug);
      if (record !== undefined) records.push(record);
    }
    return records.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async readArc(slug: string): Promise<ArcRecord | undefined> {
    if (!this.trusted) return undefined;
    const raw = await this.arcStore(slug).readReserved(arcMocFile);
    if (raw === null) return undefined;
    return parseRecord(slug, parseDocument(raw, arcMocLink(slug)).frontmatter);
  }

  async readMocNote(slug: string): Promise<Note | undefined> {
    return this.arcStore(slug).readNote(arcMocName);
  }

  async requireActive(slug: string): Promise<ArcRecord> {
    this.gate();
    const record = await this.readArc(slug);
    if (record === undefined) throw new MissingArcError(slug);
    if (record.status !== "active") throw new ArcNotActiveError(slug, record.status);
    return record;
  }

  async archiveArc(
    slug: string,
    stamps: { delivered?: string; abandoned?: boolean } = {},
  ): Promise<ArcRecord> {
    const record = await this.requireActive(slug);
    const archived: ArcRecord = {
      ...record,
      status: "archived",
      archived: this.now().toISOString(),
      abandoned: stamps.abandoned ?? false,
      ...(stamps.delivered !== undefined && { delivered: stamps.delivered }),
    };
    const raw = await this.arcStore(slug).readReserved(arcMocFile);
    const body = raw === null ? "" : parseDocument(raw, arcMocLink(slug)).body;
    await this.writeMoc(slug, recordFrontmatter(archived), body);
    return archived;
  }

  arcStore(slug: string): MemoryStore {
    validateArcSlug(slug);
    const cached = this.stores.get(slug);
    if (cached !== undefined) return cached;
    const store = new MemoryStore({
      vaultRoot: join(this.root, "arcs", slug),
      trusted: this.trusted,
      now: this.now,
      secrets: this.secrets,
      reservedPaths: arcReservedPaths,
    });
    this.stores.set(slug, store);
    return store;
  }

  openQuestions(slug: string): ArcOpenQuestions {
    return new ArcOpenQuestions({
      store: this.arcStore(slug),
      now: this.now,
      ...(this.openQuestionCap !== undefined && { cap: this.openQuestionCap }),
    });
  }

  private gate(): void {
    if (!this.trusted) throw new MemoryInertError();
  }

  private async writeMoc(slug: string, frontmatter: Frontmatter, body: string): Promise<void> {
    await this.arcStore(slug).writeReserved(arcMocFile, serializeDocument(frontmatter, body));
  }

  private async listArcDirs(): Promise<string[]> {
    try {
      return (await readdir(join(this.root, "arcs"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter(isValidArcSlug);
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
  }
}

export function validateArcSlug(slug: string): void {
  const problem = slugProblem(slug);
  if (problem !== undefined) throw new InvalidArcSlugError(slug, problem);
}

function isValidArcSlug(slug: string): boolean {
  try {
    validateArcSlug(slug);
    return true;
  } catch {
    return false;
  }
}

function recordFrontmatter(record: ArcRecord): Frontmatter {
  return {
    arc: record.slug,
    status: record.status,
    created: record.created,
    ...(record.archived !== undefined && { archived: record.archived }),
    ...(record.delivered !== undefined && { delivered: record.delivered }),
    ...(record.abandoned && { abandoned: true }),
  };
}

function parseRecord(slug: string, frontmatter: Frontmatter): ArcRecord {
  const status = frontmatter.status === "archived" ? "archived" : "active";
  const created = typeof frontmatter.created === "string" ? frontmatter.created : "";
  const archived = typeof frontmatter.archived === "string" ? frontmatter.archived : undefined;
  const delivered = typeof frontmatter.delivered === "string" ? frontmatter.delivered : undefined;
  return {
    slug,
    status,
    created,
    abandoned: frontmatter.abandoned === true,
    ...(archived !== undefined && { archived }),
    ...(delivered !== undefined && { delivered }),
  };
}
