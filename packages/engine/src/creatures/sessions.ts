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

export const ledgerConversationType = "keywork.creature.ledger-conversation";

export const conversationEndedType = "keywork.creature.conversation-ended";

export interface LedgerConversationTag {
  creature: string;
  entry: string;
}

export interface ConversationEnded {
  at: string;
  by: "answer" | "keeper";
  decided: string;
}

export function ledgerConversationOf(
  entries: readonly SessionEntry[],
): LedgerConversationTag | undefined {
  const data = customDataOf(entries, ledgerConversationType);
  const { creature, entry } = (data ?? {}) as Partial<LedgerConversationTag>;
  return typeof creature === "string" && typeof entry === "string"
    ? { creature, entry }
    : undefined;
}

export function conversationEndedOf(
  entries: readonly SessionEntry[],
): ConversationEnded | undefined {
  const data = customDataOf(entries, conversationEndedType);
  const { at, by, decided } = (data ?? {}) as Partial<ConversationEnded>;
  if (typeof at !== "string" || (by !== "answer" && by !== "keeper")) return undefined;
  return { at, by, decided: typeof decided === "string" ? decided : "" };
}

export const talkingChoiceType = "keywork.creature.talking-choice";

export type TalkingChoice = "inherit" | { provider: string; model: string };

export function talkingChoiceOf(entries: readonly SessionEntry[]): TalkingChoice | undefined {
  const found = entries.findLast(
    (entry) => entry.type === "custom" && entry.customType === talkingChoiceType,
  );
  const choice =
    found?.type === "custom" ? (found.data as { choice?: unknown })?.choice : undefined;
  if (choice === "inherit") return choice;
  const { provider, model } = (choice ?? {}) as { provider?: unknown; model?: unknown };
  return typeof provider === "string" && typeof model === "string"
    ? { provider, model }
    : undefined;
}

export async function recordTalkingChoice(
  store: SessionStore,
  choice: TalkingChoice,
): Promise<void> {
  await store.appendCustom(talkingChoiceType, {
    choice: choice === "inherit" ? choice : { provider: choice.provider, model: choice.model },
  });
}

export function sameTalkingChoice(left: TalkingChoice, right: TalkingChoice): boolean {
  if (left === "inherit" || right === "inherit") return left === right;
  return left.provider === right.provider && left.model === right.model;
}

function customDataOf(entries: readonly SessionEntry[], type: string): unknown {
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === type) return entry.data;
  }
  return undefined;
}
