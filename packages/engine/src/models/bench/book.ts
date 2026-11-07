import { createHash } from "node:crypto";
import { join } from "node:path";
import { jsonFileStore } from "@keywork/shared";
import { z } from "zod";
import type { Provider } from "../../provider.ts";
import { serverRootOf } from "../adapters/http.ts";
import type { ServerFingerprint } from "../capabilities/index.ts";
import type { Decider } from "../decide/types.ts";
import { readLabelledDecisions } from "./labelled.ts";
import { type BenchReport, type LabelledDecision, runChatBench, runDecideBench } from "./run.ts";
import { type BenchTrace, readBenchTrace } from "./trace.ts";

export interface BenchTarget {
  endpoint: string;
  model: string;
}

export type BenchSubject =
  | { kind: "chat"; provider: Provider }
  | { kind: "decide"; decider: Decider };

export type BenchRefusal = "busy" | "missing" | "unreachable" | "unrecognized" | "failed";

export type BenchOpening =
  | {
      ok: true;
      reference: string;
      fingerprint: ServerFingerprint;
      subject: BenchSubject;
      measured?: ((report: BenchReport) => void) | undefined;
    }
  | { ok: false; refused: BenchRefusal; error: string };

export type BenchOpener = (target: BenchTarget) => Promise<BenchOpening | undefined>;

export type BenchOutcome = { report: BenchReport } | { refused: BenchRefusal; error: string };

export interface BenchRecord {
  endpoint: string;
  model: string;
  ranAt: string;
  report: BenchReport;
}

export interface BenchBook {
  run(target: BenchTarget): Promise<BenchOutcome>;
  last(target: BenchTarget): Promise<BenchReport | null>;
}

export interface BenchBookOptions {
  openers: readonly BenchOpener[];
  dir?: string | undefined;
  repeats?: number | undefined;
  trace?: (() => Promise<BenchTrace>) | undefined;
  labelled?: (() => Promise<readonly LabelledDecision[]>) | undefined;
  clock?: (() => number) | undefined;
  now?: (() => Date) | undefined;
}

export function modelBenchDir(stateDir: string): string {
  return join(stateDir, "models", "bench");
}

export function benchBook(options: BenchBookOptions): BenchBook {
  const shelf = options.dir === undefined ? memoryShelf() : fileShelf(options.dir);
  const now = options.now ?? (() => new Date());
  const running = new Set<string>();
  return {
    run: async (target) => {
      const key = benchKey(target);
      if (running.has(key)) {
        return { refused: "busy", error: `${target.model} is already on the bench` };
      }
      running.add(key);
      try {
        const outcome = await benchOnce(target, options);
        if ("report" in outcome) {
          shelf.put(key, { ...target, ranAt: now().toISOString(), report: outcome.report });
        }
        return outcome;
      } finally {
        running.delete(key);
      }
    },
    last: async (target) => shelf.get(benchKey(target))?.report ?? null,
  };
}

async function benchOnce(target: BenchTarget, options: BenchBookOptions): Promise<BenchOutcome> {
  const opened = await openedBy(options.openers, target);
  if (!opened.ok) return { refused: opened.refused, error: opened.error };
  try {
    const report = await reportOf(opened, options);
    opened.measured?.(report);
    return { report };
  } catch (cause) {
    return { refused: "failed", error: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function openedBy(
  openers: readonly BenchOpener[],
  target: BenchTarget,
): Promise<BenchOpening> {
  for (const open of openers) {
    const opened = await open(target);
    if (opened !== undefined) return opened;
  }
  return {
    ok: false,
    refused: "unrecognized",
    error: `nothing on this node knows how to bench ${target.endpoint}`,
  };
}

async function reportOf(
  opened: Extract<BenchOpening, { ok: true }>,
  options: BenchBookOptions,
): Promise<BenchReport> {
  const { reference, fingerprint, subject } = opened;
  const shared = { reference, fingerprint, repeats: options.repeats, clock: options.clock };
  if (subject.kind === "decide") {
    const rows = await (options.labelled ?? (() => readLabelledDecisions()))();
    return runDecideBench({ ...shared, decider: subject.decider, rows });
  }
  const trace = await (options.trace ?? (() => readBenchTrace()))();
  return runChatBench({ ...shared, provider: subject.provider, trace });
}

function benchKey({ endpoint, model }: BenchTarget): string {
  return createHash("sha256")
    .update(`${serverRootOf(endpoint)}\n${model}`)
    .digest("hex")
    .slice(0, 32);
}

interface BenchShelf {
  get(key: string): BenchRecord | undefined;
  put(key: string, record: BenchRecord): void;
}

function memoryShelf(): BenchShelf {
  const records = new Map<string, BenchRecord>();
  return {
    get: (key) => records.get(key),
    put: (key, record) => {
      records.set(key, record);
    },
  };
}

function fileShelf(dir: string): BenchShelf {
  const storeOf = (key: string) =>
    jsonFileStore<BenchRecord | undefined>({
      file: join(dir, `${key}.json`),
      mode: "lenient",
      validate: benchRecordOf,
    });
  return {
    get: (key) => storeOf(key).read(),
    put: (key, record) => storeOf(key).write(record),
  };
}

const benchRecordSchema = z.object({
  endpoint: z.string(),
  model: z.string(),
  ranAt: z.string(),
  report: z.looseObject({
    kind: z.enum(["chat", "decide"]),
    reference: z.string(),
    fingerprint: z.looseObject({ id: z.string(), kind: z.string() }),
  }),
});

function benchRecordOf(data: unknown): BenchRecord | undefined {
  return benchRecordSchema.safeParse(data).success ? (data as BenchRecord) : undefined;
}
