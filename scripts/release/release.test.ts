import { describe, expect, it } from "vitest";
import { npmManifestFor } from "./npm-manifest.ts";
import {
  assetNameFor,
  buildVersionDefine,
  checksumLine,
  hostTarget,
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
