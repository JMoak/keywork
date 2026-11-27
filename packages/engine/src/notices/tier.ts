import type { NotifyChoice } from "../routines/routine.ts";
import type { NotificationTier } from "../routines/run.ts";
import type { NeedsYouKind } from "../routines/service.ts";
import type { Quiet } from "./quiet.ts";

export type NoticeSubject =
  | { kind: "ask" }
  | { kind: "chore"; need: NeedsYouKind; runHeld: boolean }
  | { kind: "run"; notify: NotifyChoice; needsKeeper: boolean }
  | { kind: "inbox" }
  | { kind: "question" };

export function noticeTierOf(subject: NoticeSubject): NotificationTier {
  switch (subject.kind) {
    case "ask":
    case "inbox":
    case "question":
      return "interrupt";
    case "chore":
      return choreNeedTierOf(subject.need, subject.runHeld);
    case "run":
      return runTierOf(subject.notify, subject.needsKeeper);
  }
}

export type NeedTier = Exclude<NotificationTier, "log">;

export function choreNeedTierOf(need: NeedsYouKind, runHeld: boolean): NeedTier {
  return need === "grants" && !runHeld ? "digest" : "interrupt";
}

export function runTierOf(notify: NotifyChoice, needsKeeper: boolean): NotificationTier {
  if (needsKeeper) return "interrupt";
  return notify === "always" ? "digest" : "log";
}

export function heldBy(tier: NotificationTier, quiet: Quiet | null): boolean {
  return tier !== "log" && quiet !== null;
}
