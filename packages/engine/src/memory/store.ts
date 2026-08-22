import { readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { anchorFrontmatter, type CheckpointAnchor } from "./anchors.ts";
import {
  type Frontmatter,
  MalformedFrontmatterError,
  parseDocument,
  serializeDocument,
} from "./frontmatter.ts";
import {
  contentHash,
  type FileDelta,
  fileDelta,
  invertDelta,
  type LedgerEntry,
  type LedgerOp,
  type RevertOutcome,
} from "./ledger.ts";
import {
  canonicalEntityPath,
  InvalidTitleError,
  titleKey,
  validateConceptTitle,
} from "./naming.ts";
import { type NamedSecret, redactForPersistence } from "./redaction.ts";
import { isMissingFileError, writeFileAtomic } from "./vault-files.ts";

export type Provenance = "user" | "agent" | "untrusted";

export interface MemoryStoreOptions {
  vaultRoot: string;
  trusted: boolean;
  now?: () => Date;
  secrets?: Record<string, string>;
  reservedPaths?: readonly string[];
}

export interface NoteInput {
  title?: string;
  entity?: string;
  body: string;
  provenance: Provenance;
  aliases?: string[];
  confidence?: number;
  usefulness?: number;
  pinned?: boolean;
  supersedes?: string;
  delivered?: string;
  distilledFrom?: string;
  anchor?: CheckpointAnchor;
}

export interface Note {
  name: string;
  path: string;
  title: string;
  provenance: Provenance;
  pinned: boolean;
  aliases: string[];
  body: string;
  links: string[];
  tokens: number;
  frontmatter: Frontmatter;
  created?: string;
  confidence?: number;
  usefulness?: number;
  supersedes?: string;
  supersededBy?: string;
  delivered?: string;
  distilledFrom?: string;
}

export interface DailyEntry {
  time: string;
  provenance: Provenance;
  text: string;
}

export interface StagedItem {
  id: string;
  kind: StagedKind;
  target: string;
  created: string;
  content: string;
  supersedes?: string;
}

export interface WriteResult {
  path: string;
  staged: boolean;
  ledgerId: string;
}

export interface BootstrapSelection {
  notes: Note[];
  tokens: number;
  budget: number;
  skipped: string[];
}

export type StagedKind = "note" | "daily" | "moc";

export class MemoryInertError extends Error {
  constructor() {
    super("memory is inert: this workspace is untrusted");
    this.name = "MemoryInertError";
  }
}

export class DuplicateTitleError extends Error {
  constructor(
    readonly title: string,
    readonly existingPath: string,
  ) {
    super(`a note titled "${title}" already exists at ${existingPath}`);
    this.name = "DuplicateTitleError";
  }
}

export class MissingNoteError extends Error {
  constructor(readonly noteName: string) {
    super(`no note named "${noteName}"`);
    this.name = "MissingNoteError";
  }
}

export class StagedItemNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`no staged item with id ${id}`);
    this.name = "StagedItemNotFoundError";
  }
}

export class MalformedStagedItemError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`malformed staged item ${file}: ${detail}`);
    this.name = "MalformedStagedItemError";
  }
}

export class LedgerEntryNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`no ledger entry with id ${id}`);
    this.name = "LedgerEntryNotFoundError";
  }
}

export class PathOutsideVaultError extends Error {
  constructor(readonly path: string) {
    super(`refusing to touch ${path}: it resolves outside the vault root`);
    this.name = "PathOutsideVaultError";
  }
}

export class ReservedPathError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`reserved path ${path}: ${detail}`);
    this.name = "ReservedPathError";
  }
}

export class InvalidDailyDateError extends Error {
  constructor(readonly date: string) {
    super(`invalid daily log date ${JSON.stringify(date)}: expected YYYY-MM-DD`);
    this.name = "InvalidDailyDateError";
  }
}

