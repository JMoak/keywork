import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ArtifactManifest, artifactManifestSchema } from "@keywork/campaigns";

export type ArtifactMetadata = {
  ownerScope: string;
  title: string;
  kind?: ArtifactManifest["kind"];
  parentIds?: string[];
  producerAttemptId?: string | null;
};

export type ArtifactCapture = ArtifactMetadata & { sourcePath: string; allowedRoot: string };
export type ArtifactWrite = ArtifactMetadata & { files: Readonly<Record<string, string>> };
export type ArtifactSnapshot = ArtifactMetadata & { path: string };
export type ArtifactLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  previewBytes: number;
};

export type ArtifactPreview = {
  artifactId: string;
  path: string | null;
  mimeType: string;
  content: string | null;
  truncated: boolean;
  totalBytes: number;
};

export class CampaignArtifacts {
  readonly root: string;
  readonly limits: ArtifactLimits;

  constructor(root: string, limits: Partial<ArtifactLimits> = {}) {
    this.root = resolve(root);
    this.limits = {
      maxFiles: 2_048,
      maxFileBytes: 8 * 1_024 * 1_024,
      maxTotalBytes: 32 * 1_024 * 1_024,
      previewBytes: 32 * 1_024,
      ...limits,
    };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`Invalid artifact limit: ${name}`);
    }
  }

  async capture(input: ArtifactCapture): Promise<ArtifactManifest> {
    const allowedRoot = await realpath(resolve(input.allowedRoot));
    const sourcePath = resolve(input.sourcePath);
    await assertSafePath(allowedRoot, sourcePath);
    const source = await lstat(sourcePath);
    if (!source.isDirectory() && !source.isFile())
      throw new Error("Only files and directories can be captured.");
    const files: CapturedFile[] = [];
    if (source.isFile()) {
      const path = safeArtifactPath(basename(sourcePath));
      if (excludedPath(path)) throw new Error("The source file is excluded from artifact capture.");
      files.push({
        path,
        content: await readSourceFile(allowedRoot, sourcePath, this.limits.maxFileBytes),
      });
    } else {
      await collectFiles(allowedRoot, sourcePath, "", files, this.limits);
    }
    return this.persist(files, {
      ...input,
      kind: input.kind ?? (source.isFile() ? "file" : "directory"),
    });
  }

  async write(input: ArtifactWrite): Promise<ArtifactManifest> {
    const files = Object.entries(input.files).map(([path, content]) => ({
      path: safeArtifactPath(path),
      content: Buffer.from(content, "utf8"),
    }));
    if (files.length === 0) throw new Error("An output must contain at least one file.");
    for (const file of files)
      if (excludedPath(file.path)) throw new Error("The output includes an excluded path.");
    return this.persist(files, input);
  }

  async materialize(
    manifest: ArtifactManifest,
    candidateId: string = randomUUID(),
  ): Promise<string> {
    safeIdentifier(candidateId);
    await this.initialize();
    const destination = join(this.root, "candidates", candidateId);
    await assertSafePath(this.root, dirname(destination));
    await mkdir(destination);
    await this.copyVerified(manifest, destination);
    return destination;
  }

  async snapshot(input: ArtifactSnapshot): Promise<ArtifactManifest> {
    const candidates = join(this.root, "candidates");
    await this.initialize();
    const candidatePath = resolve(input.path);
    assertInside(candidates, candidatePath, false);
    return this.capture({ ...input, sourcePath: candidatePath, allowedRoot: candidates });
  }

  async preview(manifest: ArtifactManifest, path?: string): Promise<ArtifactPreview> {
    const stored = await this.storedManifest(manifest);
    const selected =
      path === undefined
        ? preferredEntry(stored)
        : stored.entries.find((entry) => entry.path === safeArtifactPath(path));
    if (!selected) {
      if (path !== undefined) throw new Error("The requested artifact path does not exist.");
      return {
        artifactId: stored.id,
        path: null,
        mimeType: "application/x-directory",
        content: null,
        truncated: false,
        totalBytes: 0,
      };
    }
    const bytes = await this.verifiedFile(stored, selected.path);
    const text = decodeText(bytes);
    return {
      artifactId: stored.id,
      path: selected.path,
      mimeType: selected.mediaType,
      content: text === null ? null : utf8Prefix(bytes, this.limits.previewBytes),
      truncated: text !== null && bytes.byteLength > this.limits.previewBytes,
      totalBytes: bytes.byteLength,
    };
  }

  async readText(manifest: ArtifactManifest, path: string, maxBytes: number): Promise<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > this.limits.maxFileBytes)
      throw new Error("Invalid text read limit.");
    const stored = await this.storedManifest(manifest);
    const bytes = await this.verifiedFile(stored, safeArtifactPath(path));
    if (bytes.byteLength > maxBytes)
      throw new Error("The complete artifact text exceeds the requested read limit.");
    const text = decodeText(bytes);
    if (text === null) throw new Error("The artifact file is not UTF-8 text.");
    return text;
  }

  async export(manifest: ArtifactManifest, destination: string): Promise<string> {
    const target = resolve(destination);
    if (inside(this.root, target))
      throw new Error("Export requires a destination outside managed artifact storage.");
    const parent = await realpath(dirname(target));
    const actualTarget = join(parent, basename(target));
    await mkdir(actualTarget);
    await this.copyVerified(manifest, actualTarget);
    return actualTarget;
  }

  async contentDirectory(manifest: ArtifactManifest): Promise<string> {
    const stored = await this.storedManifest(manifest);
    const directory = join(this.root, stored.storageRef, "files");
    await assertSafePath(this.root, directory);
    return directory;
  }

  private async persist(
    files: CapturedFile[],
    metadata: ArtifactMetadata,
  ): Promise<ArtifactManifest> {
    validateFiles(files, this.limits);
    await this.initialize();
    const stagingRoot = join(this.root, "staging");
    const staging = await mkdtemp(join(stagingRoot, "capture-"));
    try {
      const id = `artifact-${randomUUID()}`;
      const ordered = [...files].sort((left, right) => left.path.localeCompare(right.path, "en"));
      const entries = ordered.map((file) => ({
        path: file.path,
        digest: digest(file.content),
        sizeBytes: file.content.byteLength,
        mediaType: mediaType(file.path),
      }));
      const manifest = artifactManifestSchema.parse({
        schemaVersion: 1,
        id,
        title: metadata.title,
        ownerScope: metadata.ownerScope,
        kind: metadata.kind ?? "report",
        digest: digest(Buffer.from(JSON.stringify(entries), "utf8")),
        parentIds: metadata.parentIds ?? [],
        storageRef: `objects/${id}`,
        producerAttemptId: metadata.producerAttemptId ?? null,
        createdAt: Date.now(),
        entries,
        capabilities: ["inspect", "export", "diff", "preview"],
      });
      const filesRoot = join(staging, "files");
      await mkdir(filesRoot);
      for (const file of ordered) {
        const target = resolveArtifactPath(filesRoot, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content, { flag: "wx" });
      }
      await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest), { flag: "wx" });
      await rename(staging, join(this.root, manifest.storageRef));
      return manifest;
    } catch (error) {
      assertInside(stagingRoot, staging, false);
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const rootStat = await lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new Error("Artifact root must be a real directory.");
    for (const name of ["objects", "staging", "candidates"]) {
      const path = join(this.root, name);
      await mkdir(path, { recursive: true });
      await assertSafePath(this.root, path);
    }
  }

  private async storedManifest(manifest: ArtifactManifest): Promise<ArtifactManifest> {
    const expected = artifactManifestSchema.parse(manifest);
    safeIdentifier(expected.id);
    if (expected.storageRef !== `objects/${expected.id}`)
      throw new Error("Invalid artifact storage reference.");
    await this.initialize();
    const path = join(this.root, expected.storageRef, "manifest.json");
    await assertSafePath(this.root, path);
    const stored = artifactManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (JSON.stringify(stored) !== JSON.stringify(expected))
      throw new Error("Artifact manifest differs from the immutable record.");
    if (digest(Buffer.from(JSON.stringify(stored.entries), "utf8")) !== stored.digest)
      throw new Error("Artifact manifest digest mismatch.");
    validateEntries(stored, this.limits);
    return stored;
  }

  private async verifiedFile(manifest: ArtifactManifest, path: string): Promise<Buffer> {
    const entry = manifest.entries.find((item) => item.path === path);
    if (!entry) throw new Error("The requested artifact path does not exist.");
    const file = resolveArtifactPath(join(this.root, manifest.storageRef, "files"), path);
    const bytes = await readSourceFile(this.root, file, this.limits.maxFileBytes);
    if (bytes.byteLength !== entry.sizeBytes || digest(bytes) !== entry.digest)
      throw new Error("Artifact content digest mismatch.");
    return bytes;
  }

  private async copyVerified(manifest: ArtifactManifest, destination: string): Promise<void> {
    const stored = await this.storedManifest(manifest);
    for (const entry of stored.entries) {
      const bytes = await this.verifiedFile(stored, entry.path);
      const target = resolveArtifactPath(destination, entry.path);
      await mkdir(dirname(target), { recursive: true });
      await assertSafePath(destination, dirname(target));
      await writeFile(target, bytes, { flag: "wx" });
    }
  }
}

