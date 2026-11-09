import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { gt } from "semver";

export interface GithubRelease {
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly tag_name: string;
}

export async function readGithubRelease(path: string): Promise<GithubRelease | undefined> {
  const response = await fetch(`https://api.github.com/repos/JMoak/keywork/releases/${path}`, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub release lookup failed: ${response.status}`);
  const release = await response.json();
  if (
    typeof release !== "object" ||
    release === null ||
    !("draft" in release) ||
    typeof release.draft !== "boolean" ||
    !("prerelease" in release) ||
    typeof release.prerelease !== "boolean" ||
    !("tag_name" in release) ||
    typeof release.tag_name !== "string"
  ) {
    throw new Error("GitHub returned invalid release metadata");
  }
  return { draft: release.draft, prerelease: release.prerelease, tag_name: release.tag_name };
}

async function prepare(tag: string, sha: string): Promise<void> {
  const checkedOut = command("git", ["rev-parse", "HEAD"]);
  if (checkedOut !== sha) throw new Error(`Checked-out source ${checkedOut} does not match ${sha}`);
  if (command("git", ["tag", "--list", tag])) {
    const tagged = command("git", ["rev-parse", `${tag}^{commit}`]);
    if (tagged !== sha) throw new Error(`${tag} already points to ${tagged}, expected ${sha}`);
  } else {
    command("git", ["tag", tag, sha]);
    command("git", ["push", "origin", `refs/tags/${tag}`]);
  }
  const release = await readGithubRelease(`tags/${tag}`);
  if (release?.prerelease) throw new Error(`${tag} is marked as a prerelease`);
  if (release && !release.draft) {
    console.log(`${tag} is already public; retaining its published assets`);
    return;
  }
  if (!release) {
    command("gh", [
      "release",
      "create",
      tag,
      "--verify-tag",
      "--draft",
      "--generate-notes",
      "--title",
      `keywork ${tag}`,
    ]);
  }
  const assets = readdirSync("dist/release").map((file) => `dist/release/${file}`);
  command("gh", ["release", "upload", tag, "--clobber", ...assets]);
}

async function complete(tag: string): Promise<void> {
  const release = await readGithubRelease(`tags/${tag}`);
  if (!release) throw new Error(`Missing prepared release ${tag}`);
  if (release.prerelease) throw new Error(`${tag} is marked as a prerelease`);
  if (!release.draft) return;
  const latest = await readGithubRelease("latest");
  if (latest && gt(latest.tag_name.slice(1), tag.slice(1))) {
    throw new Error(`Refusing to replace GitHub latest ${latest.tag_name}`);
  }
  command("gh", ["release", "edit", tag, "--draft=false", "--latest"]);
}

function command(program: string, args: string[]): string {
  return execFileSync(program, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

if (import.meta.main) {
  const tag = process.env.RELEASE_TAG;
  const sha = process.env.RELEASE_SHA;
  if (!tag || !sha || !process.env.GH_TOKEN) {
    throw new Error("RELEASE_TAG, RELEASE_SHA and GH_TOKEN are required");
  }
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`Invalid release tag ${tag}`);
  const phase = process.argv[2];
  if (phase === "prepare") await prepare(tag, sha);
  else if (phase === "complete") await complete(tag);
  else throw new Error("Expected prepare or complete");
}
