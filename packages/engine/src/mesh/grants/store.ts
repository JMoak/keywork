import { join } from "node:path";
import { type Disk, jsonFileStore } from "@keywork/shared";
import { z } from "zod";
import { type Grant, grantSchema, holdsScreenControl } from "./grant.ts";
import { type Revocation, revocationSchema } from "./revocation.ts";

export interface RevokedGrant {
  id: string;
  until: string;
}

export interface UndeliveredRevocation {
  revocation: Revocation;
  endpoint: string;
  attempts: number;
}

export interface GrantRecords {
  installed: Grant[];
  issued: Grant[];
  revoked: RevokedGrant[];
  outbox: UndeliveredRevocation[];
}

export interface GrantStore {
  read(): GrantRecords;
  write(records: GrantRecords): void;
}

export const emptyGrants: GrantRecords = { installed: [], issued: [], revoked: [], outbox: [] };

export function memoryGrantStore(initial: GrantRecords = emptyGrants): GrantStore {
  let held = structuredClone(initial);
  return {
    read: () => structuredClone(held),
    write: (records) => {
      held = structuredClone(records);
    },
  };
}

export function meshGrantsFile(stateDir: string): string {
  return join(stateDir, "mesh", "grants.json");
}

export function fileGrantStore(file: string, disk?: Disk): GrantStore {
  const store = jsonFileStore<GrantRecords>({
    file,
    mode: "strict",
    private: true,
    validate: (data) => grantRecordsSchema.parse(data),
    error: (path, detail) => new Error(`mesh grants file ${path} is ${detail}`),
    disk,
  });
  return {
    read: () => store.read() ?? structuredClone(emptyGrants),
    write: (records) => store.write(records),
  };
}

export function durableGrants(records: GrantRecords): GrantRecords {
  const durable = (grant: Grant) => !holdsScreenControl(grant);
  return {
    ...records,
    installed: records.installed.filter(durable),
    issued: records.issued.filter(durable),
  };
}

export function prunedGrants(records: GrantRecords, now: number): GrantRecords {
  const unexpired = (grant: Grant) => Date.parse(grant.expiresAt) > now;
  return {
    ...records,
    installed: records.installed.filter(unexpired),
    issued: records.issued.filter(unexpired),
    revoked: records.revoked.filter(({ until }) => Date.parse(until) > now),
  };
}

const grantRecordsSchema = z.object({
  installed: z.array(grantSchema),
  issued: z.array(grantSchema),
  revoked: z.array(z.object({ id: z.string(), until: z.string() })),
  outbox: z.array(
    z.object({ revocation: revocationSchema, endpoint: z.string(), attempts: z.number().int() }),
  ),
});
