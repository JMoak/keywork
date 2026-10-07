import type { Message } from "@keywork/engine";
import type { ForgetTarget, SessionAttachment } from "./session-attachment.ts";
import type { TranscriptEntry } from "./transcript-feed.ts";

export type { ForgetTarget } from "./session-attachment.ts";

export interface ForgetOutcome {
  readonly forgotten: boolean;
  readonly note: string;
}

export type ForgetHook = (
  target: ForgetTarget,
  replacement: string | null,
) => Promise<ForgetOutcome>;

export interface ForgetSeams {
  attachment: SessionAttachment;
  adopt(history: readonly Message[]): boolean;
}

export const forgetPickerHint = "forget · ↑ older · ↓ newer · enter forgets it · esc cancel";

export function forgetInSession(seams: ForgetSeams): ForgetHook | undefined {
  const forget = seams.attachment.forget;
  if (forget === undefined) return undefined;
  return async (target, replacement) => {
    const history = await forget(target, replacement);
    if (history === undefined) return { forgotten: false, note: notOnThisPathNote };
    const live = seams.adopt(history);
    return { forgotten: true, note: noteFor(target, replacement, live) };
  };
}

export function forgetTargetOf(entry: TranscriptEntry): ForgetTarget | undefined {
  if (entry.kind === "user" && entry.entryId !== undefined) {
    return { kind: "prompt", promptId: entry.entryId };
  }
  if (entry.kind === "tool" && entry.run?.callId !== undefined) {
    return { kind: "tool", callId: entry.run.callId };
  }
  return undefined;
}

export function isForgettable(entry: TranscriptEntry): boolean {
  return forgetTargetOf(entry) !== undefined;
}

const notOnThisPathNote = "nothing to forget there · it isn't on this session's path";

function noteFor(target: ForgetTarget, replacement: string | null, live: boolean): string {
  const subject = target.kind === "prompt" ? "that prompt" : "that tool call and its result";
  const verb = replacement === null ? `forgot ${subject}` : `rewrote ${subject}`;
  const effect =
    replacement === null ? "out of the model's context" : "the model sees your line instead";
  const reach = live
    ? "the transcript keeps the original"
    : "takes effect when the session reopens";
  return `${verb} · ${effect} · ${reach}`;
}
