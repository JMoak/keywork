#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { contractVersion } from "../../packages/server/src/contract.ts";
import { exitOnBuildInputError, readManifest, resolveBuildVersion } from "./build-inputs.ts";
import { buildVersionDefine, checksumLine, hostTarget } from "./targets.ts";

const entrypoint = "packages/cli/src/main.ts";
const manifestPath = "packages/cli/package.json";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    outdir: { type: "string", default: "dist/release" },
    version: { type: "string" },
    "expect-tag": { type: "string" },
    "skip-smoke": { type: "boolean", default: false },
  },
});

const version = exitOnBuildInputError(() =>
  resolveBuildVersion({
    manifest: readManifest(manifestPath),
    manifestPath,
    override: values.version,
    expectTag: values["expect-tag"],
  }),
);

const target = hostTarget();
const outdir = resolve(values.outdir);
mkdirSync(outdir, { recursive: true });
const outfile = join(outdir, target.assetName);

console.log(`building ${target.assetName} (keywork ${version}) with bun ${Bun.version}`);
const build = Bun.spawnSync(
  ["bun", "build", "--compile", ...buildVersionDefine(version), entrypoint, "--outfile", outfile],
  { stdout: "inherit", stderr: "inherit" },
);
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

const digest = createHash("sha256").update(readFileSync(outfile)).digest("hex");
writeFileSync(`${outfile}.sha256`, checksumLine(digest, target.assetName));
console.log(`sha256 ${digest}`);

if (!values["skip-smoke"]) {
  smokeVersion(outfile, version);
  smokeCarriedRatchet(outfile);
}
console.log(`wrote ${outfile}\nwrote ${outfile}.sha256`);

function smokeVersion(binary: string, expectedVersion: string): void {
  const expected = `keywork ${expectedVersion} · contract ${contractVersion}`;
  const smoke = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  const printed = decoded(smoke.stdout).trim();
  if (smoke.exitCode !== 0 || printed !== expected) {
    failSmoke(
      `${binary} --version exited ${smoke.exitCode} with "${printed}" (wanted "${expected}")`,
      smoke.stderr,
    );
  }
  console.log(`smoke ok: ${printed}`);
}

function smokeCarriedRatchet(binary: string): void {
  const emptyHome = mkdtempSync(join(tmpdir(), "keywork-smoke-home-"));
  const smoke = runIn(emptyHome, [binary, "creatures", "report"]);
  rmSync(emptyHome, { recursive: true, force: true });
  if (smoke.exitCode !== 0) {
    failSmoke(
      `${binary} creatures report exited ${smoke.exitCode} under an empty home (the binary must carry ratchet)`,
      smoke.stderr,
    );
  }
  console.log("smoke ok: creatures report runs on the ratchet the binary carries");
}

function runIn(home: string, argv: string[]) {
  return Bun.spawnSync(argv, {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function failSmoke(problem: string, stderr: Uint8Array): never {
  console.error(`smoke failed: ${problem}`);
  console.error(decoded(stderr));
  process.exit(1);
}

function decoded(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
