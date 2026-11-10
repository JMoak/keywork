import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { artifactManifestSchema, campaignIdSchema } from "@keywork/campaigns";
import { z } from "zod";
import type { CampaignArtifacts } from "./artifacts.ts";

export const campaignSourceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: campaignIdSchema,
  ownerScope: campaignIdSchema,
  title: z.string().trim().min(1).max(512),
  reference: z.string().trim().min(1).max(4_096),
  artifact: artifactManifestSchema,
  contentDigest: z.string().min(1).max(256),
  createdAt: z.number().int().nonnegative(),
});

export type CampaignSource = z.infer<typeof campaignSourceSchema>;
export type SourceIdentity = Pick<CampaignSource, "id" | "ownerScope" | "reference">;
export type SourceAuthorization = (
  ownerScope: string,
  source: SourceIdentity,
) => boolean | Promise<boolean>;
export type SourceRegistration = {
  ownerScope: string;
  title: string;
  reference: string;
  text: string;
};
export type SourceExcerptRequest = {
  ownerScope: string;
  sourceId: string;
  startLine: number;
  endLine: number;
  maxBytes?: number;
};
export type SourceExcerpt = {
  sourceId: string;
  artifactId: string;
  reference: string;
  sourceDigest: string;
  excerptDigest: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  text: string;
};
export type SourceSearch = {
  sourceId: string;
  title: string;
  reference: string;
  line: number;
  preview: string;
};
export type SourceSearchResult = { hits: SourceSearch[]; scanned: number; truncated: boolean };

export class CampaignSources {
  readonly root: string;
  private readonly artifacts: CampaignArtifacts;
  private readonly authorize: SourceAuthorization;

  constructor(root: string, artifacts: CampaignArtifacts, authorize: SourceAuthorization) {
    this.root = resolve(root);
    this.artifacts = artifacts;
    this.authorize = authorize;
  }

  async register(input: SourceRegistration): Promise<CampaignSource> {
    const identity = {
      id: `source-${randomUUID()}`,
      ownerScope: input.ownerScope,
      reference: input.reference,
    };
    await this.checkAccess(input.ownerScope, identity);
    const artifact = await this.artifacts.write({
      ownerScope: input.ownerScope,
      title: input.title,
      kind: "file",
      files: { "source.txt": input.text },
      parentIds: [],
      producerAttemptId: null,
    });
    const entry = artifact.entries[0];
    if (!entry) throw new Error("Source snapshot contains no text.");
    const source = campaignSourceSchema.parse({
      schemaVersion: 1,
      ...identity,
      title: input.title,
      artifact,
      contentDigest: entry.digest,
      createdAt: artifact.createdAt,
    });
    await this.initialize();
    await writeFile(this.sourcePath(source.id), JSON.stringify(source), { flag: "wx" });
    return source;
  }

  async get(ownerScope: string, sourceId: string): Promise<CampaignSource> {
    const source = await this.load(sourceId);
    await this.checkAccess(ownerScope, source);
    return source;
  }

  async excerpt(request: SourceExcerptRequest): Promise<SourceExcerpt> {
    const source = await this.get(request.ownerScope, request.sourceId);
    const text = await this.sourceText(source);
    const starts = lineStarts(text);
    if (
      !Number.isSafeInteger(request.startLine) ||
      !Number.isSafeInteger(request.endLine) ||
      request.startLine < 1 ||
      request.endLine < request.startLine ||
      request.endLine > starts.length
    )
      throw new Error("Invalid source line range.");
    const startOffset = starts[request.startLine - 1];
    if (startOffset === undefined) throw new Error("Source line does not exist.");
    const endOffset = starts[request.endLine] ?? text.length;
    const excerpt = text.slice(startOffset, endOffset);
    const maxBytes = request.maxBytes ?? 16 * 1_024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1_024 * 1_024)
      throw new Error("Invalid source excerpt limit.");
    if (Buffer.byteLength(excerpt, "utf8") > maxBytes)
      throw new Error("The exact excerpt exceeds the requested byte limit.");
    return {
      sourceId: source.id,
      artifactId: source.artifact.id,
      reference: source.reference,
      sourceDigest: source.contentDigest,
      excerptDigest: hash(excerpt),
      startLine: request.startLine,
      endLine: request.endLine,
      startOffset,
      endOffset,
      text: excerpt,
    };
  }

  async search(input: {
    ownerScope: string;
    query: string;
    sourceIds?: readonly string[];
    limit?: number;
  }): Promise<SourceSearchResult> {
    const query = input.query.trim();
    const limit = input.limit ?? 10;
    if (!query || query.length > 512 || !Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new Error("Invalid source search request.");
    if (input.sourceIds !== undefined) {
      if (input.sourceIds.length > 256) throw new Error("Invalid source search scope.");
      for (const sourceId of input.sourceIds) this.sourcePath(sourceId);
    }
    const sourceIds =
      input.sourceIds === undefined ? this.registeredIds() : new Set(input.sourceIds);
    const hits: SourceSearch[] = [];
    let scanned = 0;
    for await (const sourceId of sourceIds) {
      if (scanned >= 1_000 || hits.length >= limit) return { hits, scanned, truncated: true };
      scanned += 1;
      const source = await this.load(sourceId);
      if (
        source.ownerScope !== input.ownerScope ||
        !(await this.authorize(input.ownerScope, source))
      )
        continue;
      const text = await this.sourceText(source);
      const lines = text.split("\n");
      const line = lines.findIndex((value) => value.toLowerCase().includes(query.toLowerCase()));
      if (line < 0) continue;
      hits.push({
        sourceId: source.id,
        title: source.title,
        reference: source.reference,
        line: line + 1,
        preview: lines[line]?.slice(0, 512) ?? "",
      });
    }
    return { hits, scanned, truncated: false };
  }

  private async *registeredIds(): AsyncGenerator<string> {
    await this.initialize();
    for await (const entry of await opendir(this.root)) {
      if (entry.name.endsWith(".json")) yield entry.name.slice(0, -5);
    }
  }

  private async load(sourceId: string): Promise<CampaignSource> {
    await this.initialize();
    const path = this.sourcePath(sourceId);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1_024)
      throw new Error("Invalid source record.");
    const source = campaignSourceSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (source.id !== sourceId || source.artifact.ownerScope !== source.ownerScope)
      throw new Error("Source identity mismatch.");
    return source;
  }

  private async sourceText(source: CampaignSource): Promise<string> {
    const text = await this.artifacts.readText(
      source.artifact,
      "source.txt",
      this.artifacts.limits.maxFileBytes,
    );
    if (hash(text) !== source.contentDigest) throw new Error("Source content digest mismatch.");
    return text;
  }

  private async checkAccess(ownerScope: string, source: SourceIdentity): Promise<void> {
    if (source.ownerScope !== ownerScope || !(await this.authorize(ownerScope, source)))
      throw new Error("Source access denied.");
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink())
      throw new Error("Source registry cannot be a symbolic link.");
  }

  private sourcePath(sourceId: string): string {
    if (!/^source-[a-zA-Z0-9-]{1,100}$/.test(sourceId))
      throw new Error("Invalid source identifier.");
    return join(this.root, `${sourceId}.json`);
  }
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (
    let index = text.indexOf("\n");
    index >= 0 && index + 1 < text.length;
    index = text.indexOf("\n", index + 1)
  )
    starts.push(index + 1);
  return starts;
}

function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
