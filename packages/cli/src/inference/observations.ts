import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { userConfigDir, writePrivateFile } from "../user-config.ts";

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

const fileName = "connections.json";

export async function readObservations(dir: string = userConfigDir()): Promise<ObservationMap> {
  const raw = await readFile(join(dir, fileName), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  if (typeof raw !== "object" || raw === null) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).flatMap(([name, value]) => {
      const observation = asObservation(value);
      return observation === undefined ? [] : [[name, observation] as const];
    }),
  );
}

export async function recordObservation(
  name: string,
  patch: ObservationPatch,
  dir: string = userConfigDir(),
): Promise<ObservationMap> {
  const existing = await readObservations(dir);
  const merged = { ...existing, [name]: observationOf({ ...existing[name], ...patch }) };
  await writeObservations(merged, dir);
  return merged;
}

export async function forgetObservation(
  name: string,
  dir: string = userConfigDir(),
): Promise<ObservationMap> {
  const { [name]: _forgotten, ...rest } = await readObservations(dir);
  await writeObservations(rest, dir);
  return rest;
}

async function writeObservations(observations: ObservationMap, dir: string): Promise<void> {
  await writePrivateFile(join(dir, fileName), `${JSON.stringify(observations, null, 2)}\n`);
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
