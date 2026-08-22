import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalPath } from "./canonical-path.ts";

export type Disk = Pick<
  typeof import("node:fs"),
  "mkdirSync" | "readFileSync" | "writeFileSync" | "chmodSync" | "renameSync" | "rmSync"
>;

export type JsonFileStoreOptions<T> = {
  file: string;
  validate: (data: unknown) => T;
  private?: boolean;
  disk?: Disk | undefined;
} & ({ mode: "strict"; error: (file: string, detail: string) => Error } | { mode: "lenient" });

export interface JsonFileStore<T> {
  readonly file: string;
  read(): T | undefined;
  write(value: T): void;
}

export function jsonFileStore<T>(options: JsonFileStoreOptions<T>): JsonFileStore<T> {
  const disk = options.disk ?? realDisk;
  return {
    file: options.file,
    read: () => read(options, disk),
    write: (value) => writeAtomically(options, disk, value),
  };
}

export interface PathKeyedStringStore {
  get(path: string): string | undefined;
  set(path: string, value: string): void;
}

export function pathKeyedStringStore(
  file: string,
  platform?: NodeJS.Platform,
): PathKeyedStringStore {
  const store = jsonFileStore<Record<string, string>>({
    file,
    mode: "lenient",
    private: true,
    validate: onlyStringEntries,
  });
  return {
    get: (path) => store.read()?.[canonicalPath(path, platform)],
    set: (path, value) => {
      const entries = store.read() ?? {};
      entries[canonicalPath(path, platform)] = value;
      store.write(entries);
    },
  };
}

const realDisk: Disk = { mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, rmSync };

const absenceCodes = new Set(["ENOENT", "ENOTDIR"]);

function read<T>(options: JsonFileStoreOptions<T>, disk: Disk): T | undefined {
  let raw: string;
  try {
    raw = disk.readFileSync(options.file, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code ?? "unknown";
    if (absenceCodes.has(code) || options.mode === "lenient") return undefined;
    throw options.error(options.file, `unreadable (${code})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (cause) {
    if (options.mode === "lenient") return undefined;
    throw options.error(options.file, `not valid JSON: ${(cause as Error).message}`);
  }
  return options.validate(data);
}

function writeAtomically<T>(options: JsonFileStoreOptions<T>, disk: Disk, value: T): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const isPrivate = options.private === true;
  disk.mkdirSync(dirname(options.file), { recursive: true, ...(isPrivate && { mode: 0o700 }) });
  const staging = `${options.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    disk.writeFileSync(staging, serialized, {
      encoding: "utf8",
      ...(isPrivate && { mode: 0o600 }),
    });
    if (isPrivate) disk.chmodSync(staging, 0o600);
    disk.renameSync(staging, options.file);
  } catch (cause) {
    disk.rmSync(staging, { force: true });
    throw cause;
  }
}

function onlyStringEntries(data: unknown): Record<string, string> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") entries[key] = value;
  }
  return entries;
}
