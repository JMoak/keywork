import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { analyzeCommits } from "@semantic-release/commit-analyzer";
import { gte, inc, rcompare, valid } from "semver";
import { type GithubRelease, readGithubRelease } from "./github-release.ts";
import { publishedVersion, verifyPublishedVersion } from "./publish-npm.ts";

export interface ReleaseTag {
  readonly name: string;
  readonly sha: string;
  readonly reachable: boolean;
  readonly ahead?: boolean;
}

export interface ReleaseRequest {
  readonly refType: string;
  readonly refName: string;
  readonly sha: string;
  readonly tags: readonly ReleaseTag[];
  readonly commits: readonly { hash: string; message: string }[];
}

export interface ReleasePlan {
  readonly version: string;
  readonly tag: string;
  readonly sha: string;
}

export async function planRelease(request: ReleaseRequest): Promise<ReleasePlan | undefined> {
  const { refType, refName, sha, tags, commits } = request;
  if (refType === "tag") {
    const tag = tags.find((candidate) => candidate.name === refName);
    if (!tag || tag.sha !== sha) throw new Error(`${refName} does not point to ${sha}`);
    if (
      refName !== "v0.2.2" &&
      !tags.some((candidate) => candidate.name === "v0.2.2" && candidate.reachable)
    ) {
      throw new Error("Publish the v0.2.2 baseline before later release tags");
    }
    return releasePlan(stableVersion(refName), sha);
  }
  if (refName !== "main") throw new Error("Release planning requires main or a stable version tag");
  if (!tags.some((tag) => tag.name === "v0.2.2" && tag.reachable)) return undefined;
  const latest = latestReleaseTag(tags.filter((tag) => tag.reachable));
  if (!latest) return undefined;
  const currentVersion = stableVersion(latest.name);
  const ahead = latestReleaseTag(tags.filter((tag) => tag.ahead));
  if (ahead && gte(stableVersion(ahead.name), currentVersion)) return undefined;
  if (latest.sha === sha) return releasePlan(currentVersion, sha);
  const releaseType = await analyzeCommits(
    {
      preset: "conventionalcommits",
      releaseRules: [
        { breaking: true, release: "major" },
        { revert: true, release: false },
      ],
    },
    { cwd: process.cwd(), commits, logger: console },
  );
  if (!releaseType) return undefined;
  const version = inc(currentVersion, releaseType);
  if (!version) throw new Error(`Cannot increment ${currentVersion}`);
  const existing = tags.find((tag) => tag.name === `v${version}`);
  if (existing && existing.sha !== sha)
    throw new Error(`${existing.name} already belongs to another commit`);
  return releasePlan(version, sha);
}

export function latestReleaseTag(tags: readonly ReleaseTag[]): ReleaseTag | undefined {
  return tags
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag.name) && valid(tag.name.slice(1)))
    .toSorted((left, right) => rcompare(left.name.slice(1), right.name.slice(1)))[0];
}

export function verifyPreviousPublication(
  tag: ReleaseTag,
  github: GithubRelease | undefined,
  npm: unknown,
  requireNpm: boolean,
): void {
  const recovery = `Complete ${tag.name} by rerunning its original release workflow before advancing main releases`;
  if (!github || github.draft || github.prerelease || github.tag_name !== tag.name)
    throw new Error(recovery);
  if (requireNpm) {
    try {
      verifyPublishedVersion(npm, stableVersion(tag.name), tag.sha);
    } catch (cause) {
      throw new Error(recovery, { cause });
    }
  }
}

function releasePlan(version: string, sha: string): ReleasePlan {
  if (!gte(version, "0.2.2")) throw new Error("This release workflow starts at v0.2.2");
  return { version, tag: `v${version}`, sha };
}

function stableVersion(tag: string): string {
  const version = tag.slice(1);
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !valid(version)) {
    throw new Error(`Expected a stable release tag, received ${tag}`);
  }
  return version;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function readTags(): ReleaseTag[] {
  const reachable = new Set(git("tag", "--merged", "HEAD").split("\n"));
  return git("tag", "--list", "v*")
    .split("\n")
    .filter(Boolean)
    .map((name) => {
      const sha = git("rev-parse", `${name}^{commit}`);
      return {
        name,
        sha,
        reachable: reachable.has(name),
        ahead: !reachable.has(name) && isAncestor("HEAD", sha),
      };
    });
}

function isAncestor(older: string, newer: string): boolean {
  try {
    git("merge-base", "--is-ancestor", older, newer);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 1) {
      return false;
    }
    throw error;
  }
}

function readCommits(base: ReleaseTag | undefined): { hash: string; message: string }[] {
  const fields = git("log", "--format=%H%x00%B%x00", base ? `${base.name}..HEAD` : "HEAD").split(
    "\0",
  );
  const commits: { hash: string; message: string }[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    commits.push({ hash: fields[index]?.trim() ?? "", message: fields[index + 1] ?? "" });
  }
  return commits;
}

if (import.meta.main) {
  const tags = readTags();
  const previous = latestReleaseTag(tags.filter((tag) => tag.reachable));
  const plan = await planRelease({
    refType: process.env.GITHUB_REF_TYPE ?? "branch",
    refName: process.env.GITHUB_REF_NAME ?? "main",
    sha: git("rev-parse", "HEAD"),
    tags,
    commits: readCommits(previous),
  });
  if (plan && previous && previous.sha !== plan.sha) {
    const requireNpm = process.env.NPM_PUBLISH === "true";
    verifyPreviousPublication(
      previous,
      await readGithubRelease(`tags/${previous.name}`),
      requireNpm ? await publishedVersion(stableVersion(previous.name)) : undefined,
      requireNpm,
    );
  }
  console.log(plan ?? "No release needed");
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `release=${Boolean(plan)}\nversion=${plan?.version ?? ""}\ntag=${plan?.tag ?? ""}\nsha=${plan?.sha ?? ""}\n`,
    );
  }
}
