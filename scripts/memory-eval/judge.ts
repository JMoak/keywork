import {
  type PairRelation,
  type PendingAction,
  type Provider,
  pairRelations,
  textMessage,
} from "../../packages/engine/src/index.ts";
import type { NoteState } from "./corpus.ts";

export interface Judge {
  readonly id: string;
  relevance(input: RelevanceCase): Promise<RelevanceVerdict | undefined>;
  relation(input: RelationCase): Promise<RelationVerdict | undefined>;
}

export interface RelevanceCase {
  action: PendingAction;
  note: { title: string; excerpt: string };
  turns: readonly string[];
}

export interface RelevanceVerdict {
  relevant: boolean;
  reason: string;
}

export interface RelationCase {
  older: NoteState;
  newer: NoteState;
}

export interface RelationVerdict {
  relation: PairRelation;
  reason: string;
}

export function chatJudge(provider: Provider, id: string): Judge {
  return {
    id,
    relevance: async (input) =>
      parseRelevance(await complete(provider, relevanceInstruction, describeRelevance(input))),
    relation: async (input) =>
      parseRelation(await complete(provider, relationInstruction, describeRelation(input))),
  };
}

export function parseRelevance(reply: string): RelevanceVerdict | undefined {
  const match = /^\s*(RELEVANT|IRRELEVANT)\b\s*:?\s*(.*)$/im.exec(reply);
  if (match === null) return undefined;
  return { relevant: match[1]?.toUpperCase() === "RELEVANT", reason: oneLine(match[2] ?? "") };
}

export function parseRelation(reply: string): RelationVerdict | undefined {
  const match = /^\s*([a-z-]+)\b\s*:?\s*(.*)$/im.exec(reply.trim());
  const relation = pairRelations.find((option) => option === match?.[1]?.toLowerCase());
  if (relation === undefined) return undefined;
  return { relation, reason: oneLine(match?.[2] ?? "") };
}

const relevanceInstruction = [
  "You label memory recall for an evaluation of a coding agent.",
  "Before the agent ran an action, a memory note was a candidate to add to its context.",
  "Read the agent's next turns and decide whether the note was relevant to what it did:",
  "it cited the note, relied on what the note says, or acted the way the note directs.",
  "Answer with one line: RELEVANT or IRRELEVANT, a colon, then a reason of at most twelve words.",
].join("\n");

const relationInstruction = [
  "You label how two memory notes relate, for an evaluation. The older note is shown first.",
  `Answer with one line: one of ${pairRelations.join(", ")}, a colon, then a reason of at most twelve words.`,
  "duplicate: they say the same thing. newer-supersedes-older: the newer replaces the older.",
  "older-still-holds: the newer claims to replace the older but the older is still right.",
  "contradiction: they disagree and neither clearly wins. distinct: they are about different things.",
].join("\n");

function describeRelevance(input: RelevanceCase): string {
  return [
    `action: ${input.action.tool} ${input.action.subject}`,
    "",
    `note: ${input.note.title}`,
    input.note.excerpt,
    "",
    "the agent's next turns:",
    ...input.turns.map((turn, index) => `--- turn ${index + 1}\n${turn}`),
  ].join("\n");
}

function describeRelation(input: RelationCase): string {
  return [
    `older note: ${input.older.title} (${input.older.provenance})`,
    input.older.body,
    "",
    `newer note: ${input.newer.title} (${input.newer.provenance})`,
    input.newer.body,
  ].join("\n");
}

async function complete(provider: Provider, instruction: string, input: string): Promise<string> {
  let text = "";
  const request = { systemPrompt: instruction, messages: [textMessage("user", input)], tools: [] };
  for await (const delta of provider.stream(request)) {
    if (delta.type === "text") text += delta.text;
  }
  return text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
