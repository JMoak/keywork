import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export interface ProjectShape {
  readonly root: string;
  readonly packageManager: PackageManager;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: ReadonlySet<string>;
  readonly files: ReadonlySet<string>;
}

export interface Resolution {
  readonly tool: string;
  readonly command: string;
  readonly reason: string;
}

export async function inspectProject(root: string): Promise<ProjectShape> {
  const files = new Set(await entriesOf(root));
  const manifest = await readManifest(join(root, "package.json"));
  return {
    root,
    packageManager: packageManagerOf(manifest, files),
    scripts: manifest.scripts,
    dependencies: manifest.dependencies,
    files,
  };
}

export function typecheckCommand(project: ProjectShape): Resolution {
  const script = scriptRunning(project, "tsc", ["check:types", "typecheck", "tsc", "check"]);
  if (script !== undefined) return script;
  if (project.dependencies.has("typescript") || project.files.has("tsconfig.json")) {
    return {
      tool: "tsc",
      command: `${execPrefix(project.packageManager)} tsc --noEmit`,
      reason: "typescript is installed and no package script wraps tsc",
    };
  }
  return nothingFound("no tsconfig.json and typescript is not a dependency");
}

export function lintCommand(project: ProjectShape): Resolution {
  const script = scriptRunning(project, ["biome", "eslint"], ["lint"]);
  if (script !== undefined) return script;
  if (usesBiome(project)) {
    return {
      tool: "biome",
      command: `${execPrefix(project.packageManager)} biome check .`,
      reason: "@biomejs/biome is installed or a biome config is present",
    };
  }
  if (usesEslint(project)) {
    return {
      tool: "eslint",
      command: `${execPrefix(project.packageManager)} eslint .`,
      reason: "eslint is installed or an eslint config is present",
    };
  }
  return nothingFound("neither biome nor eslint is installed or configured");
}

export function testCommand(project: ProjectShape): Resolution {
  const script = scriptRunning(project, ["vitest", "bun test"], ["test"]);
  if (script !== undefined) return script;
  if (usesVitest(project)) {
    return {
      tool: "vitest",
      command: `${execPrefix(project.packageManager)} vitest run`,
      reason: "vitest is installed or a vitest config is present",
    };
  }
  if (project.packageManager === "bun") {
    return { tool: "bun test", command: "bun test", reason: "bun lockfile and no vitest" };
  }
  return nothingFound("no vitest and no bun lockfile");
}

export function report(resolution: Resolution): string {
  return [
    `tool: ${resolution.tool}`,
    `command: ${resolution.command}`,
    `reason: ${resolution.reason}`,
  ].join("\n");
}

export async function printResolution(
  resolve: (project: ProjectShape) => Resolution,
  root: string = process.argv[2] ?? process.cwd(),
): Promise<void> {
  console.log(report(resolve(await inspectProject(root))));
}

interface Manifest {
  readonly packageManager: string | undefined;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: ReadonlySet<string>;
}

const emptyManifest: Manifest = {
  packageManager: undefined,
  scripts: {},
  dependencies: new Set(),
};

const lockfiles: ReadonlyArray<readonly [string, PackageManager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

const biomeConfigs = ["biome.json", "biome.jsonc"];
const eslintConfigPrefixes = ["eslint.config.", ".eslintrc"];
const vitestConfigPrefix = "vitest.config.";
const vitestWorkspacePrefix = "vitest.workspace.";
const npmPlaceholderTest = "no test specified";

function scriptRunning(
  project: ProjectShape,
  tool: string | readonly string[],
  preferredNames: readonly string[],
): Resolution | undefined {
  const tools = typeof tool === "string" ? [tool] : tool;
  const runs = (value: string) => tools.some((needle) => value.includes(needle));
  const name = preferredNames.find((candidate) => {
    const value = project.scripts[candidate];
    return value !== undefined && runs(value) && !value.includes(npmPlaceholderTest);
  });
  if (name === undefined) return undefined;
  const value = project.scripts[name] ?? "";
  return {
    tool: tools.find((needle) => value.includes(needle)) ?? tools[0] ?? "",
    command: `${runPrefix(project.packageManager)} ${name}`,
    reason: `package.json script "${name}" runs ${value}`,
  };
}

function usesBiome(project: ProjectShape): boolean {
  return (
    project.dependencies.has("@biomejs/biome") ||
    biomeConfigs.some((config) => project.files.has(config))
  );
}

function usesEslint(project: ProjectShape): boolean {
  return project.dependencies.has("eslint") || hasFileStartingWith(project, eslintConfigPrefixes);
}

function usesVitest(project: ProjectShape): boolean {
  return (
    project.dependencies.has("vitest") ||
    hasFileStartingWith(project, [vitestConfigPrefix, vitestWorkspacePrefix])
  );
}

function hasFileStartingWith(project: ProjectShape, prefixes: readonly string[]): boolean {
  for (const file of project.files) {
    if (prefixes.some((prefix) => file.startsWith(prefix))) return true;
  }
  return false;
}

function packageManagerOf(manifest: Manifest, files: ReadonlySet<string>): PackageManager {
  const declared = manifest.packageManager?.split("@")[0];
  if (declared === "bun" || declared === "pnpm" || declared === "yarn" || declared === "npm") {
    return declared;
  }
  return lockfiles.find(([lockfile]) => files.has(lockfile))?.[1] ?? "npm";
}

function runPrefix(packageManager: PackageManager): string {
  return `${packageManager} run`;
}

function execPrefix(packageManager: PackageManager): string {
  switch (packageManager) {
    case "bun":
      return "bunx";
    case "pnpm":
      return "pnpm exec";
    case "yarn":
      return "yarn";
    case "npm":
      return "npx";
  }
}

function nothingFound(reason: string): Resolution {
  return { tool: "none", command: "", reason };
}

async function entriesOf(root: string): Promise<string[]> {
  try {
    return await readdir(root);
  } catch {
    return [];
  }
}

async function readManifest(file: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    return {
      packageManager: stringOf(parsed.packageManager),
      scripts: stringRecordOf(parsed.scripts),
      dependencies: new Set([
        ...Object.keys(recordOf(parsed.dependencies)),
        ...Object.keys(recordOf(parsed.devDependencies)),
      ]),
    };
  } catch {
    return emptyManifest;
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringRecordOf(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(recordOf(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
