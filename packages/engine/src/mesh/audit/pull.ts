import type { MeshClient } from "../pairing/client.ts";
import type { PairRecord } from "../pairing/store.ts";
import { type AuditRow, type AuditVerdict, genesisHash, verifyAuditChain } from "./log.ts";

export const meshAuditPath = "/mesh/audit";

export interface PulledAudit {
  node: string;
  rows: AuditRow[];
  verdict: AuditVerdict;
}

export async function pullAudit(
  client: Pick<MeshClient, "send">,
  pair: PairRecord,
  after?: string,
): Promise<PulledAudit> {
  const query = after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
  const response = await client.send(pair, "GET", `${meshAuditPath}${query}`);
  if (!response.ok)
    throw new Error(`${pair.peerStableId} refused the audit pull: ${response.status}`);
  const { rows } = (await response.json()) as { rows: AuditRow[] };
  return { node: pair.peerStableId, rows, verdict: verifyAuditChain(rows, after ?? genesisHash) };
}
