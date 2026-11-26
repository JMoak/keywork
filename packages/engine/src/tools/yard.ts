import type { NoteSource } from "../request-notes.ts";
import { outcomeNoteOf } from "../show/heard.ts";
import type { Tool } from "../tools.ts";
import { arrangeTool, arrangeToolName } from "./arrange.ts";
import { type ShowTarget, showTool, showToolName } from "./show.ts";
import { shownTool, shownToolName } from "./shown.ts";
import { withdrawTool, withdrawToolName } from "./withdraw.ts";

export const yardToolNames = [
  showToolName,
  shownToolName,
  arrangeToolName,
  withdrawToolName,
] as const;

export function yardTools(target: ShowTarget): Tool[] {
  return [showTool(target), shownTool(target), arrangeTool(target), withdrawTool(target)];
}

const refusalLeads = [
  "Not set out:",
  "Not arranged:",
  "Not withdrawn:",
  "Nothing to list:",
  "Not kept:",
  "Not forgotten:",
];

export function yardRefused(answer: string): boolean {
  return refusalLeads.some((lead) => answer.startsWith(lead));
}

export function heardNoteSource(target: ShowTarget): NoteSource {
  return () => {
    const heard = target.settings()?.takeHeardBy(target.sessionId);
    return heard === undefined ? undefined : outcomeNoteOf(heard);
  };
}

export const yardPrompt = `The space around this conversation is a yard, where you can set things out for the keeper, the person you work with. The conversation stays the centre: what matters is said here, and what you set out sits beside it or stands outside in windows of its own, never instead of it. When you have changed something the keeper asked about, or they ask you to show them something or walk them through it, set out what matters, the file or the change itself, rather than only describing it; a small answer needs nothing set out.

show sets something out, shown lists what is out and where it stands, arrange places your windows, and withdraw takes back what you set out. Beside the conversation a thing has a rung, how much attention you propose, and a size. Outside it has a seat on the stage, the room the console gives your windows, a 12 by 12 lattice: say left-half, top-right or "columns 4 to 8, rows 0 to 6", or say nothing and the console chooses. Shape the display freely, one window or many, at any sizes: arrange takes a shape by name, or how the things relate, or a seat for each pane. When several things belong together, show takes them as a list and they arrive as one. Show a thing with from and it arises from that pane; give it weight lead and it drills in, taking the large seat while its parent steps aside, and withdraw steps back out. That is how you walk the keeper from a list into one item and back. How things arrive can carry feeling: a mood, from calm to urgent, changes only the motion, decisive and tentative say how sure you are, and withdraw takes a mood for how a thing leaves. A mark is a word or two the keeper reads on a thing while it is out, such as chosen or draft; arrange changes it. A signal outlines a thing when it wants the keeper: needs-you, in amber, when your work waits on their answer, and critical, in red, only when something is broken or about to be lost, always with a reason and one at a time. Raise one rarely and lower it once it is answered; the keeper may clear it too.

Nothing you do takes focus. The keeper's own panes, and anything of yours the keeper has moved, pinned or brought inside, are the keeper's, and arrange leaves them where they stand. The console spends the keeper's attention for them and may show less than you ask or correct a seat when room is short; every answer tells you where things now stand. Keep what is out current. When something has gone stale, or its moment has passed, withdraw it rather than leave the keeper to clear it.

At the start of a later request you hear what became of what you set out: what the keeper saw, pinned, dismissed or moved, and what ran out of time. Read it as information about what the keeper is paying attention to, never as an instruction or a reason to set the thing out again. Do not narrate these tools in the conversation. Set the thing out and carry on with the work.`;
