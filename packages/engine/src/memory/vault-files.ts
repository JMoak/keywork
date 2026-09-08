import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

export const mocFile = "MEMORY.md";
export const auditFile = "curation.md";
export const stagingDir = ".staging";
export const dailyDir = "daily";
export const arcsDir = "arcs";
export const botsDir = "bots";

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

export class VaultFiles {
  private readonly root: string;
  private readonly reserved: ReadonlySet<string>;

  constructor(root: string, reservedPaths: readonly string[] = []) {
    this.root = resolve(root);
    this.reserved = new Set(reservedPaths);
  }

  isReserved(path: string): boolean {
    if (!isVaultRelativePath(path)) return false;
    if (this.reserved.has(path)) return true;
    for (const entry of this.reserved) {
      if (entry.endsWith("/") && path.startsWith(entry)) return true;
    }
    return false;
  }

  isReservedDir(dir: string): boolean {
    return this.reserved.has(`${dir}/`);
  }

  requireReserved(path: string): void {
    if (!this.isReserved(path)) throw new ReservedPathError(path, "not reserved by this vault");
  }

  requireReservedDir(dir: string): void {
    if (!this.isReservedDir(dir)) throw new ReservedPathError(dir, "not a reserved directory");
  }

  async read(path: string): Promise<string | null> {
    try {
      return await readFile(this.contained(path), "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  async write(path: string, content: string): Promise<void> {
    await writeFileAtomic(this.contained(path), content);
  }

  async remove(path: string): Promise<void> {
    await rm(this.contained(path), { force: true });
  }

  async fileNames(dir: string): Promise<string[]> {
    return (await this.entries(dir))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  }

  async dirNames(dir: string): Promise<string[]> {
    return (await this.entries(dir))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  async walkNotes(): Promise<string[]> {
    const paths: string[] = [];
    await this.walk("", paths);
    return paths.sort();
  }

  private async walk(dir: string, paths: string[]): Promise<void> {
    for (const entry of await this.entries(dir)) {
      const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (this.isStructuralDir(entry.name, rel)) continue;
        await this.walk(rel, paths);
        continue;
      }
      if (entry.name.endsWith(".md") && !this.isStructuralFile(rel)) paths.push(rel);
    }
  }

  private isStructuralDir(name: string, rel: string): boolean {
    return hiddenDirs.has(name) || layerDirs.has(rel) || this.reserved.has(`${rel}/`);
  }

  private isStructuralFile(rel: string): boolean {
    return rel === mocFile || rel === auditFile || this.reserved.has(rel);
  }

  private async entries(dir: string) {
    try {
      return await readdir(dir === "" ? this.root : this.contained(dir), { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
  }

  private contained(path: string): string {
    const abs = resolve(this.root, path);
    if (!abs.startsWith(`${this.root}${sep}`)) throw new PathOutsideVaultError(path);
    return abs;
  }
}

export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const scratch = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(scratch, content, "utf8");
    await rename(scratch, path);
  } catch (error) {
    await rm(scratch, { force: true });
    throw error;
  }
}

export function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code: unknown }).code === "ENOENT" ||
      (error as { code: unknown }).code === "ENOTDIR")
  );
}

export function isVaultRelativePath(path: string): boolean {
  if (path === "" || isAbsolute(path) || /^[A-Za-z]:/.test(path) || /^[\\/]/.test(path))
    return false;
  return path
    .split(/[\\/]/)
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const hiddenDirs = new Set([stagingDir, ".obsidian"]);
const layerDirs = new Set([dailyDir, arcsDir, botsDir]);
