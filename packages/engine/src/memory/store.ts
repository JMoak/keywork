import { anchorFrontmatter, type CheckpointAnchor } from "./anchors.ts";
import { type AuditEntry, auditLine, parseAuditLog } from "./audit.ts";
import { type BootstrapSelection, mostUsefulFirst, selectWithinBudget } from "./bootstrap.ts";
import { type Frontmatter, parseDocument, serializeDocument } from "./frontmatter.ts";
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
import {
  asStringArray,
  type DailyEntry,
  dailyDateOf,
  dailyEntryLines,
  dailyPath,
  dailyTimeOf,
  extractWikilinks,
  firstString,
  isDailyDate,
  isEntityPath,
  mocContent,
  type Note,
  noteName,
  noteTitle,
  type Provenance,
  parseDailyEntries,
  parseNote,
  stemName,
} from "./notes.ts";
import { type NamedSecret, redactForPersistence } from "./redaction.ts";
import {
  admitReviews,
  adoptionDeltas,
  describeStaged,
  isStagedWrite,
  type ReviewProposal,
  redactedReview,
  type StagedItem,
  type StagedReview,
  type StagedReviewMeta,
  type StagedWriteKind,
  StagingArea,
  stagedReviewDeltas,
  stagedSubjectPath,
  stagedWriteDeltas,
} from "./staging.ts";
import { auditFile, dailyDir, mocFile, VaultFiles } from "./vault-files.ts";

export interface MemoryStoreOptions {
  vaultRoot: string;
  trusted: boolean;
  now?: () => Date;
  secrets?: Record<string, string>;
  reservedPaths?: readonly string[];
  ledgerCapacity?: number;
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

export interface WriteResult {
  path: string;
  staged: boolean;
  ledgerId: string;
}

export const defaultLedgerCapacity = 128;

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

export class LedgerEntryNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`no ledger entry with id ${id}`);
    this.name = "LedgerEntryNotFoundError";
  }
}

interface WriteTarget {
  path: string;
  name: string;
}

export class MemoryStore {
  readonly trusted: boolean;
  private readonly files: VaultFiles;
  private readonly staging: StagingArea;
  private readonly now: () => Date;
  private readonly secrets: NamedSecret[];
  private readonly ledgerCapacity: number;
  private readonly log: LedgerEntry[] = [];
  private turn: Promise<unknown> = Promise.resolve();

  constructor(options: MemoryStoreOptions) {
    this.files = new VaultFiles(options.vaultRoot, options.reservedPaths);
    this.staging = new StagingArea(this.files);
    this.trusted = options.trusted;
    this.now = options.now ?? (() => new Date());
    this.secrets = Object.entries(options.secrets ?? {}).map(([name, value]) => ({ name, value }));
    this.ledgerCapacity = options.ledgerCapacity ?? defaultLedgerCapacity;
  }

