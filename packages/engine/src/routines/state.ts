import { join } from "node:path";

export interface RoutinesState {
  dir: string;
  database: string;
  outputs: string;
}

export function routinesStateOf(stateDir: string): RoutinesState {
  const dir = join(stateDir, "routines");
  return { dir, database: join(dir, "routines.db"), outputs: join(dir, "outputs") };
}
