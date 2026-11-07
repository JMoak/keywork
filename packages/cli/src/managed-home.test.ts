import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openWorkspace, resolveAnchor, writeWorkspaceDeclaration } from "@keywork/shared";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import {
  existingManagedHome,
  managedHomeFolder,
  prepareManagedHome,
  workspaceIdentity,
} from "./paths.ts";

const scratch = scratchDirs("keywork-managed-home-");

describe("managed creature home", () => {
  it("uses a durable declared anchor inside app state and leaves ordinary trust unset", async () => {
    const userRoot = await scratch();
    const root = managedHomeFolder(userRoot);
    expect(existingManagedHome(userRoot)).toBeUndefined();
    expect(existsSync(root)).toBe(false);
    mkdirSync(join(userRoot, ".git"));
    expect(prepareManagedHome(userRoot)).toBe(root);
    expect(resolveAnchor(root)).toEqual({ root, source: "declaration" });
    expect(openWorkspace(root)?.contextDirs).toEqual([]);
    const identity = workspaceIdentity(root);
    expect(workspaceIdentity(prepareManagedHome(userRoot))).toBe(identity);
    expect(workspaceIdentity(userRoot)).not.toBe(identity);
    expect(existsSync(join(userRoot, ".keywork", "trust.json"))).toBe(false);
  });

  it("rejects an alias from the managed folder to a separate directory", async () => {
    const userRoot = await scratch();
    const outside = await scratch();
    const root = managedHomeFolder(userRoot);
    mkdirSync(dirname(root));
    symlinkSync(outside, root, process.platform === "win32" ? "junction" : "dir");
    expect(() => prepareManagedHome(userRoot)).toThrow(/local workspace directory/);
    expect(existsSync(join(outside, ".keywork"))).toBe(false);
  });

  it("rejects an existing declaration that admits another directory", async () => {
    const userRoot = await scratch();
    const root = managedHomeFolder(userRoot);
    writeWorkspaceDeclaration(root, { name: "Creature home", contextDirs: [userRoot] });
    expect(() => prepareManagedHome(userRoot)).toThrow(/local workspace directory/);
  });

  it("checks state compatibility before writing a home declaration", async () => {
    const userRoot = await scratch();
    const root = managedHomeFolder(userRoot);
    mkdirSync(dirname(root));
    writeFileSync(join(dirname(root), "state-layout.json"), '{"version":999}');
    expect(() => prepareManagedHome(userRoot)).toThrow(/newer than this keywork/);
    expect(existsSync(root)).toBe(false);
  });
});
