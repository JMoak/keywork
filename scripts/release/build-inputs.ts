import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isReleaseVersion, tagMatchesVersion } from "./targets.ts";

export interface BuildVersionRequest {
  readonly manifest: unknown;
  readonly manifestPath: string;
  readonly override?: string | undefined;
  readonly expectTag?: string | undefined;
}

export class BuildInputError extends Error {
  override readonly name = "BuildInputError";
}

export function resolveBuildVersion(request: BuildVersionRequest): string {
  const { candidate, source } = versionCandidate(request);
  if (candidate === undefined) {
    throw new BuildInputError(
      `${request.manifestPath} has no "version" field; add one before building`,
    );
  }
  if (typeof candidate !== "string" || !isReleaseVersion(candidate)) {
    throw new BuildInputError(
      `${source} version ${JSON.stringify(candidate)} is not a release version (MAJOR.MINOR.PATCH with an optional -prerelease)`,
    );
  }
  if (request.expectTag !== undefined && !tagMatchesVersion(request.expectTag, candidate)) {
    throw new BuildInputError(
      `release tag ${request.expectTag} does not match ${source} version ${candidate}; bump the manifest or retag`,
    );
  }
  return candidate;
}

export function outdirInside(parent: string, requested: string, cwd = process.cwd()): string {
  const outdir = resolve(cwd, requested);
  const descent = relative(resolve(cwd, parent), outdir);
  if (descent === "" || descent === ".." || descent.startsWith(`..${sep}`) || isAbsolute(descent)) {
    throw new BuildInputError(
      `--outdir must be a directory inside ${parent}/ (got ${requested}); it is wiped before the build`,
    );
  }
  return outdir;
}

export function readManifest(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function exitOnBuildInputError<T>(compute: () => T): T {
  try {
    return compute();
  } catch (error) {
    if (!(error instanceof BuildInputError)) throw error;
    console.error(`${error.name}: ${error.message}`);
    process.exit(2);
  }
}

function versionCandidate(request: BuildVersionRequest): {
  candidate: unknown;
  source: string;
} {
  if (request.override !== undefined) return { candidate: request.override, source: "--version" };
  return { candidate: manifestVersion(request.manifest), source: request.manifestPath };
}

function manifestVersion(manifest: unknown): unknown {
  if (typeof manifest !== "object" || manifest === null) return undefined;
  return (manifest as Record<string, unknown>).version;
}