type CapturedFile = { path: string; content: Buffer };

async function collectFiles(
  root: string,
  directory: string,
  prefix: string,
  files: CapturedFile[],
  limits: ArtifactLimits,
  scan = { entries: 0 },
): Promise<void> {
  if (prefix.split("/").length > 64) throw new Error("Artifact exceeds the directory depth limit.");
  await assertSafePath(root, directory);
  for await (const entry of await opendir(directory)) {
    scan.entries += 1;
    if (scan.entries > limits.maxFiles * 8)
      throw new Error("Artifact exceeds the scan-entry limit.");
    const name = entry.name;
    const path = safeArtifactPath(prefix + name);
    if (excludedPath(path)) continue;
    const source = join(directory, name);
    await assertSafePath(root, source);
    const stat = await lstat(source);
    if (stat.isDirectory()) {
      await collectFiles(root, source, `${path}/`, files, limits, scan);
    } else if (stat.isFile()) {
      files.push({ path, content: await readSourceFile(root, source, limits.maxFileBytes) });
      validateFiles(files, limits);
    } else throw new Error("Unsupported artifact source file.");
  }
}

async function readSourceFile(root: string, path: string, maxBytes: number): Promise<Buffer> {
  await assertSafePath(root, path);
  const expected = await lstat(path);
  if (!expected.isFile() || expected.size > maxBytes)
    throw new Error("Artifact file is unsupported or exceeds the byte limit.");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.size > maxBytes
    )
      throw new Error("The artifact source changed during capture.");
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const result = await file.read(buffer, length, buffer.byteLength - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await file.stat();
    await assertSafePath(root, path);
    const current = await lstat(path);
    if (
      bytes.byteLength > maxBytes ||
      bytes.byteLength !== opened.size ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ino !== current.ino ||
      opened.dev !== current.dev
    )
      throw new Error("The artifact source changed during capture.");
    return bytes;
  } finally {
    await file.close();
  }
}

