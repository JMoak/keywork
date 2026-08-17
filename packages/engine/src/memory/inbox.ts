import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { titleKey } from "./naming.ts";
import type { Provenance } from "./store.ts";

export type ReviewItemDetail =
  | {
      kind: "borderline-promotion";
      title: string;
      body: string;
      confidence: number;
      source: string;
    }
  | {
      kind: "contradiction";
      a: string;
      b: string;
      aProvenance: Provenance;
      bProvenance: Provenance;
      confidence: number;
    }
  | { kind: "merge-proposal"; keep: string; retire: string; confidence: number }
  | { kind: "supersession-proposal"; winner: string; loser: string; confidence: number }
  | { kind: "link-proposal"; note: string; target: string; mention: string }
  | { kind: "arc-distillation"; arc: string; note: string; eligible: boolean }
  | { kind: "arc-question"; arc: string; note: string }
  | { kind: "preference-proposal"; toolShape: string; approvals: number };

export type ReviewItem = ReviewItemDetail & { id: string; key: string; created: string };

export interface ReviewInboxOptions {
  filePath?: string;
  now?: () => Date;
}

export class ReviewItemNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`no review item with id ${id}`);
    this.name = "ReviewItemNotFoundError";
  }
}

export class MalformedInboxError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`malformed review inbox ${file}: ${detail}`);
    this.name = "MalformedInboxError";
  }
}

export function reviewKey(detail: ReviewItemDetail): string {
  switch (detail.kind) {
    case "borderline-promotion":
      return `promotion:${titleKey(detail.title)}`;
    case "contradiction":
      return `contradiction:${unorderedPairKey(detail.a, detail.b)}`;
    case "merge-proposal":
      return `merge:${unorderedPairKey(detail.keep, detail.retire)}`;
    case "supersession-proposal":
      return `supersession:${titleKey(detail.loser)}->${titleKey(detail.winner)}`;
    case "link-proposal":
      return `link:${titleKey(detail.note)}->${titleKey(detail.target)}`;
    case "arc-distillation":
      return `arc-distillation:${detail.arc}:${titleKey(detail.note)}`;
    case "arc-question":
      return `arc-question:${detail.arc}:${titleKey(detail.note)}`;
    case "preference-proposal":
      return `preference:${detail.toolShape}`;
  }
}

export class ReviewInbox {
  private readonly filePath: string | undefined;
  private readonly now: () => Date;
  private items: ReviewItem[] | undefined;

  constructor(options: ReviewInboxOptions = {}) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => new Date());
  }

  async list(): Promise<ReviewItem[]> {
    return [...(await this.load())];
  }

  async add(details: ReviewItemDetail[]): Promise<ReviewItem[]> {
    const items = await this.load();
    const knownKeys = new Set(items.map((item) => item.key));
    const added: ReviewItem[] = [];
    for (const detail of details) {
      const key = reviewKey(detail);
      if (knownKeys.has(key)) continue;
      knownKeys.add(key);
      const item: ReviewItem = {
        ...detail,
        id: crypto.randomUUID(),
        key,
        created: this.now().toISOString(),
      };
      items.push(item);
      added.push(item);
    }
    if (added.length > 0) await this.save(items);
    return added;
  }

  async resolve(id: string): Promise<ReviewItem> {
    const items = await this.load();
    const index = items.findIndex((item) => item.id === id);
    const item = items[index];
    if (item === undefined) throw new ReviewItemNotFoundError(id);
    items.splice(index, 1);
    await this.save(items);
    return item;
  }

  private async load(): Promise<ReviewItem[]> {
    if (this.items !== undefined) return this.items;
    this.items = this.filePath === undefined ? [] : await readInboxFile(this.filePath);
    return this.items;
  }

  private async save(items: ReviewItem[]): Promise<void> {
    if (this.filePath === undefined) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  }
}

const reviewKinds = new Set([
  "borderline-promotion",
  "contradiction",
  "merge-proposal",
  "supersession-proposal",
  "link-proposal",
  "arc-distillation",
  "arc-question",
  "preference-proposal",
]);

async function readInboxFile(filePath: string): Promise<ReviewItem[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MalformedInboxError(filePath, "not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new MalformedInboxError(filePath, "not an array");
  return parsed.map((value) => validateItem(value, filePath));
}

function validateItem(value: unknown, file: string): ReviewItem {
  if (value === null || typeof value !== "object")
    throw new MalformedInboxError(file, "item is not an object");
  const item = value as Record<string, unknown>;
  for (const field of ["id", "key", "created", "kind"]) {
    if (typeof item[field] !== "string")
      throw new MalformedInboxError(file, `item missing string field ${field}`);
  }
  if (!reviewKinds.has(item.kind as string))
    throw new MalformedInboxError(file, `unknown kind ${JSON.stringify(item.kind)}`);
  return value as ReviewItem;
}

function unorderedPairKey(a: string, b: string): string {
  return [titleKey(a), titleKey(b)].sort().join("<->");
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
