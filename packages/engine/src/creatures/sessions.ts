import type { SessionEntry } from "../session/entries.ts";
import type { SessionStore } from "../session/store.ts";

export const creatureSessionType = "keywork.creature";

export const creatureSessionKinds = ["conversation", "thread", "routine", "child"] as const;

export type CreatureSessionKind = (typeof creatureSessionKinds)[number];

export interface CreatureSessionTag {
  creature: string;
  kind: CreatureSessionKind;
}

export class SessionClaimedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly held: CreatureSessionTag,
  ) {
    super(`session ${sessionId} already belongs to ${held.creature} as its ${held.kind}`);
    this.name = "SessionClaimedError";
  }
}

export async function claimSession(
  store: SessionStore,
  tag: CreatureSessionTag,
): Promise<CreatureSessionTag> {
  const held = creatureTagOf(store.entries());
  if (held !== undefined && !sameTag(held, tag))
    throw new SessionClaimedError(store.header.id, held);
  if (store.botBinding() !== tag.creature) await store.appendBotBinding(tag.creature);
  if (held === undefined) await store.appendCustom(creatureSessionType, tag);
  return tag;
}

export function creatureTagOf(entries: readonly SessionEntry[]): CreatureSessionTag | undefined {
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== creatureSessionType) continue;
    if (isCreatureTag(entry.data)) return entry.data;
  }
  return undefined;
}

export function childTagOf(parent: CreatureSessionTag): CreatureSessionTag {
  return { creature: parent.creature, kind: "child" };
}

export function isCreatureTag(data: unknown): data is CreatureSessionTag {
  if (typeof data !== "object" || data === null) return false;
  const { creature, kind } = data as { creature?: unknown; kind?: unknown };
  return typeof creature === "string" && creature !== "" && isCreatureSessionKind(kind);
}

function isCreatureSessionKind(value: unknown): value is CreatureSessionKind {
  return (creatureSessionKinds as readonly unknown[]).includes(value);
}

function sameTag(left: CreatureSessionTag, right: CreatureSessionTag): boolean {
  return left.creature === right.creature && left.kind === right.kind;
}
