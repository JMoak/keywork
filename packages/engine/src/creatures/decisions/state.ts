import type { CreatureSessionTag } from "../sessions.ts";
import { type AskFacts, askTextLimit } from "./facts.ts";
import type { Ratchet, StateLike } from "./ratchet.ts";

export const keeperStateTitle = "A tool call the keeper was asked to approve";

export const keeperThreadKinds = [
  "conversation",
  "thread",
  "routine",
  "child",
  "mesh",
  "session",
] as const;

export type KeeperThreadKind = (typeof keeperThreadKinds)[number];

export interface KeeperContext {
  creature?: string | undefined;
  thread: KeeperThreadKind;
  workshop?: string | undefined;
}

export type TrustedFacts = ReadonlyMap<string, string>;

export function keeperContextOf(
  tag: CreatureSessionTag | undefined,
  workshop?: string | undefined,
): KeeperContext {
  if (tag === undefined) return { thread: "session" };
  return { creature: tag.creature, thread: tag.kind, workshop };
}

export function keeperState(
  ratchet: Pick<Ratchet, "State">,
  facts: AskFacts,
  context: KeeperContext,
): StateLike {
  return ratchet.State.create(keeperStateTitle)
    .field("tool", facts.tool)
    .field("rule", facts.rules)
    .field("rule_class", facts.ruleClass)
    .field("creature", context.creature ?? null)
    .field("thread", context.thread)
    .field("workshop", context.workshop ?? null)
    .field("asked_because", facts.askedBecause)
    .digest("destructive", facts.destructive)
    .digest("opaque", facts.opaque)
    .digest("truncated", facts.truncated)
    .digest("command_parts", facts.commandParts)
    .digest("inside_workspace", facts.insideWorkspace)
    .untrusted("ask", facts.askText, { maxChars: askTextLimit, note: askNoteFor(facts.tool) })
    .build();
}

export function trustedFactsOf(stateText: string): TrustedFacts {
  const [trusted = ""] = stateText.split(untrustedMarker);
  return new Map(trusted.split("\n").flatMap(factOf));
}

const untrustedMarker = "\n\n[untrusted ";
const factLine = /^([a-z_]+): (.*)$/;

function factOf(line: string): [string, string][] {
  const [, name, value] = factLine.exec(line) ?? [];
  return name === undefined || value === undefined ? [] : [[name, value]];
}

function askNoteFor(tool: string): string {
  if (tool === "bash") return "the command as the agent wrote it";
  if (tool === "read" || tool === "write" || tool === "edit") return "the path the agent named";
  return "the arguments the agent sent";
}
