import { access, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isMissingFileError } from "../memory/vault-files.ts";
import { removeSessionFiles, spillDirFor } from "./spill.ts";

export const trashDirName = ".trash";

export class SessionFileCollisionError extends Error {
  constructor(readonly file: string) {
    super(`${file} already exists, so the session was left where it is`);
    this.name = "SessionFileCollisionError";
  }
}

export class SessionTrash {
  readonly dir: string;

  constructor(readonly sessionDir: string) {
    this.dir = join(sessionDir, trashDirName);
  }

  async put(sessionFile: string): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    return moveSessionPair(sessionFile, join(this.dir, basename(sessionFile)));
  }

  restore(trashedFile: string): Promise<string> {
    return moveSessionPair(trashedFile, join(this.sessionDir, basename(trashedFile)));
  }

  async files(): Promise<string[]> {
    try {
      const names = await readdir(this.dir);
      return names
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .map((name) => join(this.dir, name));
    } catch (cause) {
      if (isMissingFileError(cause)) return [];
      throw cause;
    }
  }

  async purge(): Promise<number> {
    const files = await this.files();
    await rm(this.dir, { recursive: true, force: true });
    return files.length;
  }

  discard(trashedFile: string): Promise<void> {
    return removeSessionFiles(trashedFile);
  }
}

export function sessionFilePair(sessionFile: string): { log: string; spills: string } {
  return { log: sessionFile, spills: spillDirFor(sessionFile) };
}

async function moveSessionPair(from: string, to: string): Promise<string> {
  const source = sessionFilePair(from);
  const target = sessionFilePair(to);
  if (await exists(target.log)) throw new SessionFileCollisionError(target.log);
  if (await exists(target.spills)) throw new SessionFileCollisionError(target.spills);
  await mkdir(dirname(to), { recursive: true });
  await rename(source.log, target.log);
  if (await exists(source.spills)) await rename(source.spills, target.spills);
  return to;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (cause) {
    if (isMissingFileError(cause)) return false;
    throw cause;
  }
}
