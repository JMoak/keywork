#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildVersionDefine, checksumLine, hostTarget, tagMatchesVersion } from "./targets.ts";

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

const version = values.version ?? manifestVersion();
if (values["expect-tag"] !== undefined && !tagMatchesVersion(values["expect-tag"], version)) {
  console.error(
    `release tag ${values["expect-tag"]} does not match ${manifestPath} version ${version}; bump the manifest or retag`,
  );
  process.exit(2);
}

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
  const expected = `keywork ${version}`;
  const smoke = Bun.spawnSync([outfile, "--version"], { stdout: "pipe", stderr: "pipe" });
  const printed = new TextDecoder().decode(smoke.stdout).trim();
  if (smoke.exitCode !== 0 || printed !== expected) {
    console.error(
      `smoke failed: ${outfile} --version exited ${smoke.exitCode} with "${printed}" (wanted "${expected}")`,
    );
    console.error(new TextDecoder().decode(smoke.stderr));
    process.exit(1);
  }
  console.log(`smoke ok: ${printed}`);
}
console.log(`wrote ${outfile}\nwrote ${outfile}.sha256`);

function manifestVersion(): string {
  return (JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }).version;
}
