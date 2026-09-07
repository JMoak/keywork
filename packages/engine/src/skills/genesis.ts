import { createHash } from "node:crypto";
import { validatedName } from "../extensions/layers.ts";
import type { ReviewProposal } from "../memory/staging.ts";

export interface CommandOccurrence {
  id: string;
  text: string;
}

export interface RecurringSequence {
  fingerprint: string;
  commands: string[];
  occurrences: string[];
}

export type SkillProposal = Extract<ReviewProposal, { kind: "skill-proposal" }>;

export const genesisRecurrenceFloor = 2;
export const genesisSequenceFloor = 2;

export function commandSequenceOf(text: string): string[] {
  const commands: string[] = [];
  for (const line of text.split("\n")) {
    const prompted = promptedCommand(line);
    if (prompted !== undefined) commands.push(prompted);
    else
      for (const quoted of line.matchAll(backtickSpan)) commands.push(normalized(quoted[1] ?? ""));
  }
  return commands.filter((command) => command !== "");
}

export function sequenceFingerprint(commands: readonly string[]): string {
  return createHash("sha256").update(commands.join("\n")).digest("hex").slice(0, 16);
}

export function recurringSequences(
  entries: readonly CommandOccurrence[],
  floor = genesisRecurrenceFloor,
): RecurringSequence[] {
  const byFingerprint = new Map<string, RecurringSequence>();
  for (const entry of entries) {
    const commands = commandSequenceOf(entry.text);
    if (commands.length < genesisSequenceFloor) continue;
    const fingerprint = sequenceFingerprint(commands);
    const sequence = byFingerprint.get(fingerprint) ?? { fingerprint, commands, occurrences: [] };
    if (!sequence.occurrences.includes(entry.id)) sequence.occurrences.push(entry.id);
    byFingerprint.set(fingerprint, sequence);
  }
  return [...byFingerprint.values()].filter((sequence) => sequence.occurrences.length >= floor);
}

export function skillProposalFor(sequence: RecurringSequence): SkillProposal {
  return {
    kind: "skill-proposal",
    name: skillNameFor(sequence),
    fingerprint: sequence.fingerprint,
    commands: sequence.commands.join("\n"),
    occurrences: sequence.occurrences.length,
  };
}

export function skillNameFor(
  sequence: Pick<RecurringSequence, "fingerprint" | "commands">,
): string {
  const lead = (sequence.commands[0] ?? "")
    .split(/\s+/)
    .slice(0, 3)
    .map((word) => word.replace(/[^A-Za-z0-9_-]/g, ""))
    .filter((word) => word !== "")
    .join("-");
  try {
    return validatedName(lead);
  } catch {
    return `routine-${sequence.fingerprint.slice(0, 8)}`;
  }
}

export function skillDescriptionFor(
  proposal: Pick<SkillProposal, "commands" | "occurrences">,
): string {
  const steps = proposal.commands.split("\n");
  return `Run ${steps[0]} and the ${steps.length - 1} steps that followed it, a routine seen ${proposal.occurrences} times`;
}

export function skillBodyFor(proposal: Pick<SkillProposal, "commands">): string {
  const steps = proposal.commands
    .split("\n")
    .map((command, index) => `${index + 1}. \`${command}\``)
    .join("\n");
  return `Run these in order, checking each before the next:\n\n${steps}\n`;
}

const backtickSpan = /`([^`\n]+)`/g;
const promptedLine = /^\s*\$\s+(.+)$/;

function promptedCommand(line: string): string | undefined {
  const match = promptedLine.exec(line);
  return match === null ? undefined : normalized(match[1] ?? "");
}

function normalized(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}
