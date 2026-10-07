import { titleKey } from "./naming.ts";
import type { MemorySearcher, SearchOutcome } from "./search.ts";
import type { NoteInput } from "./store.ts";

export type ProbeHops = "single" | "multi";

export interface ProbeCase {
  id: string;
  query: string;
  expected: string[];
  hops: ProbeHops;
}

export interface ProbeCorpus {
  notes: NoteInput[];
  cases: ProbeCase[];
}

export interface ProbeMetrics {
  k: number;
  cases: number;
  satisfied: number;
  recallAtK: number;
  missed: string[];
}

export interface ProbeComparison {
  withRecall: ProbeMetrics;
  control: ProbeMetrics;
  lift: number;
}

export interface ProbeOptions {
  k?: number;
  hops?: ProbeHops;
}

export const memoryOffControl: MemorySearcher = {
  search: async (): Promise<SearchOutcome> => ({ hits: [], source: { kind: "lexical" } }),
};

export async function runRecallProbe(
  searcher: MemorySearcher,
  cases: readonly ProbeCase[],
  options: ProbeOptions = {},
): Promise<ProbeMetrics> {
  const k = options.k ?? defaultK;
  const selected = cases.filter(
    (probe) => options.hops === undefined || probe.hops === options.hops,
  );
  const missed: string[] = [];
  for (const probe of selected) {
    const outcome = await searcher.search(probe.query, { limit: k });
    const surfaced = new Set(outcome.hits.map((hit) => titleKey(hit.note.name)));
    if (!probe.expected.every((name) => surfaced.has(titleKey(name)))) missed.push(probe.id);
  }
  const satisfied = selected.length - missed.length;
  return {
    k,
    cases: selected.length,
    satisfied,
    recallAtK: selected.length === 0 ? 0 : satisfied / selected.length,
    missed,
  };
}

export async function compareAgainstMemoryOff(
  searcher: MemorySearcher,
  cases: readonly ProbeCase[],
  options: ProbeOptions = {},
): Promise<ProbeComparison> {
  const withRecall = await runRecallProbe(searcher, cases, options);
  const control = await runRecallProbe(memoryOffControl, cases, options);
  return { withRecall, control, lift: withRecall.recallAtK - control.recallAtK };
}

export const probeCorpusStub: ProbeCorpus = {
  notes: [
    {
      title: "Package Manager",
      body: "The repo uses bun, never npm or pnpm. Install with bun install.\n",
      provenance: "user",
    },
    {
      title: "Test Runner",
      body: "The gate is vitest via bun run test; bare bun test is not the gate. See [[Package Manager]].\n",
      provenance: "user",
    },
    {
      title: "Release Pipeline",
      body: "Releases tag main after the gate passes. The gate is described in [[Test Runner]].\n",
      provenance: "agent",
    },
    {
      title: "Vault Layout",
      body: "Memory notes live under .keywork/memory as one concept per file.\n",
      provenance: "agent",
    },
  ],
  cases: [
    {
      id: "install",
      query: "how do I install dependencies",
      expected: ["Package Manager"],
      hops: "single",
    },
    {
      id: "gate",
      query: "which command is the test gate",
      expected: ["Test Runner"],
      hops: "single",
    },
    {
      id: "layout",
      query: "where do memory notes live",
      expected: ["Vault Layout"],
      hops: "single",
    },
    {
      id: "release-gate-runner",
      query: "what must pass before a release tag and which runner is it",
      expected: ["Release Pipeline", "Test Runner"],
      hops: "multi",
    },
  ],
};

const defaultK = 8;
