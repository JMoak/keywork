import {
  type BotDefinition,
  closingJudgment,
  type Provider,
  type SessionStore,
  type SkillEvidence,
  type SkillLibrary,
} from "@keywork/engine";
import { toError } from "@keywork/shared";
import type { BotJudgmentLookup, BotMemory } from "./bot-memory.ts";
import { skillEvidenceOf, sweepOnClose, type WorkspaceMemory } from "./memory.ts";
import { skillTelemetryFile, workspaceIdentity } from "./paths.ts";

export interface WorkspaceSweep {
  memory(): WorkspaceMemory | undefined;
  skills(): Promise<SkillEvidence>;
  bots: Pick<BotMemory, "sweep">;
  judgmentFor: BotJudgmentLookup;
}

export interface WorkspacePlace {
  cwd: string;
  workspaceSlug?: string | undefined;
  userRoot?: string | undefined;
}

export type ClosingProviderAmong = (sessionIds: readonly string[]) => Provider | undefined;

export async function sweepWorkspaceOnClose(sweep: WorkspaceSweep): Promise<void> {
  const outcomes = await Promise.allSettled([
    sweep.skills().then((skills) => sweepOnClose(sweep.memory(), skills)),
    sweep.bots.sweep(sweep.judgmentFor),
  ]);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [toError(outcome.reason)] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, failures.map((failure) => failure.message).join(" · "));
  }
}

export function workspaceSkillEvidence(
  skills: SkillLibrary,
  place: WorkspacePlace,
): Promise<SkillEvidence> {
  const identity = workspaceIdentity(place.cwd, place.workspaceSlug);
  return skillEvidenceOf(skills, skillTelemetryFile(identity, place.userRoot));
}

export function botJudgmentFrom(
  closingProvider: ClosingProviderAmong,
  stores: () => Iterable<SessionStore>,
): BotJudgmentLookup {
  return (bot) => {
    const provider = closingProvider(sessionsBoundTo(bot, stores()));
    if (provider === undefined) return undefined;
    return closingJudgment({
      provider,
      subject: { kind: "bot", slug: bot.name, sigil: bot.sigil },
    });
  };
}

function sessionsBoundTo(bot: BotDefinition, stores: Iterable<SessionStore>): string[] {
  return [...stores]
    .filter((store) => store.botBinding() === bot.name)
    .map((store) => store.header.id);
}
