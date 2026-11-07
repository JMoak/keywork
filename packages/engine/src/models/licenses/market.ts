import type { ModelSpec, Protocol, ProviderRegistration } from "../../inference/types.ts";
import { ratesFor } from "../../pricing.ts";
import { eligibilityOrder, eligibleClasses, missingFor } from "../capabilities/eligibility.ts";
import { knownValue } from "../capabilities/index.ts";
import type { ModelRow, ServerRow } from "../discovery/inventory.ts";
import { noAnswers, type ProviderAnswer, type ProviderAnswers } from "../health/answers.ts";
import { type HealthReading, type HealthState, healthReading } from "../health/types.ts";
import { localityOf } from "../policy/locality.ts";
import { declaredRecord } from "../policy/resolve.ts";

export type MarketHealthState = HealthState | "unverified";

export interface MarketHealthReading extends Omit<HealthReading, "state"> {
  state: MarketHealthState;
}

export interface MarketModelRow extends Omit<ModelRow, "cost" | "health"> {
  health: MarketHealthReading;
  cost: ModelRow["cost"] | null;
}

export interface MarketServerRow extends Omit<ServerRow, "kind" | "source" | "models" | "health"> {
  kind: string;
  protocol: Protocol;
  source: "registry";
  health: MarketHealthReading;
  models: MarketModelRow[];
}

export function marketOf(
  registrations: readonly ProviderRegistration[],
  now: Date,
  answers: ProviderAnswers = noAnswers,
): MarketServerRow[] {
  const checkedAt = now.toISOString();
  return registrations
    .filter((registration) => localityOf(registration.endpoint) === "cloud")
    .map((registration) =>
      marketServer(registration, marketHealth(registration, answers, checkedAt)),
    );
}

function marketServer(
  registration: ProviderRegistration,
  health: MarketHealthReading,
): MarketServerRow {
  return {
    kind: registration.name,
    protocol: registration.protocol,
    root: registration.endpoint,
    port: portOf(registration.endpoint),
    source: "registry",
    auth: registration.credential.kind === "none" ? "none" : "key",
    fingerprint: null,
    version: null,
    health,
    models: registration.models.map((spec) => marketModel(registration, spec, health)),
  };
}

function marketModel(
  registration: ProviderRegistration,
  spec: ModelSpec,
  health: MarketHealthReading,
): MarketModelRow {
  const record = declaredRecord(registration, spec.id, health.checkedAt);
  const classes = eligibleClasses(record);
  return {
    id: spec.id,
    installed: false,
    loaded: false,
    contextAllocated: knownValue(record.contextAllocated) ?? null,
    health,
    classes,
    ineligible: eligibilityOrder
      .filter((modelClass) => !classes.includes(modelClass))
      .map((modelClass) => ({
        class: modelClass,
        missing: missingFor(record, modelClass).map((missing) => missing.capability),
      })),
    license: null,
    licenseAcknowledgement: "unknown",
    cost: priceTableCost(spec.id),
  };
}

function marketHealth(
  registration: ProviderRegistration,
  answers: ProviderAnswers,
  checkedAt: string,
): MarketHealthReading {
  if (!registration.enabled) {
    return healthReading("down", "disabled in the inference registry", checkedAt);
  }
  if (registration.credential.kind === "missing") {
    return healthReading("down", `no credential (${registration.credential.expected})`, checkedAt);
  }
  const answer = answers.answerOf(registration.name);
  if (answer === undefined) return unverifiedReading(checkedAt);
  return answeredHealth(answer);
}

function unverifiedReading(checkedAt: string): MarketHealthReading {
  return {
    state: "unverified",
    resident: null,
    detail: "listed by the inference registry; unverified until it answers a turn",
    checkedAt,
  };
}

function answeredHealth(answer: ProviderAnswer): HealthReading {
  if (answer.kind === "answered") return healthReading("up", "answered a turn", answer.at);
  return healthReading("down", `refused its credential (${answer.status})`, answer.at);
}

function priceTableCost(model: string): ModelRow["cost"] | null {
  const rates = ratesFor(model);
  if (rates === undefined) return null;
  return {
    source: "price_table",
    usdPerMillionInput: rates.inputNanosPerToken / nanosPerMicroDollar,
    usdPerMillionOutput: rates.outputNanosPerToken / nanosPerMicroDollar,
  };
}

const nanosPerMicroDollar = 1_000;

function portOf(endpoint: string): number {
  try {
    const url = new URL(endpoint);
    if (url.port !== "") return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return 0;
  }
}
