import { join } from "node:path";
import { type Disk, jsonFileStore } from "@keywork/shared";
import { z } from "zod";
import type { KeyStore } from "./keys.ts";
import type { Owner } from "./machine.ts";
import { confirmations } from "./wire.ts";

export const peerRoles = ["console", "node", "target"] as const;

export type PeerRole = (typeof peerRoles)[number];

export interface PairRecord {
  id: string;
  peerStableId: string;
  peerUserId: string | null;
  peerTags: string[];
  peerDeviceKey: string;
  role: PeerRole;
  caps: string[];
  endpoint: string | null;
  createdAt: string;
  confirmedBy: (typeof confirmations)[number];
}

export interface PairingRecords {
  owner: Owner | null;
  pairs: PairRecord[];
}

export interface PairStore {
  read(): PairingRecords;
  write(records: PairingRecords): void;
}

export const emptyPairing: PairingRecords = { owner: null, pairs: [] };

export function memoryPairStore(initial: PairingRecords = emptyPairing): PairStore {
  let held = structuredClone(initial);
  return {
    read: () => structuredClone(held),
    write: (records) => {
      held = structuredClone(records);
    },
  };
}

export function meshPairingFile(stateDir: string): string {
  return join(stateDir, "mesh", "pairing.json");
}

export function filePairStore(file: string, disk?: Disk): PairStore {
  const store = jsonFileStore<PairingRecords>({
    file,
    mode: "strict",
    private: true,
    validate: (data) => pairingRecordsSchema.parse(data),
    error: (path, detail) => new Error(`mesh pairing file ${path} is ${detail}`),
    disk,
  });
  return {
    read: () => store.read() ?? structuredClone(emptyPairing),
    write: (records) => store.write(records),
  };
}

export function pairSecretName(pairId: string): string {
  return `mesh.pair.${pairId}`;
}

export async function savePairSecret(
  keys: KeyStore,
  pairId: string,
  secret: Buffer,
): Promise<void> {
  await keys.write(pairSecretName(pairId), secret.toString("base64url"));
}

export async function pairSecretOf(keys: KeyStore, pairId: string): Promise<Buffer | undefined> {
  const saved = await keys.read(pairSecretName(pairId));
  return saved === undefined ? undefined : Buffer.from(saved, "base64url");
}

export function withPair(records: PairingRecords, pair: PairRecord): PairingRecords {
  const others = records.pairs.filter(
    (held) =>
      held.id !== pair.id && !(held.peerStableId === pair.peerStableId && held.role === pair.role),
  );
  return { ...records, pairs: [...others, pair] };
}

export function withoutPair(records: PairingRecords, pairId: string): PairingRecords {
  return { ...records, pairs: records.pairs.filter((held) => held.id !== pairId) };
}

const ownerSchema = z.object({
  tailnetId: z.string().min(1),
  userId: z.string().min(1),
  claimedAt: z.string(),
});

const pairRecordSchema = z.object({
  id: z.string().min(1),
  peerStableId: z.string().min(1),
  peerUserId: z.string().nullable(),
  peerTags: z.array(z.string()),
  peerDeviceKey: z.string().min(1),
  role: z.enum(peerRoles),
  caps: z.array(z.string()),
  endpoint: z.string().nullable(),
  createdAt: z.string(),
  confirmedBy: z.enum(confirmations),
});

const pairingRecordsSchema = z.object({
  owner: ownerSchema.nullable(),
  pairs: z.array(pairRecordSchema),
});
