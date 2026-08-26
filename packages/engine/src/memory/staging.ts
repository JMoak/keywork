import { z } from "zod";
import { type FileDelta, fileDelta } from "./ledger.ts";
import { titleKey } from "./naming.ts";
import { provenances } from "./notes.ts";
import { isVaultRelativePath, stagingDir, type VaultFiles } from "./vault-files.ts";

export type StagedWriteKind = "note" | "daily" | "moc";

export interface StagedWriteMeta {
  kind: StagedWriteKind;
  target: string;
  created: string;
  supersedes?: string;
}

export interface StagedWrite extends StagedWriteMeta {
  id: string;
  content: string;
}

export type StagedReviewMeta = ReviewProposal & { key: string; created: string };

export type StagedReview = StagedReviewMeta & { id: string };

export type StagedMeta = StagedWriteMeta | StagedReviewMeta;

export type StagedItem = StagedWrite | StagedReview;

export type StagedKind = StagedItem["kind"];

export interface LegacyInbox {
  raw: string;
  reviews: StagedReviewMeta[];
}

const provenanceSchema = z.enum(provenances);

export const reviewProposalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("borderline-promotion"),
    title: z.string(),
    body: z.string(),
    confidence: z.number(),
    source: z.string(),
  }),
  z.object({
    kind: z.literal("contradiction"),
    a: z.string(),
    b: z.string(),
    aProvenance: provenanceSchema,
    bProvenance: provenanceSchema,
    confidence: z.number(),
  }),
  z.object({
    kind: z.literal("merge-proposal"),
    keep: z.string(),
    retire: z.string(),
    confidence: z.number(),
  }),
  z.object({
    kind: z.literal("supersession-proposal"),
    winner: z.string(),
    loser: z.string(),
    confidence: z.number(),
  }),
  z.object({
    kind: z.literal("link-proposal"),
    note: z.string(),
    target: z.string(),
    mention: z.string(),
  }),
  z.object({
    kind: z.literal("arc-distillation"),
    arc: z.string(),
    note: z.string(),
    eligible: z.boolean(),
  }),
  z.object({ kind: z.literal("arc-question"), arc: z.string(), note: z.string() }),
  z.object({
    kind: z.literal("preference-proposal"),
    toolShape: z.string(),
    approvals: z.number(),
  }),
]);

export type ReviewProposal = z.infer<typeof reviewProposalSchema>;

export class MalformedStagedItemError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`malformed staged item ${file}: ${detail}`);
    this.name = "MalformedStagedItemError";
  }
}

export class StagedItemNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`no staged item with id ${id}`);
    this.name = "StagedItemNotFoundError";
  }
}

export class StagingArea {
  constructor(private readonly files: VaultFiles) {}

  async list(): Promise<StagedItem[]> {
    const items: StagedItem[] = [];
    for (const name of await this.files.fileNames(stagingDir)) {
      const id = stagedIdOfFile(name);
      const item = id === undefined ? undefined : await this.find(id);
      if (item !== undefined) items.push(item);
    }
    return items.sort(byCreationThenSubject);
  }

  async find(id: string): Promise<StagedItem | undefined> {
    if (!isStagedId(id)) return undefined;
    const metaRaw = await this.files.read(stagedMetaPath(id));
    if (metaRaw === null) return undefined;
    const meta = parseStagedMeta(metaRaw, stagedMetaPath(id));
    if (!isStagedWrite(meta)) return { id, ...meta };
    const content = await this.files.read(stagedContentPath(id));
    return content === null ? undefined : { id, content, ...meta };
  }

  async require(id: string): Promise<StagedItem> {
    const item = await this.find(id);
    if (item === undefined) throw new StagedItemNotFoundError(id);
    return item;
  }

  async legacyInbox(): Promise<LegacyInbox | undefined> {
    const raw = await this.files.read(legacyInboxPath);
    if (raw === null) return undefined;
    return { raw, reviews: parseLegacyInbox(raw, legacyInboxPath) };
  }

  async removalDeltas(item: StagedItem): Promise<FileDelta[]> {
    const paths = isStagedWrite(item)
      ? [stagedContentPath(item.id), stagedMetaPath(item.id)]
      : [stagedMetaPath(item.id)];
    return Promise.all(
      paths.map(async (path) => fileDelta(path, await this.files.read(path), null)),
    );
  }
}

export function stagedWriteDeltas(meta: StagedWriteMeta, content: string): FileDelta[] {
  const id = crypto.randomUUID();
  return [
    fileDelta(stagedContentPath(id), null, content),
    fileDelta(stagedMetaPath(id), null, serializeStagedMeta(meta)),
  ];
}

export function stagedReviewDeltas(reviews: readonly StagedReview[]): FileDelta[] {
  return reviews.map(({ id, ...meta }) =>
    fileDelta(stagedMetaPath(id), null, serializeStagedMeta(meta)),
  );
}

export function adoptionDeltas(adopted: readonly StagedReview[], legacy: LegacyInbox): FileDelta[] {
  return [...stagedReviewDeltas(adopted), fileDelta(legacyInboxPath, legacy.raw, null)];
}

export function admitReviews(
  candidates: readonly StagedReviewMeta[],
  staged: readonly StagedItem[],
): StagedReview[] {
  const known = new Set(staged.flatMap((item) => (isStagedWrite(item) ? [] : [item.key])));
  const admitted: StagedReview[] = [];
  for (const candidate of candidates) {
    if (known.has(candidate.key)) continue;
    known.add(candidate.key);
    admitted.push({ ...candidate, id: crypto.randomUUID() });
  }
  return admitted;
}

