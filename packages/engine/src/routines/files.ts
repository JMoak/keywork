import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isMissingFileError, writeFileAtomic } from "../memory/vault-files.ts";
import { parseRoutine, type Routine, type RoutineParse, routineIdPattern } from "./routine.ts";

export const routinesDirName = "routines";

export interface RoutineFile {
  id: string;
  file: string;
  parse: RoutineParse;
}

export function routineFilePath(creatureDir: string, id: string): string {
  return join(creatureDir, routinesDirName, `${id}.json`);
}

export async function readRoutineFiles(creatureDir: string): Promise<RoutineFile[]> {
  const ids = (await routineFileNames(creatureDir))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => routineIdPattern.test(id))
    .sort();
  const files = await Promise.all(ids.map((id) => readRoutineFile(creatureDir, id)));
  return files.filter((file) => file !== undefined);
}

export async function readRoutineFile(
  creatureDir: string,
  id: string,
): Promise<RoutineFile | undefined> {
  const file = routineFilePath(creatureDir, id);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
  return { id, file, parse: parseNamed(id, raw) };
}

export async function writeRoutineFile(creatureDir: string, routine: Routine): Promise<string> {
  const file = routineFilePath(creatureDir, routine.id);
  await writeFileAtomic(file, `${JSON.stringify(routine, null, 2)}\n`);
  return file;
}

export async function removeRoutineFile(creatureDir: string, id: string): Promise<void> {
  await rm(routineFilePath(creatureDir, id), { force: true });
}

async function routineFileNames(creatureDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(creatureDir, routinesDirName), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((e) => e.name);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

function parseNamed(id: string, raw: string): RoutineParse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { problem: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = parseRoutine(value);
  if ("routine" in parsed && parsed.routine.id !== id) {
    return { problem: `the file is ${id}.json but its id is "${parsed.routine.id}"` };
  }
  return parsed;
}
