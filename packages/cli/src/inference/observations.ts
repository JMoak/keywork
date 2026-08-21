import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { userConfigDir } from "../user-config.ts";

export interface ConnectionObservation {
  verifiedAt?: string;
  modelsReportedAt?: string;
  models?: readonly string[];
  lastFailure?: { at: string; reason: string };
}

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
  patch: ConnectionObservation,
  dir: string = userConfigDir(),
): Promise<ObservationMap> {
  const existing = await readObservations(dir);
  const merged = { ...existing, [name]: { ...existing[name], ...patch } };
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
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, fileName);
  await writeFile(file, `${JSON.stringify(observations, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(file, 0o600);
}

function asObservation(value: unknown): ConnectionObservation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  const models = Array.isArray(fields.models)
    ? fields.models.filter((model): model is string => typeof model === "string")
    : undefined;
  const failure = fields.lastFailure as Record<string, unknown> | undefined;
  return {
    ...(typeof fields.verifiedAt === "string" && { verifiedAt: fields.verifiedAt }),
    ...(typeof fields.modelsReportedAt === "string" && {
      modelsReportedAt: fields.modelsReportedAt,
    }),
    ...(models !== undefined && { models }),
    ...(typeof failure?.at === "string" &&
      typeof failure.reason === "string" && {
        lastFailure: { at: failure.at, reason: failure.reason },
      }),
  };
}
