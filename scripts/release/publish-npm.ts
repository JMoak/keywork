import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { gt, gte, valid } from "semver";

export function verifyPublishedVersion(manifest: unknown, version: string, sha: string): void {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("name" in manifest) ||
    manifest.name !== "keywork-cli" ||
    !("version" in manifest) ||
    manifest.version !== version ||
    !("gitHead" in manifest) ||
    manifest.gitHead !== sha
  ) {
    throw new Error(`Published keywork-cli@${version} does not match source ${sha}`);
  }
}

export async function publishedVersion(
  version: string,
  request: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<unknown | undefined> {
  const response = await request(`https://registry.npmjs.org/keywork-cli/${version}`, {
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${version}`);
  return response.json();
}

export async function confirmPublishedVersion(
  version: string,
  sha: string,
  lookup: (version: string) => Promise<unknown | undefined> = publishedVersion,
  wait: (milliseconds: number) => Promise<void> = delay,
): Promise<void> {
  let pending = `npm has not indexed keywork-cli@${version}; rerun this release to verify it`;
  for (let attempt = 0; attempt < 15; attempt++) {
    const manifest = await lookup(version);
    if (manifest !== undefined) {
      verifyPublishedVersion(manifest, version, sha);
      const latest = await lookup("latest");
      const latestVersion = latest === undefined ? undefined : registryVersion(latest);
      if (latestVersion && gte(latestVersion, version)) return;
      pending = `npm latest is ${latestVersion ?? "unset"}; restore latest to ${version} or newer in npm, then rerun this release`;
    }
    if (attempt < 14) await wait(Math.min(1000 * 2 ** attempt, 10_000));
  }
  throw new Error(pending);
}

async function publish(version: string, sha: string): Promise<void> {
  const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (source !== sha) throw new Error(`Checked-out source ${source} does not match ${sha}`);
  const manifestPath = "dist/npm/package.json";
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.name !== "keywork-cli" ||
    manifest.version !== version ||
    manifest.private === true ||
    manifest.repository?.url !== "git+https://github.com/JMoak/keywork.git"
  ) {
    throw new Error("Built npm package does not match the release plan");
  }
  const existing = await publishedVersion(version);
  if (existing !== undefined) {
    verifyPublishedVersion(existing, version, sha);
    await confirmPublishedVersion(version, sha);
    console.log(`keywork-cli@${version} is already published from ${sha}`);
    return;
  }
  const latest = registryVersion(await publishedVersion("latest"));
  if (gt(latest, version)) throw new Error(`Refusing to replace npm latest ${latest}`);
  manifest.gitHead = sha;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync("npm", ["pack", "--dry-run"], { cwd: "dist/npm", stdio: "inherit" });
  execFileSync(
    "npm",
    ["publish", "--access", "public", "--tag", "latest", "--loglevel", "verbose"],
    {
      cwd: "dist/npm",
      stdio: "inherit",
    },
  );
  await confirmPublishedVersion(version, sha);
}

function registryVersion(latest: unknown): string {
  if (
    typeof latest !== "object" ||
    latest === null ||
    !("name" in latest) ||
    latest.name !== "keywork-cli" ||
    !("version" in latest) ||
    typeof latest.version !== "string" ||
    !valid(latest.version)
  ) {
    throw new Error("Cannot determine the current npm latest version");
  }
  return latest.version;
}

if (import.meta.main) {
  const version = process.env.RELEASE_VERSION;
  const sha = process.env.RELEASE_SHA;
  if (!version || !sha) throw new Error("RELEASE_VERSION and RELEASE_SHA are required");
  await publish(version, sha);
}
