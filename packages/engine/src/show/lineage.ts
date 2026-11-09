import type { Setting } from "./setting.ts";

export type SettingSeat = Pick<Setting, "creature" | "sessionId">;

export interface ShowThread {
  creature: string | null;
  parent: string | null;
}

export type ThreadLookup = (sessionId: string) => Promise<ShowThread | undefined>;

export function ownerOf({ creature, sessionId }: SettingSeat): string {
  return creature === null ? `thread ${sessionId}` : `creature ${creature}`;
}

export function sameOwner(one: SettingSeat, other: SettingSeat): boolean {
  return ownerOf(one) === ownerOf(other);
}

export function sees(caller: SettingSeat, thread: ShowThread): boolean {
  return (
    thread.parent === caller.sessionId ||
    (caller.creature !== null && thread.creature === caller.creature)
  );
}
