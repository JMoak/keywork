import {
  type BenchReport,
  type Decider,
  formatBenchReport,
  minimumRepeats,
  type Provider,
  readBenchTrace,
  readLabelledDecisions,
  runChatBench,
  runDecideBench,
  type ServerFingerprint,
} from "@keywork/engine";
import { type CommandIo, resolveCommandIo } from "../command-io.ts";
import { exitCodes } from "../dispatch.ts";

export const modelsUsage = [
  "usage: keywork models bench <provider/model> [--repeats <n>] [--json]",
  "       keywork models bench <provider/model> --decide [--repeats <n>] [--json]",
].join("\n");

export type BenchOpening<Subject> =
  | { ok: true; reference: string; fingerprint: ServerFingerprint; subject: Subject }
  | { ok: false; reason: string };

export interface ModelsCommandDeps {
  openChat(reference: string): BenchOpening<Provider>;
  openDecider(reference: string): BenchOpening<Decider>;
  clock?: (() => number) | undefined;
  tracePath?: string | undefined;
  labelledPath?: string | undefined;
}

export interface ModelsCommandFlags {
  repeats?: string | undefined;
  decide?: boolean | undefined;
  json?: boolean | undefined;
}

export async function modelsCommand(
  args: readonly string[],
  deps: ModelsCommandDeps,
  io: CommandIo = {},
  flags: ModelsCommandFlags = {},
): Promise<number> {
  const { print, printError } = resolveCommandIo(io);
  const [subcommand, reference, ...extra] = args;
  if (subcommand !== "bench" || reference === undefined || extra.length > 0) {
    printError(modelsUsage);
    return exitCodes.usage;
  }
  const repeats = repeatsFrom(flags.repeats);
  if (repeats === undefined) {
    printError(`--repeats takes a whole number of at least ${minimumRepeats}`);
    return exitCodes.usage;
  }
  const benched = flags.decide
    ? await benchDecider(reference, repeats, deps)
    : await benchChat(reference, repeats, deps);
  if (!benched.ok) {
    printError(`keywork models bench: ${benched.reason}`);
    return exitCodes.unresolved;
  }
  print(
    flags.json
      ? JSON.stringify(benched.report, null, 2)
      : formatBenchReport(benched.report).trimEnd(),
  );
  return exitCodes.completed;
}

type Benched = { ok: true; report: BenchReport } | { ok: false; reason: string };

async function benchChat(
  reference: string,
  repeats: number,
  deps: ModelsCommandDeps,
): Promise<Benched> {
  const opened = deps.openChat(reference);
  if (!opened.ok) return opened;
  const report = await runChatBench({
    reference: opened.reference,
    fingerprint: opened.fingerprint,
    provider: opened.subject,
    trace: await readBenchTrace(deps.tracePath),
    repeats,
    clock: deps.clock,
  });
  return { ok: true, report };
}

async function benchDecider(
  reference: string,
  repeats: number,
  deps: ModelsCommandDeps,
): Promise<Benched> {
  const opened = deps.openDecider(reference);
  if (!opened.ok) return opened;
  const report = await runDecideBench({
    reference: opened.reference,
    fingerprint: opened.fingerprint,
    decider: opened.subject,
    rows: await readLabelledDecisions(deps.labelledPath),
    repeats,
    clock: deps.clock,
  });
  return { ok: true, report };
}

function repeatsFrom(text: string | undefined): number | undefined {
  if (text === undefined) return minimumRepeats;
  if (!/^\d+$/.test(text)) return undefined;
  const repeats = Number(text);
  return repeats >= minimumRepeats ? repeats : undefined;
}
