import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ManagedRuntime,
  type RuntimeClient,
  RuntimeConflictError,
  type RuntimeConsumer,
  RuntimeRegistry,
} from "./registry.ts";

const now = 1_000_000;
const runtime: ManagedRuntime = {
  version: "0.2.0",
  contract: "1.25",
  binary: "/managed/keywork.exe",
  sha256: "a".repeat(64),
  platform: "win32",
  arch: "x64",
};
const keywork: RuntimeConsumer = {
  id: "keywork-install",
  product: "keywork",
  version: runtime.version,
  contract: runtime.contract,
  installedAt: now,
};
const stead: RuntimeConsumer = { ...keywork, id: "stead-install", product: "stead" };

let root: string;
let registry: RuntimeRegistry;
const connections: RuntimeRegistry[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "keywork-runtime-registry-"));
  registry = await RuntimeRegistry.open(join(root, "registry.sqlite"));
  connections.push(registry);
});

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  rmSync(root, { recursive: true, force: true });
});

describe("shared runtime installation consumers", () => {
  it("keeps both products across independent installs and removes only the named consumer", () => {
    registry.install(runtime, keywork, { now });
    registry.install(runtime, stead, { now });
    expect(registry.consumers()).toEqual([keywork, stead]);
    expect(registry.removeConsumer(keywork.id)).toBe(true);
    expect(registry.consumers()).toEqual([stead]);
    expect(registry.retention(false, now)).toEqual({ retain: true, reasons: ["consumers"] });
  });

  it("rejects different binary contents under the same version and contract", () => {
    registry.install(runtime, keywork, { now });
    const alternate = { ...runtime, binary: "/other/keywork.exe", sha256: "b".repeat(64) };
    expect(() => registry.install(alternate, stead, { now })).toThrow("different binary contents");
    expect(registry.runtime()).toEqual(runtime);
    expect(registry.consumers()).toEqual([keywork]);
  });

  it("refuses an incompatible update before changing any runtime or consumer record", () => {
    registry.install(runtime, keywork, { now });
    registry.install(runtime, stead, { now });
    const update = { ...runtime, version: "0.3.0", contract: "1.26" };
    expect(() =>
      registry.install(
        update,
        { ...stead, version: update.version, contract: update.contract },
        { now },
      ),
    ).toThrow("still required by keywork");
    expect(registry.runtime()).toEqual(runtime);
    expect(registry.consumers()).toEqual([keywork, stead]);
  });

  it("defers replacement while an active client or authorized work remains", () => {
    registry.install(runtime, keywork, { now });
    registry.attach(client("one"), now);
    const update = { ...runtime, version: "0.3.0" };
    const consumer = { ...keywork, version: update.version };
    expect(() => registry.install(update, consumer, { now })).toThrow("active clients");
    registry.detach("one");
    expect(() => registry.install(update, consumer, { now, authorizedWork: true })).toThrow(
      "Authorized work",
    );
    expect(registry.install(update, consumer, { now })).toEqual(update);
  });

  it("retains the last product's runtime for clients and persistent work", () => {
    registry.install(runtime, keywork, { now });
    registry.attach(client("one"), now);
    registry.removeConsumer(keywork.id);
    expect(registry.retention(true, now)).toEqual({
      retain: true,
      reasons: ["clients", "work"],
    });
    registry.detach("one");
    expect(registry.retention(true, now)).toEqual({ retain: true, reasons: ["work"] });
    expect(registry.retention(false, now)).toEqual({ retain: false, reasons: [] });
  });
});

describe("independent runtime clients", () => {
  it("refuses version or contract mismatches without creating a lease", () => {
    registry.install(runtime, keywork, { now });
    expect(() => registry.attach({ ...client("one"), version: "0.1.0" }, now)).toThrow(
      RuntimeConflictError,
    );
    expect(() => registry.attach({ ...client("one"), contract: "1.24" }, now)).toThrow(
      "Use a matching app release",
    );
    expect(registry.clients(now)).toEqual([]);
  });

  it("keeps leases independent across database connections and a client disconnect", async () => {
    registry.install(runtime, keywork, { now });
    const other = await RuntimeRegistry.open(registry.file);
    connections.push(other);
    registry.attach(client("one"), now);
    other.attach({ ...client("two"), product: "stead", pid: 200 }, now);
    registry.detach("one");
    expect(other.clients(now).map((lease) => lease.id)).toEqual(["two"]);
    expect(registry.consumers()).toEqual([keywork]);
  });

  it("cleans dead and expired clients while preserving a live client", () => {
    registry.install(runtime, keywork, { now });
    registry.attach({ ...client("expired"), expiresAt: now + 10 }, now);
    registry.attach({ ...client("dead"), pid: 200 }, now);
    registry.attach(client("live"), now);
    expect(registry.prune(now + 20, (pid) => pid === 100)).toBe(2);
    expect(registry.clients(now + 20).map((lease) => lease.id)).toEqual(["live"]);
  });

  it("rejects reusing another workspace's client identity", () => {
    registry.install(runtime, keywork, { now });
    registry.attach(client("one"), now);
    expect(() => registry.attach({ ...client("one"), workspace: "other" }, now)).toThrow(
      "another window or workspace",
    );
    expect(registry.clients(now)).toEqual([client("one")]);
  });
});

function client(id: string): RuntimeClient {
  return {
    id,
    product: "keywork",
    workspace: "project-a",
    pid: 100,
    version: runtime.version,
    contract: runtime.contract,
    expiresAt: now + 30_000,
  };
}
