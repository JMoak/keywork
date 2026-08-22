export type ReleaseOs = "linux" | "windows" | "darwin";
export type ReleaseArch = "x64" | "arm64";

export interface ReleaseTarget {
  readonly os: ReleaseOs;
  readonly arch: ReleaseArch;
  readonly assetName: string;
}

export const releaseTargets: readonly ReleaseTarget[] = [
  target("linux", "x64"),
  target("linux", "arm64"),
  target("windows", "x64"),
  target("darwin", "arm64"),
  target("darwin", "x64"),
];

export function hostTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReleaseTarget {
  const os = releaseOsOf(platform);
  const releaseArch = releaseArchOf(arch);
  const found = releaseTargets.find(
    (candidate) => candidate.os === os && candidate.arch === releaseArch,
  );
  if (found === undefined) throw new Error(`keywork has no release target for ${platform}-${arch}`);
  return found;
}

export function assetNameFor(os: ReleaseOs, arch: ReleaseArch): string {
  return `keywork-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
}

export function checksumLine(sha256Hex: string, assetName: string): string {
  return `${sha256Hex}  ${assetName}\n`;
}

export function isReleaseVersion(candidate: string): boolean {
  return releaseVersion.test(candidate);
}

export function versionFromTag(tag: string): string | undefined {
  return releaseTag.exec(tag)?.[1];
}

export function tagMatchesVersion(tag: string, version: string): boolean {
  return versionFromTag(tag) === version;
}

export function buildVersionDefine(version: string): readonly string[] {
  return ["--define", `KEYWORK_BUILD_VERSION=${JSON.stringify(version)}`];
}

const releaseVersionGrammar = String.raw`\d+\.\d+\.\d+(?:-[\w.]+)?`;
const releaseVersion = new RegExp(`^${releaseVersionGrammar}$`);
const releaseTag = new RegExp(`^v(${releaseVersionGrammar})$`);

function target(os: ReleaseOs, arch: ReleaseArch): ReleaseTarget {
  return { os, arch, assetName: assetNameFor(os, arch) };
}

function releaseOsOf(platform: NodeJS.Platform): ReleaseOs {
  switch (platform) {
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    default:
      throw new Error(`keywork has no release target for platform ${platform}`);
  }
}

function releaseArchOf(arch: string): ReleaseArch {
  switch (arch) {
    case "x64":
    case "arm64":
      return arch;
    default:
      throw new Error(`keywork has no release target for architecture ${arch}`);
  }
}
