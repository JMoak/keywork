import type { RunRow } from "../routines/run.ts";
import type { NeedsYouKind } from "../routines/service.ts";
import { toolSubjectOf } from "../tool-activity.ts";

export interface AskWords {
  who: string | null;
  tool: string;
  arguments: unknown;
}

export interface ChoreNeedWords {
  who: string | null;
  chore: string | null;
  routineId: string;
  need: NeedsYouKind;
  reason: string;
  run: Pick<RunRow, "process" | "delivery" | "reason"> | null;
}

export interface ChoreRunWords {
  who: string | null;
  chore: string;
}

export function askNoticeTitle({ who, tool, arguments: args }: AskWords): string {
  return `${who ?? "A conversation"} asks to ${askedActivity(tool, args)}`;
}

export function choreNeedNoticeTitle(words: ChoreNeedWords): string {
  const chore = choreNamed(words.who, words.chore ?? words.routineId);
  switch (words.need) {
    case "grants":
      return `${chore} ${words.reason}`;
    case "run":
      return runNeedWords(chore, words);
    case "invalid":
      return `${words.who === null ? "A chore file" : `${words.who}'s chore file`} ${words.routineId}.json has a mistake, so the chore cannot run`;
    case "disabled":
      return `${chore} kept failing, so it stopped`;
  }
}

export function choreRunNoticeTitle({ who, chore }: ChoreRunWords): string {
  return who === null ? `The chore "${chore}" finished` : `${who} finished the chore "${chore}"`;
}

export function inboxNoticeTitle(pending: number): string {
  return pending === 1
    ? "1 thing in memory waits for your review"
    : `${pending} things in memory wait for your review`;
}

function choreNamed(who: string | null, chore: string): string {
  return who === null ? `The chore "${chore}"` : `${who}'s chore "${chore}"`;
}

function runNeedWords(chore: string, { run, reason }: ChoreNeedWords): string {
  switch (run?.process) {
    case "blocked":
      return `${chore} stopped because it ${run.reason ?? "went over its budget"}`;
    case "timed-out":
      return `${chore} ran too long, so it was stopped`;
    case "failed":
      return `${chore} failed: ${run.reason ?? reason}`;
  }
  switch (run?.delivery) {
    case "failed":
      return `${chore} finished, but its report could not be delivered`;
    case "unknown":
      return `${chore} finished, but its report may not have arrived`;
  }
  return `${chore} needs you: ${reason}`;
}

function askedActivity(tool: string, args: unknown): string {
  const subject = toolSubjectOf(args);
  const verb = askedVerbs.get(tool);
  if (verb !== undefined) return subject === "" ? verb.alone : `${verb.with} ${subject}`;
  const name = servedToolName(tool);
  return subject === "" ? `use ${name}` : `use ${name} on ${subject}`;
}

const askedVerbs: ReadonlyMap<string, { with: string; alone: string }> = new Map([
  ["write", { with: "write", alone: "write a file" }],
  ["edit", { with: "edit", alone: "edit a file" }],
  ["read", { with: "read", alone: "read a file" }],
  ["bash", { with: "run", alone: "run a command" }],
]);

function servedToolName(tool: string): string {
  const split = tool.indexOf(mcpToolSeparator);
  if (split <= 0 || split + mcpToolSeparator.length >= tool.length) return tool;
  return `${tool.slice(split + mcpToolSeparator.length)} from ${tool.slice(0, split)}`;
}

const mcpToolSeparator = "__";
