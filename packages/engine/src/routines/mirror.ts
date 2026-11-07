import { readRoutineFile, readRoutineFiles } from "./files.ts";
import type { Routine } from "./routine.ts";
import type { CreatureHome } from "./runner.ts";
import type { IndexedRoutine, RoutineStore } from "./store.ts";

export interface CreatureDirectory {
  creatures(): Promise<readonly CreatureHome[]>;
  creature(slug: string): Promise<CreatureHome | undefined>;
}

export async function mirrorCreature(
  store: RoutineStore,
  home: CreatureHome,
  now: number,
): Promise<IndexedRoutine[]> {
  const files = await readRoutineFiles(home.dir);
  const present = new Set(files.map((file) => file.id));
  for (const stale of store.routines(home.slug).filter((row) => !present.has(row.id))) {
    store.forget(home.slug, stale.id);
  }
  return files.map((file) => store.index(home.slug, file.id, file.file, file.parse, now));
}

export async function mirrorRoutine(
  store: RoutineStore,
  home: CreatureHome,
  id: string,
  now: number,
): Promise<IndexedRoutine | undefined> {
  const file = await readRoutineFile(home.dir, id);
  if (file === undefined) {
    store.forget(home.slug, id);
    return undefined;
  }
  return store.index(home.slug, id, file.file, file.parse, now);
}

export function routineOf(indexed: IndexedRoutine): Routine | undefined {
  return "routine" in indexed.parse ? indexed.parse.routine : undefined;
}