const mocFile = "MEMORY.md";
const auditFile = "curation.md";
const stagingDir = ".staging";
const arcsDir = "arcs";
const hiddenDirs = new Set([stagingDir, ".obsidian"]);
const wikilinkPattern = /\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|[^[\]]*)?\]\]/g;
const dailyMarkerPattern = /^- (\d{2}:\d{2}) \[prov: (user|agent|untrusted)\] (.*)$/;
const dailyDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export class MemoryStore {
  readonly trusted: boolean;
  private readonly root: string;
  private readonly now: () => Date;
  private readonly secrets: NamedSecret[];
  private readonly reserved: Set<string>;
  private readonly log: LedgerEntry[] = [];
  private turn: Promise<unknown> = Promise.resolve();

  constructor(options: MemoryStoreOptions) {
    this.root = options.vaultRoot;
    this.trusted = options.trusted;
    this.now = options.now ?? (() => new Date());
    this.secrets = Object.entries(options.secrets ?? {}).map(([name, value]) => ({ name, value }));
    this.reserved = new Set(options.reservedPaths ?? []);
  }

  async listNotes(): Promise<Note[]> {
    if (!this.trusted) return [];
    const notes: Note[] = [];
    for (const path of await this.walkNotePaths()) {
      const note = await this.parseNote(path);
      if (note !== undefined) notes.push(note);
    }
    return notes;
  }

  async readNote(name: string): Promise<Note | undefined> {
    if (!this.trusted) return undefined;
    let path: string | undefined;
    try {
      path = (await this.resolveNotePath(name)) ?? this.reservedNotePath(name);
    } catch (error) {
      if (error instanceof InvalidTitleError) return undefined;
      throw error;
    }
    if (path === undefined) return undefined;
    return this.parseNote(path);
  }

  async readMoc(): Promise<string[]> {
    if (!this.trusted) return [];
    const raw = await this.readIfExists(mocFile);
    if (raw === null) return [];
    return extractWikilinks(raw);
  }

  async readDaily(date?: string): Promise<DailyEntry[]> {
    if (!this.trusted) return [];
    const raw = await this.readIfExists(dailyPath(date ?? isoDate(this.now())));
    if (raw === null) return [];
    return parseDailyEntries(raw);
  }

  async readReserved(path: string): Promise<string | null> {
    this.requireReserved(path);
    if (!this.trusted) return null;
    return this.readIfExists(path);
  }

  async listReserved(dir: string): Promise<string[]> {
    if (!this.reserved.has(`${dir}/`)) throw new ReservedPathError(dir, "not a reserved directory");
    if (!this.trusted) return [];
    return (await this.listDirEntries(dir))
      .filter((entry) => entry.isFile())
      .map((entry) => `${dir}/${entry.name}`)
      .sort();
  }

  async listStaged(): Promise<StagedItem[]> {
    if (!this.trusted) return [];
    const files = new Set(await this.listDir(stagingDir));
    const items: StagedItem[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -".json".length);
      if (!files.has(`${id}.md`)) continue;
      items.push(await this.readStaged(id));
    }
    return items.sort((a, b) => a.created.localeCompare(b.created));
  }

  ledger(): readonly LedgerEntry[] {
    return this.log;
  }

  async listDailyDates(): Promise<string[]> {
    if (!this.trusted) return [];
    return (await this.listDir("daily"))
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.slice(0, -".md".length))
      .filter((date) => dailyDatePattern.test(date))
      .sort();
  }

  async bootstrap(tokenBudget: number): Promise<BootstrapSelection> {
    if (!this.trusted) return { notes: [], tokens: 0, budget: tokenBudget, skipped: [] };
    const candidates = await this.bootstrapCandidates();
    const notes: Note[] = [];
    const skipped: string[] = [];
    let tokens = 0;
    for (const note of candidates) {
      if (tokens + note.tokens > tokenBudget) {
        skipped.push(note.name);
        continue;
      }
      notes.push(note);
      tokens += note.tokens;
    }
    return { notes, tokens, budget: tokenBudget, skipped };
  }

  redact(text: string): string {
    return redactForPersistence(text, this.secrets);
  }

  async writeNote(input: NoteInput): Promise<WriteResult> {
    this.gate();
    return this.serialized(async () => {
      const body = this.redact(input.body);
      const target = await this.resolveWriteTarget(input);
      const supersedes = await this.resolveSupersedes(input);
      const frontmatter = await this.noteFrontmatter(input, target, supersedes);
      const content = ensureTrailingNewline(serializeDocument(frontmatter, body));
      if (input.provenance === "untrusted")
        return this.stage("note", target.path, content, supersedes);
      const deltas = [await this.delta(target.path, content)];
      if (supersedes !== undefined)
        deltas.push(await this.supersededStamp(supersedes, target.name));
      const op: LedgerOp = deltas[0]?.before === null ? "create" : "edit";
      return this.commit(op, deltas, target.path, false);
    });
  }

  async appendDaily(text: string, provenance: Provenance): Promise<WriteResult> {
    this.gate();
    return this.serialized(async () => {
      const path = dailyPath(isoDate(this.now()));
      const entry = dailyEntryLines(this.redact(text), provenance, isoTime(this.now()));
      if (provenance === "untrusted") return this.stage("daily", path, entry);
      const before = await this.readIfExists(path);
      const delta = fileDelta(path, before, `${before ?? ""}${entry}`);
      return this.commit(before === null ? "create" : "edit", [delta], path, false);
    });
  }

  async writeMoc(links: string[], provenance: Provenance): Promise<WriteResult> {
    this.gate();
    return this.serialized(async () => {
      const content = this.redact(mocContent(links));
      if (provenance === "untrusted") return this.stage("moc", mocFile, content);
      const delta = await this.delta(mocFile, content);
      return this.commit(delta.before === null ? "create" : "edit", [delta], mocFile, false);
    });
  }

  async writeReserved(path: string, content: string): Promise<WriteResult> {
    this.gate();
    this.requireReserved(path);
    return this.serialized(async () => {
      const delta = await this.delta(path, this.redact(content));
      return this.commit(delta.before === null ? "create" : "edit", [delta], path, false);
    });
  }

  async recordAudit(event: string): Promise<void> {
    this.gate();
    await this.serialized(() => this.audit(this.redact(event)));
  }

  async approve(stagedId: string): Promise<WriteResult> {
    this.gate();
    return this.serialized(async () => {
      const item = await this.readStaged(stagedId);
      const after =
        item.kind === "daily"
          ? `${(await this.readIfExists(item.target)) ?? ""}${item.content}`
          : item.content;
      const deltas = [
        fileDelta(item.target, await this.readIfExists(item.target), after),
        ...(await this.stagedRemovalDeltas(stagedId)),
      ];
      if (item.supersedes !== undefined) {
        const stamp = await this.trySupersededStamp(item.supersedes, noteName(item.target));
        if (stamp !== undefined) deltas.push(stamp);
      }
      const result = await this.commit("approve", deltas, item.target, false);
      await this.audit(`approved ${item.kind} → ${item.target}`);
      return result;
    });
  }

  async discard(stagedId: string): Promise<void> {
    this.gate();
    await this.serialized(async () => {
      const item = await this.readStaged(stagedId);
      await this.commit("discard", await this.stagedRemovalDeltas(stagedId), item.target, false);
      await this.audit(`discarded ${item.kind} → ${item.target}`);
    });
  }

  async revert(ledgerId: string): Promise<RevertOutcome> {
    this.gate();
    return this.serialized(async () => {
      const entry = this.log.find((candidate) => candidate.id === ledgerId);
      if (entry === undefined) throw new LedgerEntryNotFoundError(ledgerId);
      for (const delta of entry.deltas) {
        const current = await this.readIfExists(delta.path);
        const currentHash = current === null ? null : contentHash(current);
        if (currentHash !== delta.afterHash) return "needs-rebase";
      }
      const inverted = entry.deltas.map(invertDelta);
      await this.commit("revert", inverted, entry.deltas[0]?.path ?? "", false);
      return "reverted";
    });
  }

  private gate(): void {
    if (!this.trusted) throw new MemoryInertError();
  }

  private serialized<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.turn.then(mutation);
    this.turn = result.then(noop, noop);
    return result;
  }

  private isReserved(path: string): boolean {
    if (!isVaultRelativePath(path)) return false;
    if (this.reserved.has(path)) return true;
    for (const entry of this.reserved) {
      if (entry.endsWith("/") && path.startsWith(entry)) return true;
    }
    return false;
  }

  private requireReserved(path: string): void {
    if (!this.isReserved(path)) throw new ReservedPathError(path, "not reserved by this vault");
  }

  private reservedNotePath(name: string): string | undefined {
    const path = `${name}.md`;
    return this.reserved.has(path) ? path : undefined;
  }

  private async resolveWriteTarget(input: NoteInput): Promise<{ path: string; name: string }> {
    const target =
      input.entity !== undefined
        ? await this.resolveEntityTarget(this.redact(input.entity))
        : await this.resolveTitleTarget(this.redact(input.title ?? ""));
    if (this.isReserved(target.path))
      throw new InvalidTitleError(target.name, "reserved by the vault layout");
    return target;
  }

  private async resolveTitleTarget(title: string): Promise<{ path: string; name: string }> {
    validateConceptTitle(title);
    const key = titleKey(title);
    for (const path of await this.walkNotePaths()) {
      if (path.startsWith("entities/")) continue;
      if (titleKey(stemName(path)) !== key) continue;
      if (noteTitle(path) === title) return { path, name: noteName(path) };
      throw new DuplicateTitleError(title, path);
    }
    return { path: `${title}.md`, name: title };
  }

  private async resolveEntityTarget(entity: string): Promise<{ path: string; name: string }> {
    const canonical = `entities/${canonicalEntityPath(entity)}`;
    const key = titleKey(canonical);
    for (const path of await this.walkNotePaths()) {
      if (titleKey(noteName(path)) === key) return { path, name: noteName(path) };
    }
    return { path: `${canonical}.md`, name: canonical };
  }

  private async resolveSupersedes(input: NoteInput): Promise<string | undefined> {
    if (input.supersedes === undefined) return undefined;
    const path = await this.resolveNotePath(input.supersedes);
    if (path === undefined) throw new MissingNoteError(input.supersedes);
    return noteName(path);
  }

  private async noteFrontmatter(
    input: NoteInput,
    target: { path: string; name: string },
    supersedes: string | undefined,
  ): Promise<Frontmatter> {
    const existing = await this.readIfExists(target.path);
    const inherited = existing === null ? {} : parseDocument(existing, target.path).frontmatter;
    const aliases = this.noteAliases(input, target, inherited);
    return {
      ...inherited,
      provenance: input.provenance,
      created: firstString(inherited.created) ?? this.now().toISOString(),
      ...(resolvePinned(input, inherited) && { pinned: true }),
      ...(input.confidence !== undefined && { confidence: input.confidence }),
      ...(input.usefulness !== undefined && { usefulness: input.usefulness }),
      ...(aliases.length > 0 && { aliases }),
      ...(supersedes !== undefined && { supersedes: `[[${supersedes}]]` }),
      ...(input.delivered !== undefined && {
        delivered: input.delivered,
        valid_from: input.delivered,
      }),
      ...(input.distilledFrom !== undefined && { distilled_from: `[[${input.distilledFrom}]]` }),
      ...(input.anchor !== undefined && anchorFrontmatter(input.anchor)),
    };
  }

  private noteAliases(
    input: NoteInput,
    target: { path: string; name: string },
    inherited: Frontmatter,
  ): string[] {
    const aliases = (input.aliases ?? asStringArray(inherited.aliases)).map((alias) =>
      this.redact(alias),
    );
    if (input.entity === undefined) return aliases;
    const short = stemName(target.path);
    return aliases.includes(short) ? aliases : [...aliases, short];
  }

  private async supersededStamp(oldName: string, newName: string): Promise<FileDelta> {
    const stamp = await this.trySupersededStamp(oldName, newName);
    if (stamp === undefined) throw new MissingNoteError(oldName);
    return stamp;
  }

  private async trySupersededStamp(
    oldName: string,
    newName: string,
  ): Promise<FileDelta | undefined> {
    const path = await this.resolveNotePath(oldName);
    if (path === undefined) return undefined;
    const raw = await this.readIfExists(path);
    if (raw === null) return undefined;
    const { frontmatter, body } = parseDocument(raw, path);
    const stamped = { ...frontmatter, superseded_by: `[[${newName}]]` };
    return fileDelta(path, raw, ensureTrailingNewline(serializeDocument(stamped, body)));
  }

  private async stage(
    kind: StagedKind,
    target: string,
    content: string,
    supersedes?: string,
  ): Promise<WriteResult> {
    const id = crypto.randomUUID();
    const meta = {
      kind,
      target,
      created: this.now().toISOString(),
      ...(supersedes !== undefined && { supersedes }),
    };
    const deltas = [
      fileDelta(stagedContentPath(id), null, content),
      fileDelta(stagedMetaPath(id), null, `${JSON.stringify(meta)}\n`),
    ];
    return this.commit("create", deltas, target, true);
  }

  private async readStaged(id: string): Promise<StagedItem> {
    const metaRaw = await this.readIfExists(stagedMetaPath(id));
    const content = await this.readIfExists(stagedContentPath(id));
    if (metaRaw === null || content === null) throw new StagedItemNotFoundError(id);
    return { id, content, ...parseStagedMeta(metaRaw, stagedMetaPath(id)) };
  }

  private async stagedRemovalDeltas(id: string): Promise<FileDelta[]> {
    return [
      fileDelta(stagedContentPath(id), await this.readIfExists(stagedContentPath(id)), null),
      fileDelta(stagedMetaPath(id), await this.readIfExists(stagedMetaPath(id)), null),
    ];
  }

  private async commit(
    op: LedgerOp,
    deltas: FileDelta[],
    path: string,
    staged: boolean,
  ): Promise<WriteResult> {
    for (const delta of deltas) await this.apply(delta);
    const entry: LedgerEntry = {
      id: crypto.randomUUID(),
      op,
      timestamp: this.now().toISOString(),
      deltas,
    };
    this.log.push(entry);
    return { path, staged, ledgerId: entry.id };
  }

  private async apply(delta: FileDelta): Promise<void> {
    const abs = this.containedPath(delta.path);
    if (delta.after === null) {
      await rm(abs, { force: true });
      return;
    }
    await writeFileAtomic(abs, delta.after);
  }

  private containedPath(path: string): string {
    const root = resolve(this.root);
    const abs = resolve(root, path);
    if (!abs.startsWith(`${root}${sep}`)) throw new PathOutsideVaultError(path);
    return abs;
  }

  private async audit(event: string): Promise<void> {
    const line = `- ${this.now().toISOString()} ${event}\n`;
    const before = await this.readIfExists(auditFile);
    await this.apply(fileDelta(auditFile, before, `${before ?? ""}${line}`));
  }

  private async bootstrapCandidates(): Promise<Note[]> {
    const byKey = new Map<string, Note>();
    for (const note of await this.listNotes()) {
      byKey.set(titleKey(note.name), note);
      if (!note.path.startsWith("entities/")) byKey.set(titleKey(note.title), note);
    }
    const inMocOrder: Note[] = [];
    for (const link of await this.readMoc()) {
      const note = byKey.get(titleKey(link));
      if (note === undefined || inMocOrder.includes(note)) continue;
      if (note.supersededBy !== undefined) continue;
      inMocOrder.push(note);
    }
    return [
      ...mostUsefulFirst(inMocOrder.filter((note) => note.pinned)),
      ...mostUsefulFirst(inMocOrder.filter((note) => !note.pinned)),
    ];
  }

  private async resolveNotePath(name: string): Promise<string | undefined> {
    const paths = await this.walkNotePaths();
    const keys = name.includes("/") ? entityLookupKeys(name) : [titleKey(name)];
    for (const key of keys) {
      const exact = paths.find((path) => titleKey(noteName(path)) === key);
      if (exact !== undefined) return exact;
      const byStem = paths.filter(
        (path) => !path.startsWith("entities/") && titleKey(stemName(path)) === key,
      );
      if (byStem.length === 1) return byStem[0];
    }
    return undefined;
  }

  private async parseNote(path: string): Promise<Note | undefined> {
    const raw = await this.readIfExists(path);
    if (raw === null) return undefined;
    const { frontmatter, body } = parseDocument(raw, path);
    if (frontmatter.staged === true) return undefined;
    const provenance = parseProvenance(frontmatter, path);
    const created = firstString(frontmatter.created);
    const confidence = frontmatter.confidence;
    const usefulness = frontmatter.usefulness;
    const supersedes = linkTarget(frontmatter.supersedes);
    const supersededBy = linkTarget(frontmatter.superseded_by);
    const delivered = firstString(frontmatter.delivered);
    const distilledFrom = linkTarget(frontmatter.distilled_from);
    return {
      name: noteName(path),
      path,
      title: noteTitle(path),
      provenance,
      pinned: frontmatter.pinned === true,
      aliases: asStringArray(frontmatter.aliases),
      body,
      links: extractWikilinks(body),
      tokens: Math.ceil(raw.length / 4),
      frontmatter,
      ...(created !== undefined && { created }),
      ...(typeof confidence === "number" && { confidence }),
      ...(typeof usefulness === "number" && { usefulness }),
      ...(supersedes !== undefined && { supersedes }),
      ...(supersededBy !== undefined && { supersededBy }),
      ...(delivered !== undefined && { delivered }),
      ...(distilledFrom !== undefined && { distilledFrom }),
    };
  }

  private async walkNotePaths(): Promise<string[]> {
    const paths: string[] = [];
    await this.walk("", paths);
    return paths.sort();
  }

  private async walk(dir: string, paths: string[]): Promise<void> {
    for (const entry of await this.listDirEntries(dir)) {
      const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (hiddenDirs.has(entry.name) || rel === "daily" || rel === arcsDir) continue;
        if (this.reserved.has(`${rel}/`)) continue;
        await this.walk(rel, paths);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      if (rel === mocFile || rel === auditFile || this.reserved.has(rel)) continue;
      paths.push(rel);
    }
  }

  private async listDirEntries(dir: string) {
    try {
      return await readdir(join(this.root, dir), { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
  }

  private async listDir(dir: string): Promise<string[]> {
    return (await this.listDirEntries(dir)).map((entry) => entry.name);
  }

  private async delta(path: string, after: string): Promise<FileDelta> {
    return fileDelta(path, await this.readIfExists(path), after);
  }

  private async readIfExists(path: string): Promise<string | null> {
    try {
      return await readFile(join(this.root, path), "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }
}

export function extractWikilinks(text: string): string[] {
  const links: string[] = [];
  for (const match of text.matchAll(wikilinkPattern)) {
    const target = match[1]?.trim();
    if (target !== undefined && target !== "" && !links.includes(target)) links.push(target);
  }
  return links;
}

function isVaultRelativePath(path: string): boolean {
  if (path === "" || isAbsolute(path) || /^[A-Za-z]:/.test(path) || /^[\\/]/.test(path))
    return false;
  return path
    .split(/[\\/]/)
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function noop(): void {}

function noteName(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -".md".length) : path;
}

function noteTitle(path: string): string {
  const name = noteName(path);
  return path.startsWith("entities/") ? name : stemName(path);
}

function stemName(path: string): string {
  const name = noteName(path);
  const slash = name.lastIndexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}

function entityLookupKeys(name: string): string[] {
  const canonical = canonicalEntityPath(name.replace(/^entities\//, ""));
  return [titleKey(`entities/${canonical}`)];
}

function dailyPath(date: string): string {
  if (!dailyDatePattern.test(date)) throw new InvalidDailyDateError(date);
  return `daily/${date}.md`;
}

function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function isoTime(now: Date): string {
  return now.toISOString().slice(11, 16);
}

function dailyEntryLines(text: string, provenance: Provenance, time: string): string {
  const [first = "", ...rest] = text.split("\n");
  const lines = [`- ${time} [prov: ${provenance}] ${first}`, ...rest.map((line) => `  ${line}`)];
  return `${lines.join("\n")}\n`;
}

function parseDailyEntries(raw: string): DailyEntry[] {
  const entries: DailyEntry[] = [];
  for (const line of raw.split("\n")) {
    const marker = line.match(dailyMarkerPattern);
    if (marker !== null) {
      entries.push({
        time: marker[1] ?? "",
        provenance: (marker[2] ?? "user") as Provenance,
        text: marker[3] ?? "",
      });
      continue;
    }
    const open = entries.at(-1);
    if (open === undefined || line === "") continue;
    open.text += `\n${line.startsWith("  ") ? line.slice(2) : line}`;
  }
  return entries;
}

function mocContent(links: string[]): string {
  const lines = links.map((link) => {
    const trimmed = link.trim();
    if (trimmed === "" || /[[\]\n]/.test(trimmed))
      throw new InvalidTitleError(link, "not a linkable note name");
    return `- [[${trimmed}]]`;
  });
  return `${lines.join("\n")}\n`;
}

function parseProvenance(frontmatter: Frontmatter, path: string): Provenance {
  const value = frontmatter.provenance;
  if (value === undefined) return "user";
  if (value === "user" || value === "agent" || value === "untrusted") return value;
  throw new MalformedFrontmatterError(path, `unknown provenance ${JSON.stringify(value)}`);
}

function parseStagedMeta(
  raw: string,
  file: string,
): { kind: StagedKind; target: string; created: string; supersedes?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MalformedStagedItemError(file, "not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object")
    throw new MalformedStagedItemError(file, "not an object");
  const meta = parsed as Record<string, unknown>;
  const kind = meta.kind;
  const target = meta.target;
  const created = meta.created;
  const supersedes = meta.supersedes;
  if (kind !== "note" && kind !== "daily" && kind !== "moc")
    throw new MalformedStagedItemError(file, `unknown kind ${JSON.stringify(kind)}`);
  if (typeof target !== "string" || typeof created !== "string")
    throw new MalformedStagedItemError(file, "missing target or created");
  if (!isVaultRelativePath(target))
    throw new MalformedStagedItemError(file, `target ${JSON.stringify(target)} leaves the vault`);
  return {
    kind,
    target,
    created,
    ...(typeof supersedes === "string" && { supersedes }),
  };
}

function mostUsefulFirst(notes: Note[]): Note[] {
  const priorOf = (note: Note) => note.usefulness ?? note.confidence ?? 0;
  return [...notes].sort((a, b) => priorOf(b) - priorOf(a));
}

function resolvePinned(input: NoteInput, inherited: Frontmatter): boolean {
  return input.pinned ?? inherited.pinned === true;
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function linkTarget(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^\[\[([^[\]|#]+)\]\]$/);
  return match?.[1]?.trim() ?? (value.trim() === "" ? undefined : value.trim());
}

function stagedContentPath(id: string): string {
  return `${stagingDir}/${id}.md`;
}

function stagedMetaPath(id: string): string {
  return `${stagingDir}/${id}.json`;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