  async listNotes(): Promise<Note[]> {
    if (!this.trusted) return [];
    const notes: Note[] = [];
    for (const path of await this.files.walkNotes()) {
      const note = await this.readNoteFile(path);
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
    return path === undefined ? undefined : this.readNoteFile(path);
  }

  async readMoc(): Promise<string[]> {
    if (!this.trusted) return [];
    const raw = await this.files.read(mocFile);
    return raw === null ? [] : extractWikilinks(raw);
  }

  async readDaily(date?: string): Promise<DailyEntry[]> {
    if (!this.trusted) return [];
    const raw = await this.files.read(dailyPath(date ?? dailyDateOf(this.now())));
    return raw === null ? [] : parseDailyEntries(raw);
  }

  async listDailyDates(): Promise<string[]> {
    if (!this.trusted) return [];
    return (await this.files.fileNames(dailyDir))
      .filter((file) => file.endsWith(".md"))
      .map(noteName)
      .filter(isDailyDate);
  }

  async readReserved(path: string): Promise<string | null> {
    this.files.requireReserved(path);
    if (!this.trusted) return null;
    return this.files.read(path);
  }

  async listReserved(dir: string): Promise<string[]> {
    this.files.requireReservedDir(dir);
    if (!this.trusted) return [];
    return (await this.files.fileNames(dir)).map((name) => `${dir}/${name}`);
  }

  async listStaged(): Promise<StagedItem[]> {
    if (!this.trusted) return [];
    return this.serialized(async () => {
      await this.adoptLegacyInbox();
      return this.staging.list();
    });
  }

  async readAudit(): Promise<AuditEntry[]> {
    if (!this.trusted) return [];
    const raw = await this.files.read(auditFile);
    return raw === null ? [] : parseAuditLog(raw);
  }

  async bootstrap(tokenBudget: number): Promise<BootstrapSelection> {
    const candidates = this.trusted ? await this.bootstrapCandidates() : [];
    return selectWithinBudget(candidates, tokenBudget);
  }

  ledger(): readonly LedgerEntry[] {
    return this.log;
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
      const path = dailyPath(dailyDateOf(this.now()));
      const entry = dailyEntryLines(this.redact(text), provenance, dailyTimeOf(this.now()));
      if (provenance === "untrusted") return this.stage("daily", path, entry);
      const before = await this.files.read(path);
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
    this.files.requireReserved(path);
    return this.serialized(async () => {
      const delta = await this.delta(path, this.redact(content));
      return this.commit(delta.before === null ? "create" : "edit", [delta], path, false);
    });
  }

  async propose(proposals: readonly ReviewProposal[]): Promise<StagedReview[]> {
    this.gate();
    return this.serialized(async () => {
      await this.adoptLegacyInbox();
      const created = this.now().toISOString();
      const candidates = proposals.map((proposal) => this.reviewOf(proposal, created));
      const admitted = admitReviews(candidates, await this.staging.list());
      for (const review of admitted) {
        await this.commit("create", stagedReviewDeltas([review]), stagedSubjectPath(review), true);
      }
      return admitted;
    });
  }

  async recordAudit(event: string): Promise<void> {
    this.gate();
    await this.serialized(() => this.audit(this.redact(event)));
  }

  async approve(stagedId: string): Promise<WriteResult> {
    this.gate();
    return this.serialized(async () => {
      const item = await this.staging.require(stagedId);
      const deltas = [
        ...(await this.landingDeltas(item)),
        ...(await this.staging.removalDeltas(item)),
      ];
      const result = await this.commit("approve", deltas, stagedSubjectPath(item), false);
      await this.audit(`approved ${describeStaged(item)}`);
      return result;
    });
  }

  async discard(stagedId: string): Promise<void> {
    this.gate();
    await this.serialized(async () => {
      const item = await this.staging.require(stagedId);
      const deltas = await this.staging.removalDeltas(item);
      await this.commit("discard", deltas, stagedSubjectPath(item), false);
      await this.audit(`discarded ${describeStaged(item)}`);
    });
  }

  async revert(ledgerId: string): Promise<RevertOutcome> {
    this.gate();
    return this.serialized(async () => {
      const entry = this.log.find((candidate) => candidate.id === ledgerId);
      if (entry === undefined) throw new LedgerEntryNotFoundError(ledgerId);
      for (const delta of entry.deltas) {
        const current = await this.files.read(delta.path);
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

  private reservedNotePath(name: string): string | undefined {
    const path = `${name}.md`;
    return this.files.isReserved(path) ? path : undefined;
  }

  private async readNoteFile(path: string): Promise<Note | undefined> {
    const raw = await this.files.read(path);
    return raw === null ? undefined : parseNote(path, raw);
  }

  private async resolveWriteTarget(input: NoteInput): Promise<WriteTarget> {
    const target =
      input.entity !== undefined
        ? await this.resolveEntityTarget(this.redact(input.entity))
        : await this.resolveTitleTarget(this.redact(input.title ?? ""));
    if (this.files.isReserved(target.path))
      throw new InvalidTitleError(target.name, "reserved by the vault layout");
    return target;
  }

  private async resolveTitleTarget(title: string): Promise<WriteTarget> {
    validateConceptTitle(title);
    const key = titleKey(title);
    for (const path of await this.files.walkNotes()) {
      if (isEntityPath(path)) continue;
      if (titleKey(stemName(path)) !== key) continue;
      if (noteTitle(path) === title) return { path, name: noteName(path) };
      throw new DuplicateTitleError(title, path);
    }
    return { path: `${title}.md`, name: title };
  }

  private async resolveEntityTarget(entity: string): Promise<WriteTarget> {
    const canonical = `entities/${canonicalEntityPath(entity)}`;
    const key = titleKey(canonical);
    for (const path of await this.files.walkNotes()) {
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

  private async resolveNotePath(name: string): Promise<string | undefined> {
    const paths = await this.files.walkNotes();
    const keys = name.includes("/") ? entityLookupKeys(name) : [titleKey(name)];
    for (const key of keys) {
      const exact = paths.find((path) => titleKey(noteName(path)) === key);
      if (exact !== undefined) return exact;
      const byStem = paths.filter(
        (path) => !isEntityPath(path) && titleKey(stemName(path)) === key,
      );
      if (byStem.length === 1) return byStem[0];
    }
    return undefined;
  }

  private async noteFrontmatter(
    input: NoteInput,
    target: WriteTarget,
    supersedes: string | undefined,
  ): Promise<Frontmatter> {
    const existing = await this.files.read(target.path);
    const inherited = existing === null ? {} : parseDocument(existing, target.path).frontmatter;
    const aliases = this.noteAliases(input, target, inherited);
    return {
      ...inherited,
      provenance: input.provenance,
      created: firstString(inherited.created) ?? this.now().toISOString(),
      ...((input.pinned ?? inherited.pinned === true) && { pinned: true }),
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

  private noteAliases(input: NoteInput, target: WriteTarget, inherited: Frontmatter): string[] {
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
    const raw = await this.files.read(path);
    if (raw === null) return undefined;
    const { frontmatter, body } = parseDocument(raw, path);
    const stamped = { ...frontmatter, superseded_by: `[[${newName}]]` };
    return fileDelta(path, raw, ensureTrailingNewline(serializeDocument(stamped, body)));
  }

  private async stage(
    kind: StagedWriteKind,
    target: string,
    content: string,
    supersedes?: string,
  ): Promise<WriteResult> {
    const meta = {
      kind,
      target,
      created: this.now().toISOString(),
      ...(supersedes !== undefined && { supersedes }),
    };
    return this.commit("create", stagedWriteDeltas(meta, content), target, true);
  }

  private async landingDeltas(item: StagedItem): Promise<FileDelta[]> {
    if (!isStagedWrite(item)) return [];
    const before = await this.files.read(item.target);
    const after = item.kind === "daily" ? `${before ?? ""}${item.content}` : item.content;
    const deltas = [fileDelta(item.target, before, after)];
    if (item.supersedes !== undefined) {
      const stamp = await this.trySupersededStamp(item.supersedes, noteName(item.target));
      if (stamp !== undefined) deltas.push(stamp);
    }
    return deltas;
  }

  private async adoptLegacyInbox(): Promise<void> {
    const legacy = await this.staging.legacyInbox();
    if (legacy === undefined) return;
    const candidates = legacy.reviews.map((meta) => this.reviewOf(meta, meta.created));
    const adopted = admitReviews(candidates, await this.staging.list());
    await this.commit("create", adoptionDeltas(adopted, legacy), "", true);
  }

  private reviewOf(proposal: ReviewProposal, created: string): StagedReviewMeta {
    return redactedReview(proposal, created, (text) => this.redact(text));
  }

  private async bootstrapCandidates(): Promise<Note[]> {
    const byKey = new Map<string, Note>();
    for (const note of await this.listNotes()) {
      byKey.set(titleKey(note.name), note);
      if (!isEntityPath(note.path)) byKey.set(titleKey(note.title), note);
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
    if (this.log.length > this.ledgerCapacity)
      this.log.splice(0, this.log.length - this.ledgerCapacity);
    return { path, staged, ledgerId: entry.id };
  }

  private async apply(delta: FileDelta): Promise<void> {
    if (delta.after === null) await this.files.remove(delta.path);
    else await this.files.write(delta.path, delta.after);
  }

  private async audit(event: string): Promise<void> {
    const line = auditLine(this.now().toISOString(), event);
    const before = await this.files.read(auditFile);
    await this.apply(fileDelta(auditFile, before, `${before ?? ""}${line}`));
  }

  private async delta(path: string, after: string): Promise<FileDelta> {
    return fileDelta(path, await this.files.read(path), after);
  }
}

function entityLookupKeys(name: string): string[] {
  const canonical = canonicalEntityPath(name.replace(/^entities\//, ""));
  return [titleKey(`entities/${canonical}`)];
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function noop(): void {}
