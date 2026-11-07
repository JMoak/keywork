import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMissingFileError } from "../memory/vault-files.ts";
import type { RunRow } from "./run.ts";

export type OccurrenceKind = "file-watch" | "webhook" | "event";

export interface TriggerPayload {
  kind: OccurrenceKind;
  receivedAt: string;
  data: unknown;
}

export interface PayloadRef {
  file: string;
  bytes: number;
}

type RunIdentity = Pick<RunRow, "creature" | "routineId" | "runId">;

export function payloadFileOf(outputsDir: string, run: RunIdentity): string {
  return join(outputsDir, run.creature, run.routineId, `${run.runId}.trigger.json`);
}

export async function savePayload(
  outputsDir: string,
  run: RunIdentity,
  payload: TriggerPayload,
): Promise<PayloadRef> {
  const file = payloadFileOf(outputsDir, run);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
  return { file, bytes: Buffer.byteLength(text) };
}

export async function payloadRefOf(
  outputsDir: string,
  run: RunIdentity,
): Promise<PayloadRef | undefined> {
  const file = payloadFileOf(outputsDir, run);
  try {
    return { file, bytes: (await stat(file)).size };
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}
