import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { type HeldFilePacingSync, renameOverSync, toError } from "@keywork/shared";
import { z } from "zod";
import { type KeptSettings, nothingKept, type SettingStorage } from "./kept.ts";
import { rungs, type Setting, settingKinds, settingOrigins, settingSizes } from "./setting.ts";

export type SettingDisk = Pick<
  typeof fs,
  | "readFileSync"
  | "readdirSync"
  | "mkdirSync"
  | "openSync"
  | "writeSync"
  | "fsyncSync"
  | "closeSync"
  | "renameSync"
  | "rmSync"
>;

export interface SettingFileOptions {
  file: string;
  notice(line: string): void;
  disk?: SettingDisk | undefined;
  pacing?: HeldFilePacingSync | undefined;
}

export function settingsFileIn(workspaceState: string): string {
  return join(workspaceState, "show", "settings.json");
}

export function settingFile(options: SettingFileOptions): SettingStorage {
  const { file, notice, pacing } = options;
  const disk = options.disk ?? fs;
  let lastSaveFailed = false;
  return {
    load: () => loadKept(file, disk, notice, pacing),
    save: (kept) => {
      try {
        writeAtomically(file, keptSettingsText(kept), disk, pacing);
        lastSaveFailed = false;
      } catch (cause) {
        if (!lastSaveFailed) notice(unsavedWords(file, cause));
        lastSaveFailed = true;
      }
    },
  };
}

export function keptSettingsText(kept: KeptSettings): string {
  return `${JSON.stringify({ version: keptVersion, ...kept }, null, 2)}\n`;
}

export function keptSettingsOf(text: string): KeptSettings {
  const parsed = keptFile.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(firstIssueOf(parsed.error));
  const { settings, spent } = parsed.data;
  return { settings: settings.map(keptSettingOf), spent };
}

const keptVersion = 1;

const keptUntil = z
  .string()
  .refine((until) => until === "seen" || until === "rests" || !Number.isNaN(Date.parse(until)), {
    message: "until is seen, rests or a time",
  });

const keptSetting = z.object({
  id: z.string().min(1),
  creature: z.string().nullable(),
  sessionId: z.string().min(1),
  what: z.object({
    kind: z.enum(settingKinds),
    ref: z.string(),
    title: z.string().optional(),
  }),
  rung: z.enum(rungs),
  why: z.string(),
  at: z.string(),
  until: keptUntil,
  state: z.enum(["live", "pinned"]),
  from: z.string().nullable(),
  origin: z.enum(settingOrigins),
  replaces: z.string().nullable(),
  size: z.enum(settingSizes).optional(),
});

const keptFile = z.object({
  version: z.literal(keptVersion),
  settings: z.array(keptSetting),
  spent: z.array(z.object({ owner: z.string().min(1), at: z.string() })),
});

function keptSettingOf(kept: z.infer<typeof keptSetting>): Setting {
  const { size, ...setting } = kept;
  const { kind, ref, title } = setting.what;
  return {
    ...setting,
    what: title === undefined ? { kind, ref } : { kind, ref, title },
    ...(size !== undefined && { size }),
  };
}

function firstIssueOf(error: z.ZodError): string {
  const [issue] = error.issues;
  if (issue === undefined) return "not kept settings";
  const at = issue.path.join(".");
  return `not kept settings: ${at === "" ? "" : `${at}: `}${issue.message}`;
}

function loadKept(
  file: string,
  disk: SettingDisk,
  notice: (line: string) => void,
  pacing: HeldFilePacingSync | undefined,
): KeptSettings {
  removeStaleStaging(file, disk);
  try {
    const text = readIfPresent(file, disk);
    return text === undefined ? nothingKept : keptSettingsOf(text);
  } catch (cause) {
    notice(unreadableWords(file, cause, setAside(file, disk, pacing)));
    return nothingKept;
  }
}

function readIfPresent(file: string, disk: SettingDisk): string | undefined {
  try {
    return disk.readFileSync(file, "utf8");
  } catch (cause) {
    if (isAbsent(cause)) return undefined;
    throw cause;
  }
}

function writeAtomically(
  file: string,
  text: string,
  disk: SettingDisk,
  pacing: HeldFilePacingSync | undefined,
): void {
  disk.mkdirSync(dirname(file), { recursive: true });
  const staging = `${file}.${process.pid}.${randomBytes(4).toString("hex")}${stagingSuffix}`;
  try {
    writeSynced(staging, text, disk);
    renameOverSync(staging, file, disk, pacing);
  } catch (cause) {
    removedQuietly(staging, disk);
    throw cause;
  }
}

function writeSynced(path: string, text: string, disk: SettingDisk): void {
  const descriptor = disk.openSync(path, "w", ownerOnly);
  try {
    disk.writeSync(descriptor, text);
    disk.fsyncSync(descriptor);
  } finally {
    disk.closeSync(descriptor);
  }
}

function removeStaleStaging(file: string, disk: SettingDisk): void {
  const dir = dirname(file);
  for (const name of namesIn(dir, disk).filter((name) => isStagingOf(file, name))) {
    removedQuietly(join(dir, name), disk);
  }
}

function isStagingOf(file: string, name: string): boolean {
  return name.startsWith(`${basename(file)}.`) && name.endsWith(stagingSuffix);
}

function namesIn(dir: string, disk: SettingDisk): string[] {
  try {
    return disk.readdirSync(dir);
  } catch {
    return [];
  }
}

function removedQuietly(path: string, disk: SettingDisk): boolean {
  try {
    disk.rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

type SetAside = { moved: true; to: string } | { moved: false; reason: string };

function setAside(
  file: string,
  disk: SettingDisk,
  pacing: HeldFilePacingSync | undefined,
): SetAside {
  const to = `${file}.unreadable`;
  try {
    renameOverSync(file, to, disk, pacing);
    return { moved: true, to };
  } catch (cause) {
    return { moved: false, reason: oneLine(toError(cause).message) };
  }
}

function unreadableWords(file: string, cause: unknown, aside: SetAside): string {
  const where = aside.moved
    ? `it was moved to ${aside.to}`
    : `it could not be moved aside (${aside.reason})`;
  return `the settings kept at ${file} are unreadable (${oneLine(toError(cause).message)}); the yard starts with none and ${where}`;
}

function unsavedWords(file: string, cause: unknown): string {
  return `settings could not be saved to ${file} (${oneLine(toError(cause).message)}); they stay in memory and the next change saves them again`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isAbsent(cause: unknown): boolean {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : "";
  return code === "ENOENT" || code === "ENOTDIR";
}

const stagingSuffix = ".tmp";

const ownerOnly = 0o600;
