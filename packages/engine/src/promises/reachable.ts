import { formatReference } from "../inference/references.ts";
import type { ModelClass } from "../models/policy/types.ts";
import type { ModelSubject, ModelWatch } from "./models.ts";
import { stateOf } from "./state.ts";
import type { CreaturePromise, PromiseEvidence, RepairEpisode } from "./types.ts";

export const modelsReachableChecks =
  "Each model this creature talks and works on can answer. A model server on this machine or the tailnet is asked for its list of models, which spends no tokens; a model on the market is checked for its key, and the engine never calls the market only to check. Every turn and every chore start counts as well. When talking with you finds the model's server silent, the engine asks it again three times over about three and a half minutes before it asks you.";

export const workshopHealthyChecks =
  "The creature's workshop answers. On a bare host this is the workspace folder, which must be there and writable; a sealed workshop must be known to this machine and answer when it runs. Nothing repairs a workshop yet: sealed workshops arrive later.";

export const gatesValidChecks =
  "Every gate the creature holds is still the one you opened: a chore that writes, acts or runs a check holds exactly the grant set and command you accepted, and a gate onto another machine is signed and not yet expired. A gate is never repaired by the engine: a changed one waits for you again.";

export function modelsReachable(
  creature: string,
  subjects: readonly ModelSubject[],
  watch: Pick<ModelWatch, "findingOf" | "episodesOf">,
): CreaturePromise {
  const evidence = subjects.map((subject) => modelEvidenceOf(subject, watch));
  const repairs: RepairEpisode[] = watch
    .episodesOf(creature)
    .map(({ subject, startedAt, tries, bound, nextAt, endedAt, outcome }) => ({
      subject,
      startedAt,
      tries,
      bound,
      nextAt,
      endedAt,
      outcome,
    }));
  return {
    kind: "models-reachable",
    state: stateOf(evidence, repairs),
    checks: modelsReachableChecks,
    evidence,
    repairs,
  };
}

export function heldPromise(
  kind: "workshop-healthy" | "gates-valid",
  evidence: PromiseEvidence[],
): CreaturePromise {
  return {
    kind,
    state: stateOf(evidence, []),
    checks: kind === "workshop-healthy" ? workshopHealthyChecks : gatesValidChecks,
    evidence,
    repairs: [],
  };
}

function modelEvidenceOf(
  subject: ModelSubject,
  watch: Pick<ModelWatch, "findingOf">,
): PromiseEvidence {
  const named = `${formatReference(subject.reference)}, ${usesOf(subject.classes)}`;
  if (subject.refusal !== null) {
    return { subject: named, checkedAt: null, found: subject.refusal, ok: false };
  }
  const finding = watch.findingOf(subject.reference);
  if (finding !== undefined) {
    return { subject: named, checkedAt: finding.at, found: finding.found, ok: finding.answered };
  }
  return {
    subject: named,
    checkedAt: null,
    found: subject.endpoint === null ? "on the market, with its key" : "not asked yet",
    ok: subject.endpoint === null ? true : null,
  };
}

function usesOf(classes: readonly ModelClass[]): string {
  const uses = classes.map((modelClass) => useWords[modelClass]);
  return uses.length <= 1 ? (uses[0] ?? "") : `${uses.slice(0, -1).join(", ")} and ${uses.at(-1)}`;
}

const useWords: Readonly<Record<ModelClass, string>> = {
  strong: "for talking with you",
  loop: "for its chores",
  decide: "for its decisions",
  vision: "for what it sees",
};
