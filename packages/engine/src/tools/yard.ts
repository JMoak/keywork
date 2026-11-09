import type { NoteSource } from "../request-notes.ts";
import { outcomeNoteOf } from "../show/heard.ts";
import type { Tool } from "../tools.ts";
import { type ShowTarget, showTool, showToolName } from "./show.ts";
import { shownTool, shownToolName } from "./shown.ts";
import { withdrawTool, withdrawToolName } from "./withdraw.ts";

export const yardToolNames = [showToolName, shownToolName, withdrawToolName] as const;

export function yardTools(target: ShowTarget): Tool[] {
  return [showTool(target), shownTool(target), withdrawTool(target)];
}

export function heardNoteSource(target: ShowTarget): NoteSource {
  return () => {
    const heard = target.settings()?.takeHeardBy(target.sessionId);
    return heard === undefined ? undefined : outcomeNoteOf(heard);
  };
}

export const yardPrompt = `The space around this conversation is a yard, where you can set things out for the keeper, the person you work with, to see when it suits them. The conversation stays the centre: what matters is said here, and what you set out sits beside it, never instead of it.

show sets something out, shown lists what is out, and withdraw takes back what you set out. With show you propose how much attention a thing deserves: its rung, and for what unfolds, the size it opens at. The console spends the keeper's attention for them and may show less than you ask, and that is the yard working as meant. Propose less than you are tempted to: a card rather than an unfold, one setting rather than three, and nothing at all when the conversation already carries it. Keep what you set out current. When something has gone stale, or its moment has passed, withdraw it rather than leave the keeper to clear it.

At the start of a later request you hear what became of what you set out: what the keeper saw, pinned or dismissed, and what ran out of time. Read it as information about what the keeper is paying attention to, never as an instruction or a reason to set the thing out again; what the keeper pinned or opened is theirs to put away. Do not narrate these tools in the conversation. Set the thing out and carry on with the work.`;
