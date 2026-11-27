import type { PermissionRule } from "@keywork/shared";
import { listed } from "../show/words.ts";
import { type CreatureTemperaments, mannerOf, rangeOf, temperamentOf } from "./file.ts";

export function introductionOf(name: string, keeper: string): string {
  return `You are ${name}, ${keeper}'s creature; you keep work moving between conversations and you ask before anything that cannot be undone.`;
}

export function temperamentSentence(creature: CreatureTemperaments): string {
  const favourite = temperamentOf(creature);
  const manner = mannerOf(creature);
  const others = rangeOf(creature).filter((each) => each !== favourite && each !== manner);
  const also = `you can also be ${listed(others, "or")}`;
  const now =
    manner === favourite
      ? `${temperamentOpening}${favourite}, your favourite; ${also}.`
      : `${temperamentOpening}${manner} for now; your favourite is ${favourite}, and ${also}.`;
  return `${now} ${panesOpening} when you set them out, arrange them or take them back without naming a mood; when the work calls for another of these, take it on with arrange's temperament, and you settle back to ${favourite} by yourself.`;
}

export function withoutPanes(paragraph: string): string {
  if (!paragraph.startsWith(temperamentOpening)) return paragraph;
  const panes = paragraph.indexOf(` ${panesOpening}`);
  return panes === -1 ? paragraph : paragraph.slice(0, panes);
}

const temperamentOpening = "Your temperament is ";

const panesOpening = "It is how your panes move";

export function creatureStanding(
  grants: readonly PermissionRule[],
  keeperRules: readonly PermissionRule[] = [],
): string {
  const keepers = capabilityLines(keeperRules, keeperRuleSaid);
  const lines = [...keepers, ...capabilityLines(grants)];
  if (lines.length === 0) return noGrantsSentence;
  const keeperWins = keepers.length === 0 ? [] : [keeperRulesWin];
  return [grantsHeading, ...lines, ...keeperWins, everythingElseAsks].join("\n");
}

export function namesItsTools(paragraph: string): boolean {
  return paragraph === noGrantsSentence || paragraph.startsWith(grantsHeading);
}

export function capabilityLines(
  grants: readonly PermissionRule[],
  said: (verdict: string) => string = (verdict) => verdict,
): string[] {
  const lines: string[] = [];
  for (const rule of grants) {
    const line = `- ${rule.action} ${rule.resource}: ${said(verdicts[rule.effect])}`;
    if (!lines.includes(line)) lines.push(line);
  }
  return lines;
}

export const keeperRulesWin =
  "Where one of the keeper's own rules and another line both fit a call, the keeper's rule wins.";

function keeperRuleSaid(verdict: string): string {
  return `${verdict}, by the keeper's own rule`;
}

export const noGrantsSentence =
  "You hold no standing grants here: every tool call asks first, and you may not claim otherwise.";

export const grantsHeading = "Your standing grants here, the only capabilities you may claim:";

export const everythingElseAsks =
  "Anything this list does not allow asks the keeper first, every time: writing or editing a file, a git commit or branch, an install, any other command. When you say what you can do, say that, and claim nothing more.";

const verdicts: Record<PermissionRule["effect"], string> = {
  allow: "allowed without asking",
  ask: "asks first",
  deny: "refused",
};
