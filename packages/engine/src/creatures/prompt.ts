import type { PermissionRule } from "@keywork/shared";
import { type CreatureFile, temperamentOf } from "./file.ts";

export function introductionOf(name: string, keeper: string): string {
  return `You are ${name}, ${keeper}'s creature; you keep work moving between conversations and you ask before anything that cannot be undone.`;
}

export function temperamentSentence(creature: Pick<CreatureFile, "temperament" | "body">): string {
  return `Your temperament is ${temperamentOf(creature)}: it is your standing manner, and the way your panes move when you set them out, arrange them or take them back without naming a mood.`;
}

export function creatureInjection(
  creature: Pick<CreatureFile, "introduction">,
  grants: readonly PermissionRule[],
): string {
  return [creature.introduction, capabilitySection(grants)].join("\n\n");
}

export function capabilityLines(grants: readonly PermissionRule[]): string[] {
  const lines: string[] = [];
  for (const rule of grants) {
    const line = `- ${rule.action} ${rule.resource}: ${verdicts[rule.effect]}`;
    if (!lines.includes(line)) lines.push(line);
  }
  return lines;
}

export const noGrantsSentence =
  "You hold no standing grants here: every tool call asks first, and you may not claim otherwise.";

export const grantsHeading = "Your standing grants here, the only capabilities you may claim:";

const verdicts: Record<PermissionRule["effect"], string> = {
  allow: "allowed without asking",
  ask: "asks first",
  deny: "refused",
};

function capabilitySection(grants: readonly PermissionRule[]): string {
  const lines = capabilityLines(grants);
  return lines.length === 0 ? noGrantsSentence : [grantsHeading, ...lines].join("\n");
}
