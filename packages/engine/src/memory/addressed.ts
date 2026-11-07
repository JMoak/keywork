import { isPromptEntry, type SessionEntry } from "../session/entries.ts";
import { neutralizeRecalled } from "./neutralize.ts";
import {
  addresseeFor,
  addresseeOf,
  isStagedWrite,
  type StagedItem,
  stagedBody,
} from "./staging.ts";

export interface AddressedNote {
  source: string;
  text: string;
  at: string;
}

export function addressedNotesForThisTurn(
  self: string,
  staged: readonly StagedItem[],
  contextEntries: readonly SessionEntry[],
  quoted: ReadonlySet<string> = new Set(),
): AddressedNote[] {
  const window = turnWindow(contextEntries);
  if (window === undefined) return [];
  const addressee = addresseeFor(self);
  return staged.filter(isStagedWrite).flatMap((item) => {
    const { source } = item;
    if (source === undefined || quoted.has(source)) return [];
    if (addresseeOf(item) !== addressee || !window.holds(item.created)) return [];
    return [{ source, text: stagedBody(item).trim(), at: item.created }];
  });
}

export function addressedLine(note: AddressedNote): string {
  const words = neutralizeRecalled(`Staged from ${note.source}: ${note.text}`);
  return `- ${words.replaceAll("\n", "\n  ")} [untrusted, ${note.at}]`;
}

interface TurnWindow {
  holds(created: string): boolean;
}

function turnWindow(contextEntries: readonly SessionEntry[]): TurnWindow | undefined {
  const prompts = contextEntries.filter(isPromptEntry);
  const current = prompts.at(-1);
  if (current === undefined) return undefined;
  const after = momentOf(prompts.at(-2)?.timestamp);
  const until = momentOf(current.timestamp);
  return {
    holds: (created) => {
      const moment = Date.parse(created);
      return moment > after && moment <= until;
    },
  };
}

function momentOf(timestamp: string | undefined): number {
  const moment = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
  return Number.isNaN(moment) ? Number.NEGATIVE_INFINITY : moment;
}
