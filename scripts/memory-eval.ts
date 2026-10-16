#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { judgeRole } from "../packages/cli/src/inference/roles.ts";
import { openInferenceState } from "../packages/cli/src/inference-state.ts";
import { repoRoot } from "./lib/repo-files.ts";
import { armNames, isArmName, openArm } from "./memory-eval/arms.ts";
import { writeCassette } from "./memory-eval/cassette.ts";
import { corpusDigest, fixtureCorpusDir, readCorpus } from "./memory-eval/corpus.ts";
import { environmentSecrets } from "./memory-eval/exposure.ts";
import { defaultActionBudget, harvestCorpus, writeHarvest } from "./memory-eval/harvest.ts";
import { chatJudge, type Judge } from "./memory-eval/judge.ts";
import { answersOf } from "./memory-eval/metrics.ts";
import { builtinArm, builtinEdition, editionName, offArm, runArm } from "./memory-eval/replay.ts";
import { formatReport } from "./memory-eval/report.ts";
import { type Run, readRuns, writeRun } from "./memory-eval/runs.ts";

const usage = `usage: bun run memory:eval <verb> [options]

  harvest --sessions <dir> --vault <dir> --out <dir> [--no-judge] [--action-tokens <n>]
      rebuild decision points and labels from recorded sessions and the vault as it stood
  run --decider ${armNames.join("|")} [--corpus <dir>] [--out <dir>] [--record]
      replay every decision point through one decider (jev replays its cassette)
  report --run <dir> [--corpus <dir>] [--write <dir>]
      print the measures, the gate and every disagreement for each decider in a run`;

const [verb, ...rest] = process.argv.slice(2);
switch (verb) {
  case "harvest":
    await harvest(rest);
    break;
  case "run":
    await run(rest);
    break;
  case "report":
    await report(rest);
    break;
  default:
    fail(usage);
}

async function harvest(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      sessions: { type: "string" },
      vault: { type: "string" },
      out: { type: "string" },
      "no-judge": { type: "boolean", default: false },
      "action-tokens": { type: "string" },
    },
  });
  const sessions = required(values.sessions, "--sessions");
  const vault = required(values.vault, "--vault");
  const out = required(values.out, "--out");
  const opened = values["no-judge"] ? { absence: "--no-judge was given" } : await openJudge();
  const secrets = environmentSecrets(process.env);
  const harvested = await harvestCorpus({
    sessions,
    vault,
    secrets,
    budget: { ...defaultActionBudget, ...actionTokens(values["action-tokens"]) },
    ...("judge" in opened ? { judge: opened.judge } : { judgeAbsence: opened.absence }),
  });
  await writeHarvest(out, harvested, vault, secrets);
  const { manifest } = harvested;
  console.log(
    `harvested ${harvested.points.length} decision points from ${manifest.sessions} sessions into ${out}`,
  );
  console.log(
    manifest.judge.ran
      ? `judge: ${manifest.judge.judge}`
      : `judge skipped: ${manifest.judge.reason}`,
  );
  for (const session of manifest.reproduction)
    console.log(
      `${session.reproduced ? "reproduced" : "differs   "} ${session.session}: ${session.detail}`,
    );
}

async function run(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      decider: { type: "string" },
      corpus: { type: "string", default: fixtureCorpusDir },
      out: { type: "string", default: join("artifacts", "memory-eval", stamp()) },
      record: { type: "boolean", default: false },
    },
  });
  const name = required(values.decider, "--decider");
  if (!isArmName(name)) fail(`--decider wants one of ${armNames.join(", ")}, got ${name}`);
  const corpus = await readCorpus(values.corpus);
  const opened = await openArm(name, {
    corpusDir: values.corpus,
    points: corpus.points,
    env: process.env,
    record: values.record,
  });
  const record = {
    corpus: shown(values.corpus),
    corpusDigest: corpusDigest(corpus.points),
    points: corpus.points.length,
  };
  if (opened.kind === "skipped") {
    await writeRun(values.out, {
      record: { ...record, edition: opened.edition, skipped: opened.reason },
      answers: [],
    });
    console.log(`${editionName(opened.edition)} skipped: ${opened.reason}`);
    return;
  }
  const answers = await runArm(opened.arm, corpus.points);
  await writeRun(values.out, {
    record: { ...record, edition: opened.arm.edition, source: opened.source },
    answers,
  });
  if (opened.cassette !== undefined) await writeCassette(opened.cassette, answers);
  console.log(
    `${editionName(opened.arm.edition)} answered ${answers.length} decision points into ${values.out}`,
  );
}

async function report(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      run: { type: "string" },
      corpus: { type: "string", default: fixtureCorpusDir },
      write: { type: "string" },
    },
  });
  const runs = await readRuns(required(values.run, "--run"));
  if (runs.length === 0) fail(`no runs in ${values.run}`);
  const corpus = await readCorpus(values.corpus);
  const digest = corpusDigest(corpus.points);
  const builtin = runs.find(
    (candidate) => editionName(candidate.record.edition) === editionName(builtinEdition),
  );
  const builtinAnswers = answersOf(builtin?.answers ?? (await runArm(builtinArm(), corpus.points)));
  const off = answersOf(await runArm(offArm(), corpus.points));
  for (const each of runs) {
    if (each.record.corpusDigest !== digest)
      fail(
        `${editionName(each.record.edition)} answered corpus ${each.record.corpusDigest}, not ${digest}`,
      );
    const markdown = formatReport({
      corpus,
      corpusName: shown(values.corpus),
      run: each,
      builtin: builtinAnswers,
      off,
    });
    if (values.write === undefined) console.log(markdown);
    else console.log(`wrote ${await writeReport(values.write, each, markdown)}`);
  }
}

async function writeReport(dir: string, each: Run, markdown: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${editionName(each.record.edition)}.md`);
  await writeFile(file, markdown, "utf8");
  return file;
}

async function openJudge(): Promise<{ judge: Judge } | { absence: string }> {
  try {
    const live = await openInferenceState({
      cwd: process.cwd(),
      projectTrusted: false,
      env: process.env,
      warn: () => {},
    });
    const { config, runtime } = live.current();
    const role = config.roles?.[judgeRole];
    const bound = runtime.open(
      role === undefined ? { default: config.model } : { selection: role },
    );
    return { judge: chatJudge(bound.provider, bound.reference) };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message.split("\n", 1)[0] : String(cause);
    return {
      absence: `no chat model resolved for roles.${judgeRole} or the default model (${reason})`,
    };
  }
}

function actionTokens(raw: string | undefined): { tokens?: number } {
  if (raw === undefined) return {};
  const tokens = Number(raw);
  if (!Number.isInteger(tokens) || tokens < 0)
    fail(`--action-tokens wants a whole number, got ${raw}`);
  return { tokens };
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined) fail(`${flag} is required\n\n${usage}`);
  return value;
}

function shown(path: string): string {
  return relative(repoRoot, resolve(path)).split("\\").join("/");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
