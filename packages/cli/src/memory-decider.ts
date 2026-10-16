import {
  type BuiltinSeams,
  builtinDecider,
  type FetchLike,
  type JevFailure,
  jevClient,
  jevDecider,
  jevModel,
  jevQuestions,
  type MemoryDecider,
  type MemoryQuestion,
  type NamedSecret,
  provenQuestions,
  withFallback,
} from "@keywork/engine";
import { type KeyworkConfig, type MemoryDeciderName, memoryDeciderOf } from "@keywork/shared";
import type { CredentialMap, CredentialPlacement } from "./auth-store.ts";
import { typesafeDecider } from "./inference/builtins.ts";
import type { ObservationMap } from "./inference/observations.ts";

export const deciderTrialVariable = "KEYWORK_DECIDER_TRIAL";

export const typesafeRefusal = "TypeSafe refused the key";

export const deciderNotices = {
  noKey: "memory decider: jev selected, no TypeSafe key · keywork connect typesafe",
  refused:
    "memory decider: TypeSafe refused the key, so memory runs builtin until the key changes · keywork connect typesafe",
  trial: `memory decider: trial on (${deciderTrialVariable}=1) · Jev answers questions no eval has proven yet`,
} as const;

export type DeciderFor = (seams?: BuiltinSeams) => MemoryDecider;

export interface MemoryDeciderSetup {
  readonly deciderFor: DeciderFor;
  readonly sessionNotice?: string;
  readonly status: DeciderStatus;
}

export type DeciderCredential = "saved" | "environment" | "missing" | "refused";

export interface DeciderStatus {
  selected: MemoryDeciderName;
  credential: DeciderCredential;
  keySource?: string;
  model: string;
  verifiedAt?: string;
  refusedAt?: string;
  proven: readonly MemoryQuestion[];
  questions: number;
  trial: boolean;
}

export interface DeciderFacts {
  config: KeyworkConfig;
  credentials: CredentialMap;
  env: Record<string, string | undefined>;
  observations: ObservationMap;
  placement?: CredentialPlacement | undefined;
}

export interface DeciderInputs extends DeciderFacts {
  notice(line: string): void;
  onRefused?(at: string): void;
  fetchFn?: FetchLike | undefined;
  now?: (() => Date) | undefined;
}

export function memoryDeciderSetup(inputs: DeciderInputs): MemoryDeciderSetup {
  const status = deciderStatusOf(inputs);
  if (status.selected === "builtin") return { deciderFor: builtinDecider, status };
  const jev = jevDecider({
    client: jevClient({
      key: typesafeKeyOf(inputs.credentials, inputs.env)?.key,
      ...(inputs.fetchFn !== undefined && { fetchFn: inputs.fetchFn }),
      onFailure: (failure) => reportRefusal(failure, inputs),
    }),
    trial: status.trial,
    secrets: knownSecrets(inputs.credentials, inputs.env),
  });
  return {
    deciderFor: (seams) => {
      if (status.credential === "missing") inputs.notice(deciderNotices.noKey);
      return withFallback(jev, builtinDecider(seams));
    },
    ...(status.trial && { sessionNotice: deciderNotices.trial }),
    status,
  };
}

export function deciderStatusOf(facts: DeciderFacts): DeciderStatus {
  const key = typesafeKeyOf(facts.credentials, facts.env);
  const observation = facts.observations[typesafeDecider.name];
  const failure = observation?.lastFailure;
  const refusedAt = failure?.reason === typesafeRefusal ? failure.at : undefined;
  return {
    selected: memoryDeciderOf(facts.config),
    credential: credentialOf(key, refusedAt),
    ...(key !== undefined && { keySource: keySourceOf(key, facts.placement) }),
    model: jevModel,
    ...(observation?.verifiedAt !== undefined && { verifiedAt: observation.verifiedAt }),
    ...(refusedAt !== undefined && { refusedAt }),
    proven: [...provenQuestions(jevModel)],
    questions: jevQuestions.length,
    trial: facts.env[deciderTrialVariable] === "1",
  };
}

export function deciderDoctorLine(status: DeciderStatus): string {
  if (status.selected === "builtin") return "builtin · keywork's own rules";
  switch (status.credential) {
    case "missing":
      return "jev selected · no TypeSafe key · keywork connect typesafe";
    case "refused":
      return `jev · key refused ${minuteOf(status.refusedAt)} · keywork connect typesafe`;
    default:
      return [
        "jev",
        status.model,
        status.keySource,
        status.verifiedAt === undefined ? undefined : `verified ${status.verifiedAt.slice(0, 10)}`,
        `${status.proven.length} of ${status.questions} questions proven`,
        status.trial ? `trial on (${deciderTrialVariable}=1)` : undefined,
      ]
        .filter((fact) => fact !== undefined)
        .join(" · ");
  }
}

export interface TypesafeKey {
  key: string;
  variable?: string;
}

export function typesafeKeyOf(
  credentials: CredentialMap,
  env: Record<string, string | undefined>,
): TypesafeKey | undefined {
  const { scopedVariable, ambientVariable } = typesafeDecider.auth;
  return (
    keyFromEnvironment(env, scopedVariable) ??
    savedKey(credentials) ??
    keyFromEnvironment(env, ambientVariable)
  );
}

export function knownSecrets(
  credentials: CredentialMap,
  env: Record<string, string | undefined>,
): NamedSecret[] {
  const variables = Object.entries(env).flatMap(([name, value]) =>
    value !== undefined && secretVariableName.test(name) ? [{ name, value }] : [],
  );
  const savedKeys = Object.entries(credentials).flatMap(([provider, credential]) =>
    credential.type === "api_key" ? [{ name: `${provider} key`, value: credential.key }] : [],
  );
  return [...variables, ...savedKeys];
}

const secretVariableName = /key|token|secret|password|credential/i;

function reportRefusal(failure: JevFailure, inputs: DeciderInputs): void {
  if (failure.reason !== "refused") return;
  inputs.notice(deciderNotices.refused);
  inputs.onRefused?.((inputs.now ?? (() => new Date()))().toISOString());
}

function credentialOf(
  key: TypesafeKey | undefined,
  refusedAt: string | undefined,
): DeciderCredential {
  if (key === undefined) return "missing";
  if (refusedAt !== undefined) return "refused";
  return key.variable === undefined ? "saved" : "environment";
}

function keySourceOf(key: TypesafeKey, placement: CredentialPlacement | undefined): string {
  if (key.variable !== undefined) return key.variable;
  if (placement === "os-store") return "saved key (OS credential store)";
  if (placement === "auth.json") return "saved key (auth.json)";
  return "saved key";
}

function keyFromEnvironment(
  env: Record<string, string | undefined>,
  variable: string,
): TypesafeKey | undefined {
  const key = env[variable];
  return key === undefined || key === "" ? undefined : { key, variable };
}

function savedKey(credentials: CredentialMap): TypesafeKey | undefined {
  const saved = credentials[typesafeDecider.name];
  return saved?.type === "api_key" && saved.key !== "" ? { key: saved.key } : undefined;
}

function minuteOf(at: string | undefined): string {
  return at === undefined ? "" : `${at.slice(0, 16)}Z`;
}