async function assertSafePath(root: string, path: string): Promise<void> {
  const rootPath = resolve(root);
  const target = resolve(path);
  assertInside(rootPath, target, true);
  const segments = relative(rootPath, target).split(sep).filter(Boolean);
  let current = rootPath;
  const rootStat = await lstat(rootPath);
  if (rootStat.isSymbolicLink())
    throw new Error("Symbolic links are not allowed in artifact paths.");
  for (const segment of segments) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Symbolic links are not allowed in artifact paths.");
  }
  const realRoot = await realpath(rootPath);
  assertInside(realRoot, await realpath(target), true);
}

function safeArtifactPath(path: string): string {
  if (
    !path ||
    path.includes("\\") ||
    isAbsolute(path) ||
    /[<>:"|?*]/.test(path) ||
    Array.from(path).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Invalid artifact relative path.");
  const segments = path.split("/");
  for (const segment of segments) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      /[. ]$/.test(segment) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
    )
      throw new Error("Invalid artifact path segment.");
  }
  return path;
}

function resolveArtifactPath(root: string, path: string): string {
  const target = resolve(root, ...safeArtifactPath(path).split("/"));
  assertInside(root, target, false);
  return target;
}

function safeIdentifier(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error("Invalid managed artifact identifier.");
}

function excludedPath(path: string): boolean {
  return path.split("/").some((part) => {
    const name = part.toLowerCase();
    return (
      [
        ".git",
        "node_modules",
        ".aws",
        ".ssh",
        ".azure",
        ".gnupg",
        ".npmrc",
        ".pypirc",
        ".git-credentials",
        "id_rsa",
        "id_ed25519",
      ].includes(name) ||
      name === ".env" ||
      name.startsWith(".env.") ||
      /\.(pem|key|p12|pfx)$/i.test(name)
    );
  });
}

