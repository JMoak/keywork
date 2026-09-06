import { join } from "node:path";
import { validateSlug } from "@keywork/shared";
import { type Frontmatter, parseDocument, serializeDocument } from "../frontmatter.ts";
import { botMocLink, botMocName, type Note } from "../notes.ts";
import { MemoryInertError, MemoryStore } from "../store.ts";
import { botsDir, VaultFiles } from "../vault-files.ts";

export type BotLayerStatus = "active" | "retired";

export interface BotLayerRecord {
  slug: string;
  status: BotLayerStatus;
  created: string;
  retired?: string;
}

export interface BotRegistryOptions {
  vaultRoot: string;
  trusted: boolean;
  now?: () => Date;
  secrets?: Record<string, string>;
}

export class MissingBotLayerError extends Error {
  constructor(readonly slug: string) {
    super(`bot "${slug}" has no memory layer here`);
    this.name = "MissingBotLayerError";
  }
}

const botMocFile = `${botMocName}.md`;
const botReservedPaths = [botMocFile];

export class BotRegistry {
  readonly trusted: boolean;
  private readonly root: string;
  private readonly vault: VaultFiles;
  private readonly now: () => Date;
  private readonly secrets: Record<string, string>;
  private readonly stores = new Map<string, MemoryStore>();

  constructor(options: BotRegistryOptions) {
    this.root = options.vaultRoot;
    this.vault = new VaultFiles(options.vaultRoot);
    this.trusted = options.trusted;
    this.now = options.now ?? (() => new Date());
    this.secrets = options.secrets ?? {};
  }

  async materialize(slug: string): Promise<BotLayerRecord> {
    this.gate();
    const existing = await this.readBot(slug);
    if (existing !== undefined) return existing;
    const record: BotLayerRecord = {
      slug,
      status: "active",
      created: this.now().toISOString(),
    };
    await this.writeMoc(slug, recordFrontmatter(record), `bot ${slug}\n`);
    return record;
  }

  async listBots(): Promise<BotLayerRecord[]> {
    if (!this.trusted) return [];
    const records: BotLayerRecord[] = [];
    for (const slug of await this.listBotDirs()) {
      const record = await this.readBot(slug);
      if (record !== undefined) records.push(record);
    }
    return records.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async readBot(slug: string): Promise<BotLayerRecord | undefined> {
    if (!this.trusted) return undefined;
    const raw = await this.botStore(slug).readReserved(botMocFile);
    if (raw === null) return undefined;
    return parseRecord(slug, parseDocument(raw, botMocLink(slug)).frontmatter);
  }

  async readMocNote(slug: string): Promise<Note | undefined> {
    return this.botStore(slug).readNote(botMocName);
  }

  async retireBot(slug: string): Promise<BotLayerRecord> {
    this.gate();
    const record = await this.readBot(slug);
    if (record === undefined) throw new MissingBotLayerError(slug);
    const retired: BotLayerRecord = {
      ...record,
      status: "retired",
      retired: this.now().toISOString(),
    };
    const raw = await this.botStore(slug).readReserved(botMocFile);
    const body = raw === null ? "" : parseDocument(raw, botMocLink(slug)).body;
    await this.writeMoc(slug, recordFrontmatter(retired), body);
    return retired;
  }

  botStore(slug: string): MemoryStore {
    validateBotSlug(slug);
    const cached = this.stores.get(slug);
    if (cached !== undefined) return cached;
    const store = new MemoryStore({
      vaultRoot: join(this.root, botsDir, slug),
      trusted: this.trusted,
      now: this.now,
      secrets: this.secrets,
      reservedPaths: botReservedPaths,
      learnedBy: slug,
    });
    this.stores.set(slug, store);
    return store;
  }

  private gate(): void {
    if (!this.trusted) throw new MemoryInertError();
  }

  private async writeMoc(slug: string, frontmatter: Frontmatter, body: string): Promise<void> {
    await this.botStore(slug).writeReserved(botMocFile, serializeDocument(frontmatter, body));
  }

  private async listBotDirs(): Promise<string[]> {
    return (await this.vault.dirNames(botsDir)).filter(isValidBotSlug);
  }
}

export function validateBotSlug(slug: string): void {
  validateSlug("bot", slug);
}

function isValidBotSlug(slug: string): boolean {
  try {
    validateBotSlug(slug);
    return true;
  } catch {
    return false;
  }
}

function recordFrontmatter(record: BotLayerRecord): Frontmatter {
  return {
    bot: record.slug,
    status: record.status,
    created: record.created,
    ...(record.retired !== undefined && { retired: record.retired }),
  };
}

function parseRecord(slug: string, frontmatter: Frontmatter): BotLayerRecord {
  const status = frontmatter.status === "retired" ? "retired" : "active";
  const created = typeof frontmatter.created === "string" ? frontmatter.created : "";
  const retired = typeof frontmatter.retired === "string" ? frontmatter.retired : undefined;
  return { slug, status, created, ...(retired !== undefined && { retired }) };
}
