import { z } from "zod";
import {
  type CommandOccurrence,
  type RecurringSequence,
  recurringSequences,
  skillProposalFor,
} from "../../skills/genesis.ts";
import type { MemoryStore } from "../store.ts";
import { botGenesisFile } from "./registry.ts";

export interface SkillGenesisReport {
  proposed: string[];
  remembered: string[];
}

export async function proposeSkillGenesis(store: MemoryStore): Promise<SkillGenesisReport> {
  const remembered = await rememberedFingerprints(store);
  const fresh = recurringSequences(await craftOccurrences(store)).filter(
    (sequence) => !remembered.includes(sequence.fingerprint),
  );
  if (fresh.length === 0) return { proposed: [], remembered };
  await store.propose(fresh.map(skillProposalFor));
  const proposed = fresh.map(fingerprintOf);
  const kept = [...remembered, ...proposed];
  await store.writeReserved(botGenesisFile, `${JSON.stringify({ fingerprints: kept }, null, 2)}\n`);
  await store.recordAudit(`skill genesis: proposed ${proposed.length}`);
  return { proposed, remembered: kept };
}

export async function rememberedFingerprints(store: MemoryStore): Promise<string[]> {
  const raw = await store.readReserved(botGenesisFile);
  if (raw === null) return [];
  const parsed = ledgerSchema.safeParse(parseJson(raw));
  return parsed.success ? parsed.data.fingerprints : [];
}

const ledgerSchema = z.object({ fingerprints: z.array(z.string()) });

function fingerprintOf(sequence: RecurringSequence): string {
  return sequence.fingerprint;
}

async function craftOccurrences(store: MemoryStore): Promise<CommandOccurrence[]> {
  const occurrences: CommandOccurrence[] = [];
  for (const date of await store.listDailyDates()) {
    (await store.readDaily(date)).forEach((entry, index) => {
      if (entry.provenance === "untrusted") return;
      occurrences.push({ id: `${date}#${index}`, text: entry.text });
    });
  }
  return occurrences;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
