import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot, reportViolations } from "./lib/repo-files.ts";

export const contractSource = "packages/server/src/contract.ts";

export interface ContractFixture {
  readonly path: string;
  readonly proseKeys: readonly string[];
}

export const contractFixtures: readonly ContractFixture[] = [
  {
    path: "packages/server/src/openapi-document.fixture.json",
    proseKeys: ["summary", "description"],
  },
  { path: "packages/server/src/event-shapes.fixture.json", proseKeys: [] },
];

export type ReadFileAt = (path: string) => Promise<string | undefined>;

export async function unbumpedFixtures(
  base: ReadFileAt,
  work: ReadFileAt,
  fixtures: readonly ContractFixture[] = contractFixtures,
): Promise<string[]> {
  const before = contractVersionIn(await base(contractSource)) ?? { major: 0, minor: 0 };
  const after = contractVersionIn(await work(contractSource));
  if (after !== undefined && isLater(after, before)) return [];
  const unbumped: string[] = [];
  for (const fixture of fixtures) {
    if (await contractMoved(fixture, base, work)) unbumped.push(fixture.path);
  }
  return unbumped;
}

export function gitRevision(ref: string, root = repoRoot): ReadFileAt | undefined {
  if (git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) === undefined) {
    return undefined;
  }
  return async (path) => git(root, ["show", `${ref}:${path}`]);
}

export function workingTree(root = repoRoot): ReadFileAt {
  return (path) => readFile(join(root, path), "utf8").catch(() => undefined);
}

interface ContractVersion {
  major: number;
  minor: number;
}

function contractVersionIn(source: string | undefined): ContractVersion | undefined {
  const match = source?.match(/contractVersion\b[^=]*=\s*"(\d+)\.(\d+)"/);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function isLater(candidate: ContractVersion, than: ContractVersion): boolean {
  return candidate.major !== than.major
    ? candidate.major > than.major
    : candidate.minor > than.minor;
}

async function contractMoved(
  fixture: ContractFixture,
  base: ReadFileAt,
  work: ReadFileAt,
): Promise<boolean> {
  const before = await base(fixture.path);
  if (before === undefined) return false;
  const after = await work(fixture.path);
  return contractShape(before, fixture) !== contractShape(after, fixture);
}

function contractShape(text: string | undefined, fixture: ContractFixture): string | undefined {
  if (text === undefined) return undefined;
  return JSON.stringify(withoutProse(JSON.parse(text), fixture.proseKeys));
}

function withoutProse(value: unknown, proseKeys: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutProse(item, proseKeys));
  if (value === null || typeof value !== "object") return value;
  const kept = Object.entries(value)
    .filter(([key, field]) => !(proseKeys.includes(key) && typeof field === "string"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, field]) => [key, withoutProse(field, proseKeys)]);
  return Object.fromEntries(kept);
}

const gitOutputLimit = 64 * 1024 * 1024;

function git(root: string, args: readonly string[]): string | undefined {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: gitOutputLimit });
  return run.status === 0 ? run.stdout : undefined;
}

if (import.meta.main) {
  const ref = process.argv[2] ?? "HEAD";
  const base = gitRevision(ref);
  if (base === undefined) {
    console.error(
      `check:contract can't read ${ref}; fetch it first (a CI checkout needs fetch-depth 2)`,
    );
    process.exitCode = 1;
  } else {
    process.exitCode = reportViolations(
      {
        check: "check:contract",
        heading: `Contract fixtures changed since ${ref} with no contractVersion bump; raise it in ${contractSource} (minor adds, major removes or renames):`,
      },
      await unbumpedFixtures(base, workingTree()),
    );
  }
}