function validateFiles(files: CapturedFile[], limits: ArtifactLimits): void {
  if (files.length > limits.maxFiles) throw new Error("Artifact exceeds the file-count limit.");
  const paths = new Set<string>();
  let total = 0;
  for (const file of files) {
    safeArtifactPath(file.path);
    const key = file.path.toLowerCase();
    if (paths.has(key)) throw new Error("Artifact paths collide across supported platforms.");
    paths.add(key);
    total += file.content.byteLength;
    if (file.content.byteLength > limits.maxFileBytes || total > limits.maxTotalBytes)
      throw new Error("Artifact exceeds the byte limit.");
  }
}

function validateEntries(manifest: ArtifactManifest, limits: ArtifactLimits): void {
  if (manifest.entries.length > limits.maxFiles)
    throw new Error("Artifact exceeds the file-count limit.");
  const paths = new Set<string>();
  let total = 0;
  for (const entry of manifest.entries) {
    safeArtifactPath(entry.path);
    if (excludedPath(entry.path)) throw new Error("Artifact contains an excluded path.");
    const key = entry.path.toLowerCase();
    if (paths.has(key)) throw new Error("Artifact paths collide.");
    paths.add(key);
    total += entry.sizeBytes;
    if (entry.sizeBytes > limits.maxFileBytes || total > limits.maxTotalBytes)
      throw new Error("Artifact exceeds the byte limit.");
  }
}

function assertInside(root: string, path: string, allowRoot: boolean): void {
  if ((!allowRoot && resolve(root) === resolve(path)) || !inside(root, path))
    throw new Error("Artifact path escapes its allowed root.");
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function preferredEntry(
  manifest: ArtifactManifest,
): ArtifactManifest["entries"][number] | undefined {
  return (
    manifest.entries.find((entry) =>
      /^(report|readme|index)\.(md|txt|html)$/i.test(basename(entry.path)),
    ) ??
    manifest.entries.find((entry) => entry.mediaType.startsWith("text/")) ??
    manifest.entries[0]
  );
}

function mediaType(path: string): string {
  const extension = extname(path).toLowerCase();
  const types: Record<string, string> = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".jsx": "text/javascript",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".json": "application/json",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".pdf": "application/pdf",
  };
  return types[extension] ?? "application/octet-stream";
}

function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function utf8Prefix(bytes: Buffer, maxBytes: number): string {
  const limit = Math.min(bytes.byteLength, maxBytes);
  for (let end = limit; end >= Math.max(0, limit - 3); end -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    } catch {}
  }
  return "";
}
