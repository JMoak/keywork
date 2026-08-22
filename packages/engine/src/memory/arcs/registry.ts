import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { slugProblem } from "@keywork/shared";
import { type Frontmatter, parseDocument, serializeDocument } from "../frontmatter.ts";
import { MemoryInertError, MemoryStore } from "../store.ts";
import { ArcOpenQuestions } from "./questions.ts";

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

export function arcMocLink(slug: string): string {
  return `arcs/${slug}/MOC`;
}

export class ArcRegistry {
  readonly trusted: boolean;
  private readonly root: string;
  private readonly now: () => Date;
  private readonly secrets: Record<string, string>;
  private readonly openQuestionCap: number | undefined;

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
    validateArcSlug(slug);
    const raw = await this.readMocRaw(slug);
    if (raw === null) return undefined;
    return parseRecord(slug, parseDocument(raw, this.mocPath(slug)).frontmatter);
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
    const raw = await this.readMocRaw(slug);
    const body = raw === null ? "" : parseDocument(raw, this.mocPath(slug)).body;
    await this.writeMoc(slug, recordFrontmatter(archived), body);
    return archived;
  }

  arcStore(slug: string): MemoryStore {
    validateArcSlug(slug);
    return new MemoryStore({
      vaultRoot: this.arcDir(slug),
      trusted: this.trusted,
      now: this.now,
      secrets: this.secrets,
    });
  }

  openQuestions(slug: string): ArcOpenQuestions {
    validateArcSlug(slug);
    return new ArcOpenQuestions({
      questionsDir: join(this.arcDir(slug), "questions"),
      trusted: this.trusted,
      now: this.now,
      secrets: this.secrets,
      ...(this.openQuestionCap !== undefined && { cap: this.openQuestionCap }),
    });
  }

  private gate(): void {
    if (!this.trusted) throw new MemoryInertError();
  }

  private arcDir(slug: string): string {
    return join(this.root, "arcs", slug);
  }

  private mocPath(slug: string): string {
    return join(this.arcDir(slug), "MOC.md");
  }

  private async readMocRaw(slug: string): Promise<string | null> {
    try {
      return await readFile(this.mocPath(slug), "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  private async writeMoc(slug: string, frontmatter: Frontmatter, body: string): Promise<void> {
    await mkdir(this.arcDir(slug), { recursive: true });
    await writeFile(this.mocPath(slug), serializeDocument(frontmatter, body), "utf8");
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

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code: unknown }).code === "ENOENT" ||
      (error as { code: unknown }).code === "ENOTDIR")
  );
}
