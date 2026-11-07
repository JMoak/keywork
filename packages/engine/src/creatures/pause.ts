import type { RoutineService } from "../routines/service.ts";
import type { CreatureFile, CreaturePaused } from "./file.ts";

export interface CreatureChores {
  enabled(creature: string): Promise<string[]>;
  turn(creature: string, id: string, enabled: boolean): Promise<boolean>;
}

export interface CreaturePause {
  slug: string;
  paused: boolean;
  since: string | null;
  chores: string[];
}

export type ChoreSwitchboard = Pick<RoutineService, "list" | "read" | "put">;

export const noChores: CreatureChores = {
  enabled: async () => [],
  turn: async () => false,
};

export function choresOver(routines: ChoreSwitchboard): CreatureChores {
  return {
    enabled: async (creature) => {
      const views = await routines.list(creature);
      if (typeof views === "string") return [];
      return views.filter((view) => view.routine?.enabled === true).map((view) => view.id);
    },
    turn: async (creature, id, enabled) => {
      const view = await routines.read(creature, id);
      if (typeof view === "string" || view.routine === null) return false;
      const outcome = await routines.put(creature, id, { ...view.routine, enabled });
      return typeof outcome !== "string" && !("refusal" in outcome);
    },
  };
}

export async function switchedChores(
  chores: CreatureChores,
  creature: string,
  ids: readonly string[],
  enabled: boolean,
): Promise<string[]> {
  const switched: string[] = [];
  for (const id of ids) {
    if (await chores.turn(creature, id, enabled)) switched.push(id);
  }
  return switched;
}

export function pauseOf(slug: string, paused: CreaturePaused | undefined): CreaturePause {
  return paused === undefined
    ? { slug, paused: false, since: null, chores: [] }
    : { slug, paused: true, since: paused.since, chores: paused.chores };
}

export function unpaused({ paused: _released, ...file }: CreatureFile): CreatureFile {
  return file;
}
