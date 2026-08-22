#!/usr/bin/env bun
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  exitOnBuildInputError,
  outdirInside,
  readManifest,
  resolveBuildVersion,
} from "./build-inputs.ts";
import { npmBinPath, npmManifestFor } from "./npm-manifest.ts";
import { buildVersionDefine } from "./targets.ts";

const entrypoint = "packages/cli/src/main.ts";
const cliManifestPath = "packages/cli/package.json";
const tuiManifestPath = "packages/tui/package.json";
const bundledAlongside = ["LICENSE.md", "NOTICE", "README.md"];

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    outdir: { type: "string", default: "dist/npm" },
    version: { type: "string" },
    "skip-smoke": { type: "boolean", default: false },
  },
});

const { version, outdir } = exitOnBuildInputError(() => ({
  version: resolveBuildVersion({
    manifest: readManifest(cliManifestPath),
    manifestPath: cliManifestPath,
    override: values.version,
  }),
  outdir: outdirInside("dist", values.outdir),
}));
const opentuiVersion = dependencyVersion(tuiManifestPath, "@opentui/core");
const treeSitterVersion = lockedVersion("web-tree-sitter");
rmSync(outdir, { recursive: true, force: true });
mkdirSync(dirname(join(outdir, npmBinPath)), { recursive: true });

console.log(
  `bundling keywork ${version} for npm (bun runtime, @opentui/core ${opentuiVersion} external)`,
);
const build = Bun.spawnSync(
  [
    "bun",
    "build",
    "--target",
    "bun",
    ...buildVersionDefine(version),
    "--external",
    "@opentui/core",
    "--external",
    "@opentui/core/*",
    "--external",
    "web-tree-sitter",
    entrypoint,
    "--outfile",
    join(outdir, npmBinPath),
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
ensureBunShebang(join(outdir, npmBinPath));

const manifest = npmManifestFor({ version, opentuiVersion, treeSitterVersion });
writeFileSync(join(outdir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
for (const file of bundledAlongside) copyFileSync(file, join(outdir, file));

if (!values["skip-smoke"]) {
  console.log("smoke: installing the package's own dependencies, then running --version");
  const install = Bun.spawnSync(["bun", "install", "--no-save", "--production"], {
    cwd: outdir,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (install.exitCode !== 0) process.exit(install.exitCode ?? 1);
  const expected = `keywork ${version}`;
  const smoke = Bun.spawnSync(["bun", npmBinPath, "--version"], {
    cwd: outdir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const printed = new TextDecoder().decode(smoke.stdout).trim();
  rmSync(join(outdir, "node_modules"), { recursive: true, force: true });
  if (smoke.exitCode !== 0 || printed !== expected) {
    console.error(
      `smoke failed: bin exited ${smoke.exitCode} with "${printed}" (wanted "${expected}")`,
    );
    console.error(new TextDecoder().decode(smoke.stderr));
    process.exit(1);
  }
  console.log(`smoke ok: ${printed}`);
}
console.log(`wrote ${outdir} (publish with: cd ${values.outdir} && npm publish --access public)`);

function dependencyVersion(path: string, name: string): string {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const pinned = manifest.dependencies?.[name];
  if (pinned === undefined) throw new Error(`${path} does not depend on ${name}`);
  return pinned;
}

function lockedVersion(name: string): string {
  const lock = readFileSync("bun.lock", "utf8");
  const match = new RegExp(`"${name}@(\\d+\\.\\d+\\.\\d+)"`).exec(lock);
  if (match?.[1] === undefined) throw new Error(`bun.lock does not pin ${name}`);
  return match[1];
}

function ensureBunShebang(path: string): void {
  const source = readFileSync(path, "utf8");
  if (source.startsWith("#!")) return;
  writeFileSync(path, `#!/usr/bin/env bun\n${source}`);
}
