import { join } from "node:path";
import { type JsonFileStore, jsonFileStore } from "@keywork/shared";
import { userConfigDir } from "../user-config.ts";

export interface ConnectionObservation {
  verifiedAt?: string;
  modelsReportedAt?: string;
  models?: readonly string[];
  lastFailure?: ConnectionFailure;
}

export interface ConnectionFailure {
  at: string;
  reason: string;
}

export type ObservationPatch = {
  [Field in keyof ConnectionObservation]?: ConnectionObservation[Field] | undefined;
};

export type ObservationMap = Readonly<Record<string, ConnectionObservation>>;

export async function readObservations(dir: string = userConfigDir()): Promise<ObservationMap> {
  return observationStore(dir).read() ?? {};
}

export async function recordObservation(
  name: string,
  patch: ObservationPatch,
  dir: string = userConfigDir(),
): Promise<ObservationMap> {
  const store = observationStore(dir);
  const existing = store.read() ?? {};
  const merged = { ...existing, [name]: observationOf({ ...existing[name], ...patch }) };
  store.write(merged);
  return merged;
}

export async function forgetObservation(
  name: string,
  dir: string = userConfigDir(),
): Promise<ObservationMap> {
  const store = observationStore(dir);
  const { [name]: _forgotten, ...rest } = store.read() ?? {};
  store.write(rest);
  return rest;
}

function observationStore(dir: string): JsonFileStore<ObservationMap> {
  return jsonFileStore<ObservationMap>({
    file: join(dir, "connections.json"),
    mode: "lenient",
    private: true,
    validate: onlyObservationEntries,
  });
}

function onlyObservationEntries(data: unknown): ObservationMap {
  if (typeof data !== "object" || data === null) return {};
  return Object.fromEntries(
    Object.entries(data as Record<string, unknown>).flatMap(([name, value]) => {
      const observation = asObservation(value);
      return observation === undefined ? [] : [[name, observation] as const];
    }),
  );
}

function observationOf(fields: ObservationPatch): ConnectionObservation {
  return {
    ...(fields.verifiedAt !== undefined && { verifiedAt: fields.verifiedAt }),
    ...(fields.modelsReportedAt !== undefined && { modelsReportedAt: fields.modelsReportedAt }),
    ...(fields.models !== undefined && { models: fields.models }),
    ...(fields.lastFailure !== undefined && { lastFailure: fields.lastFailure }),
  };
}

function asObservation(value: unknown): ConnectionObservation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  return observationOf({
    verifiedAt: asString(fields.verifiedAt),
    modelsReportedAt: asString(fields.modelsReportedAt),
    models: Array.isArray(fields.models) ? fields.models.filter(isString) : undefined,
    lastFailure: asFailure(fields.lastFailure),
  });
}

function asFailure(value: unknown): ConnectionFailure | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { at, reason } = value as Record<string, unknown>;
  return isString(at) && isString(reason) ? { at, reason } : undefined;
}

function asString(value: unknown): string | undefined {
  return isString(value) ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
