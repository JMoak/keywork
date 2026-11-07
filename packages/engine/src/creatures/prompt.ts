import type { PermissionRule } from "@keywork/shared";
import type { CreatureFile } from "./file.ts";

export function introductionOf(name: string, keeper: string): string {
  return `You are ${name}, ${keeper}'s creature; you keep work moving between conversations and you ask before anything that cannot be undone.`;
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