export function redactedReview(
  proposal: ReviewProposal,
  created: string,
  redact: (text: string) => string,
): StagedReviewMeta {
  const redacted = redactStringFields(proposal, redact);
  return { ...redacted, key: reviewKey(redacted), created };
}

export function reviewKey(proposal: ReviewProposal): string {
  switch (proposal.kind) {
    case "borderline-promotion":
      return `promotion:${titleKey(proposal.title)}`;
    case "contradiction":
      return `contradiction:${unorderedPairKey(proposal.a, proposal.b)}`;
    case "merge-proposal":
      return `merge:${unorderedPairKey(proposal.keep, proposal.retire)}`;
    case "supersession-proposal":
      return `supersession:${titleKey(proposal.loser)}->${titleKey(proposal.winner)}`;
    case "link-proposal":
      return `link:${titleKey(proposal.note)}->${titleKey(proposal.target)}`;
    case "arc-distillation":
      return `arc-distillation:${proposal.arc}:${titleKey(proposal.note)}`;
    case "arc-question":
      return `arc-question:${proposal.arc}:${titleKey(proposal.note)}`;
    case "preference-proposal":
      return `preference:${proposal.toolShape}`;
  }
}

export function isStagedWrite<T extends StagedMeta>(item: T): item is Extract<T, StagedWriteMeta> {
  return isStagedWriteKind(item.kind);
}

export function describeStaged(item: StagedItem): string {
  return isStagedWrite(item) ? `${item.kind} → ${item.target}` : item.key;
}

function byCreationThenSubject(a: StagedItem, b: StagedItem): number {
  return (
    a.created.localeCompare(b.created) ||
    describeStaged(a).localeCompare(describeStaged(b)) ||
    a.id.localeCompare(b.id)
  );
}

export function stagedSubjectPath(item: StagedItem): string {
  return isStagedWrite(item) ? item.target : stagedMetaPath(item.id);
}

export function stagedIdOfFile(name: string): string | undefined {
  if (!name.endsWith(".json")) return undefined;
  const id = name.slice(0, -".json".length);
  return isStagedId(id) ? id : undefined;
}

export function serializeStagedMeta(meta: StagedMeta): string {
  return `${JSON.stringify(meta)}\n`;
}

export function parseStagedMeta(raw: string, file: string): StagedMeta {
  const parsed = parseJsonObject(raw, file);
  return isStagedWriteKind(parsed.kind)
    ? parseWriteMeta(parsed, file)
    : parseReviewMeta(parsed, file);
}

export function parseLegacyInbox(raw: string, file: string): StagedReviewMeta[] {
  const parsed = parseJson(raw, file);
  if (!Array.isArray(parsed)) throw new MalformedStagedItemError(file, "not an array");
  return parsed.map((item, index) => {
    const label = `${file}[${index}]`;
    return parseReviewMeta(requireObject(item, label), label);
  });
}

const legacyInboxPath = `${stagingDir}/inbox.json`;
const stagedIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const writeKinds: readonly string[] = ["note", "daily", "moc"];
const reviewKinds: readonly string[] = reviewProposalSchema.options.map(
  (option) => option.shape.kind.value,
);

const writeMetaSchema = z.object({
  kind: z.enum(["note", "daily", "moc"]),
  target: z.string().refine(isVaultRelativePath, { error: "leaves the vault" }),
  created: z.string(),
  supersedes: z.string().optional(),
});

const reviewMetaSchema = z.intersection(
  reviewProposalSchema,
  z.object({ key: z.string(), created: z.string() }),
);

function isStagedId(id: string): boolean {
  return stagedIdPattern.test(id);
}

function stagedContentPath(id: string): string {
  return `${stagingDir}/${id}.md`;
}

function stagedMetaPath(id: string): string {
  return `${stagingDir}/${id}.json`;
}

function isStagedWriteKind(kind: unknown): kind is StagedWriteKind {
  return typeof kind === "string" && writeKinds.includes(kind);
}

function parseWriteMeta(value: Record<string, unknown>, file: string): StagedWriteMeta {
  const result = writeMetaSchema.safeParse(value);
  if (!result.success) throw new MalformedStagedItemError(file, describeIssues(result.error));
  const { kind, target, created, supersedes } = result.data;
  return { kind, target, created, ...(supersedes !== undefined && { supersedes }) };
}

function parseReviewMeta(value: Record<string, unknown>, file: string): StagedReviewMeta {
  if (typeof value.kind !== "string" || !reviewKinds.includes(value.kind))
    throw new MalformedStagedItemError(file, `unknown kind ${JSON.stringify(value.kind)}`);
  const result = reviewMetaSchema.safeParse(value);
  if (!result.success) throw new MalformedStagedItemError(file, describeIssues(result.error));
  return result.data;
}

function parseJsonObject(raw: string, file: string): Record<string, unknown> {
  return requireObject(parseJson(raw, file), file);
}

function parseJson(raw: string, file: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new MalformedStagedItemError(file, "not valid JSON");
  }
}

function requireObject(value: unknown, file: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new MalformedStagedItemError(file, "not an object");
  return value as Record<string, unknown>;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");
}

function redactStringFields<T extends object>(value: T, redact: (text: string) => string): T {
  const entries = Object.entries(value).map(([field, item]) => [
    field,
    typeof item === "string" ? redact(item) : item,
  ]);
  return Object.fromEntries(entries) as T;
}

function unorderedPairKey(a: string, b: string): string {
  return [titleKey(a), titleKey(b)].sort().join("<->");
}
