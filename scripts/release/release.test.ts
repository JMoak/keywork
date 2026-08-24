import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BuildInputError, outdirInside, resolveBuildVersion } from "./build-inputs.ts";
import { npmManifestFor } from "./npm-manifest.ts";
import {
  assetNameFor,
  buildVersionDefine,
  checksumLine,
  hostTarget,
  isReleaseVersion,
  releaseTargets,
  tagMatchesVersion,
  versionFromTag,
} from "./targets.ts";

describe("release targets", () => {
  it("names assets by os and arch, with .exe only on Windows", () => {
    expect(assetNameFor("linux", "x64")).toBe("keywork-linux-x64");
    expect(assetNameFor("windows", "x64")).toBe("keywork-windows-x64.exe");
    expect(assetNameFor("darwin", "arm64")).toBe("keywork-darwin-arm64");
  });

  it("covers Linux first, then Windows and macOS, on both architectures where shipped", () => {
    expect(releaseTargets.map((target) => target.assetName)).toEqual([
      "keywork-linux-x64",
      "keywork-linux-arm64",
      "keywork-windows-x64.exe",
      "keywork-darwin-arm64",
      "keywork-darwin-x64",
    ]);
  });

  it("maps the host platform onto a shipped target", () => {
    expect(hostTarget("linux", "x64").assetName).toBe("keywork-linux-x64");
    expect(hostTarget("win32", "x64").assetName).toBe("keywork-windows-x64.exe");
    expect(hostTarget("darwin", "arm64").assetName).toBe("keywork-darwin-arm64");
    expect(() => hostTarget("freebsd", "x64")).toThrow("no release target");
    expect(() => hostTarget("win32", "arm64")).toThrow("no release target");
  });

  it("writes sha256sum-compatible checksum lines", () => {
    expect(checksumLine("abc123", "keywork-linux-x64")).toBe("abc123  keywork-linux-x64\n");
  });

  it("reads versions out of release tags and nothing else", () => {
    expect(versionFromTag("v0.1.0")).toBe("0.1.0");
    expect(versionFromTag("v1.2.3-rc.1")).toBe("1.2.3-rc.1");
    expect(versionFromTag("0.1.0")).toBeUndefined();
    expect(versionFromTag("v0.1")).toBeUndefined();
    expect(tagMatchesVersion("v0.1.0", "0.1.0")).toBe(true);
    expect(tagMatchesVersion("v0.2.0", "0.1.0")).toBe(false);
  });

  it("passes the build version to bun as a JSON string define", () => {
    expect(buildVersionDefine("0.1.0")).toEqual(["--define", 'KEYWORK_BUILD_VERSION="0.1.0"']);
  });

  it("accepts only MAJOR.MINOR.PATCH with an optional prerelease as a release version", () => {
    expect(isReleaseVersion("0.1.0")).toBe(true);
    expect(isReleaseVersion("1.2.3-rc.1")).toBe(true);
    expect(isReleaseVersion("v0.1.0")).toBe(false);
    expect(isReleaseVersion("0.1")).toBe(false);
    expect(isReleaseVersion("undefined")).toBe(false);
    expect(isReleaseVersion("")).toBe(false);
  });
});

describe("build version resolution", () => {
  const manifestPath = "packages/cli/package.json";

  it("reads a valid version out of the manifest", () => {
    expect(resolveBuildVersion({ manifest: { version: "0.1.0" }, manifestPath })).toBe("0.1.0");
  });

  it("fails by name when the manifest has no version instead of shipping keywork undefined", () => {
    const attempt = () => resolveBuildVersion({ manifest: { name: "keywork" }, manifestPath });
    expect(attempt).toThrow(BuildInputError);
    expect(attempt).toThrow('packages/cli/package.json has no "version" field');
  });

  it("rejects a manifest version outside the release grammar", () => {
    expect(() => resolveBuildVersion({ manifest: { version: "next" }, manifestPath })).toThrow(
      'packages/cli/package.json version "next" is not a release version',
    );
    expect(() => resolveBuildVersion({ manifest: { version: 1 }, manifestPath })).toThrow(
      BuildInputError,
    );
    expect(() => resolveBuildVersion({ manifest: null, manifestPath })).toThrow(BuildInputError);
  });

  it("lets --version override the manifest but holds it to the same grammar", () => {
    expect(
      resolveBuildVersion({
        manifest: { version: "0.1.0" },
        manifestPath,
        override: "0.0.0-local",
      }),
    ).toBe("0.0.0-local");
    expect(() =>
      resolveBuildVersion({ manifest: { version: "0.1.0" }, manifestPath, override: "local" }),
    ).toThrow('--version version "local" is not a release version');
  });

  it("insists the expected tag names the resolved version", () => {
    const manifest = { version: "0.1.0" };
    expect(resolveBuildVersion({ manifest, manifestPath, expectTag: "v0.1.0" })).toBe("0.1.0");
    expect(() => resolveBuildVersion({ manifest, manifestPath, expectTag: "v0.2.0" })).toThrow(
      "release tag v0.2.0 does not match packages/cli/package.json version 0.1.0",
    );
  });
});

describe("npm outdir guard", () => {
  const cwd = resolve("/repo");

  it("resolves a directory inside dist/", () => {
    expect(outdirInside("dist", "dist/npm", cwd)).toBe(resolve(cwd, "dist/npm"));
    expect(outdirInside("dist", "dist/nested/deeper", cwd)).toBe(
      resolve(cwd, "dist/nested/deeper"),
    );
  });

  it("refuses dist/ itself, the repo root, parents and escapes", () => {
    for (const requested of ["dist", ".", "..", "dist/../src", "../elsewhere", cwd]) {
      expect(() => outdirInside("dist", requested, cwd)).toThrow(BuildInputError);
      expect(() => outdirInside("dist", requested, cwd)).toThrow("inside dist/");
    }
  });

  it("does not mistake a sibling whose name starts with dist for dist/", () => {
    expect(() => outdirInside("dist", "distro/npm", cwd)).toThrow(BuildInputError);
  });
});

describe("npm manifest", () => {
  it("publishes a bun-run bin with OpenTUI left external and pinned exactly", () => {
    const manifest = npmManifestFor({
      version: "0.1.0",
      opentuiVersion: "0.5.1",
      treeSitterVersion: "0.25.10",
    });
    expect(manifest.name).toBe("keywork");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.bin).toEqual({ keywork: "bin/keywork.js" });
    expect(manifest.dependencies).toEqual({
      "@opentui/core": "0.5.1",
      "web-tree-sitter": "0.25.10",
    });
    expect(manifest.engines).toEqual({ bun: ">=1.3.0" });
    expect(manifest.license).toBe("FSL-1.1-MIT");
    expect(manifest.files).toContain("bin");
  });
});
