import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Message, SessionStore } from "@keywork/engine";

export interface OpenedSession {
  store: SessionStore;
  seeded: readonly Message[];
}

export async function openOrResumeSession(
  dir: string,
  cwd: string,
  resume: boolean,
): Promise<OpenedSession> {
  if (resume) {
    const latest = await latestSessionFile(dir);
    if (latest !== undefined) {
      const store = await SessionStore.open(latest);
      return { store, seeded: store.messages() };
    }
  }
  const store = await SessionStore.create(join(dir, `${Date.now()}.jsonl`), cwd);
  return { store, seeded: [] };
}

export async function latestSessionFile(dir: string): Promise<string | undefined> {
  const names = await sessionFileNames(dir);
  const last = names.sort().at(-1);
  return last === undefined ? undefined : join(dir, last);
}

async function sessionFileNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
}
