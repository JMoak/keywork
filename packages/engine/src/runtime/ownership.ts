import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqlite } from "../routines/sqlite.ts";

export interface RuntimeOwnership {
  readonly file: string;
  release(): void;
}

export async function acquireRuntimeOwnership(file: string): Promise<RuntimeOwnership | undefined> {
  mkdirSync(dirname(file), { recursive: true });
  const database = await openSqlite(file);
  try {
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN EXCLUSIVE");
  } catch (cause) {
    database.close();
    if (sqliteBusy(cause)) return undefined;
    throw cause;
  }
  let released = false;
  return {
    file,
    release: () => {
      if (released) return;
      released = true;
      database.close();
    },
  };
}

function sqliteBusy(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const failure = cause as { code?: unknown; errcode?: unknown; errno?: unknown };
  return failure.code === "SQLITE_BUSY" || failure.errcode === 5 || failure.errno === 5;
}
