import { formatReference } from "../../inference/references.ts";
import type { ModelReference, ResolutionFailureCode } from "../../inference/types.ts";
import { type PolicyEnvironment, resolvePolicy } from "./resolve.ts";
import type { ModelClass, ModelPolicy, PolicyLevels } from "./types.ts";

export type InheritedModel = ModelReference | InheritedDecider | InheritRefusal;

export interface InheritedDecider extends ModelReference {
  decider: "builtin";
  detail: string;
}

export interface InheritRefusal {
  refused: ResolutionFailureCode;
  detail: string;
}

export type InheritedClasses = Record<ModelClass, InheritedModel>;

export function inheritedClasses(
  fallback: ModelReference | undefined,
  environment: PolicyEnvironment,
): InheritedClasses {
  return {
    strong: inheritedFor("strong", fallback, environment),
    loop: inheritedFor("loop", fallback, environment),
    decide: inheritedFor("decide", fallback, environment),
    vision: inheritedFor("vision", fallback, environment),
  };
}

const noDefault: InheritRefusal = {
  refused: "unconfigured",
  detail: "this host has no default model to inherit",
};

function inheritedFor(
  modelClass: ModelClass,
  fallback: ModelReference | undefined,
  environment: PolicyEnvironment,
): InheritedModel {
  if (fallback === undefined) return noDefault;
  const resolution = resolvePolicy(
    { modelClass, levels: soleChoice(modelClass, fallback) },
    environment,
  );
  if (!resolution.ok) {
    return { refused: resolution.failure.code, detail: resolution.failure.message };
  }
  if (resolution.kind === "inherit") return noDefault;
  const [primary] = resolution.plan.candidates;
  const { provider, model } = primary.binding.reference;
  if (primary.decider !== "builtin") return { provider, model };
  return { provider, model, decider: "builtin", detail: builtinDetail({ provider, model }) };
}

function builtinDetail(reference: ModelReference): string {
  return `${formatReference(reference)} has no decision endpoint or logprobs, so the built-in decider asks it each question`;
}

function soleChoice(modelClass: ModelClass, fallback: ModelReference): PolicyLevels {
  const policy: Partial<ModelPolicy> = {};
  policy[modelClass] = { provider: fallback.provider, model: fallback.model };
  return { user: policy };
}
