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
  runtimeSatisfies,
  sameRuntime,
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
  it("separates immutable artifact identity from an explicit contract requirement", () => {
    const requirement = { ...keywork, version: "0.3.0", compatibility: "contract" as const };
    expect(sameRuntime(runtime, requirement)).toBe(false);
    expect(runtimeSatisfies(runtime, requirement)).toBe(true);
    expect(runtimeSatisfies(runtime, { ...requirement, contract: "1.26" })).toBe(false);
    expect(runtimeSatisfies(runtime, { ...keywork, version: "0.3.0" })).toBe(false);
  });

  it("registers a newer compatible consumer without interrupting the running engine", () => {
    registry.install(runtime, keywork, { now });
    const candidate = { ...runtime, version: "0.3.0", sha256: "b".repeat(64) };
    const consumer = { ...stead, version: candidate.version, compatibility: "contract" as const };
    expect(registry.selectInstallation(candidate, consumer, { now, runtimeRunning: true })).toEqual(
      {
        runtime,
        deferred: { version: candidate.version, reason: "consumer-conflict" },
      },
    );
    expect(registry.install(candidate, consumer, { now, runtimeRunning: true })).toEqual(runtime);
    expect(registry.consumers()).toEqual([keywork, consumer]);
  });

  it("upgrades at a stopped point without removing compatible product registrations", () => {
    const compatibleKeywork = { ...keywork, compatibility: "contract" as const };
    registry.install(runtime, compatibleKeywork, { now });
    registry.install(runtime, { ...stead, compatibility: "contract" }, { now });
    const candidate = { ...runtime, version: "0.3.0", sha256: "b".repeat(64) };
    const consumer = { ...compatibleKeywork, version: candidate.version };
    expect(registry.selectInstallation(candidate, consumer, { now, runtimeRunning: true })).toEqual(
      {
        runtime,
        deferred: { version: candidate.version, reason: "runtime-running" },
      },
    );
    registry.install(candidate, consumer, { now });
    expect(registry.runtime()).toEqual(candidate);
    expect(registry.consumers()).toHaveLength(2);
    expect(registry.admit({ ...stead, compatibility: "contract" })).toEqual(candidate);
  });

  it("defers a compatible update for leases and protected work while registering its consumer", () => {
    const compatible = { ...keywork, compatibility: "contract" as const };
    registry.install(runtime, compatible, { now });
    registry.attach({ ...client("one"), compatibility: "contract" }, now);
    const candidate = { ...runtime, version: "0.3.0" };
    const consumer = { ...compatible, version: candidate.version };
    expect(registry.selectInstallation(candidate, consumer, { now }).deferred?.reason).toBe(
      "active-clients",
    );
    registry.detach("one");
    expect(
      registry.selectInstallation(candidate, consumer, { now, authorizedWork: true }).deferred
        ?.reason,
    ).toBe("active-work");
  });

  it("never downgrades a selected artifact for an older compatible bundle", () => {
    const newer = { ...runtime, version: "0.3.0", sha256: "b".repeat(64) };
    registry.install(
      newer,
      { ...keywork, version: newer.version, compatibility: "contract" },
      { now },
    );
    expect(registry.install(runtime, { ...stead, compatibility: "contract" }, { now })).toEqual(
      newer,
    );
    expect(() => registry.install(runtime, stead, { now })).toThrow(
      "downgrades are never automatic",
    );
    expect(registry.runtime()).toEqual(newer);
  });

  it("persists an incomplete activation and blocks clients until forward completion", async () => {
    registry.install(runtime, { ...keywork, compatibility: "contract" }, { now });
    const candidate = { ...runtime, version: "0.3.0", sha256: "b".repeat(64) };
    const consumer = { ...stead, version: candidate.version, compatibility: "contract" as const };
    registry.prepareInstallation({ runtime: candidate, consumer });
    const other = await RuntimeRegistry.open(registry.file);
    connections.push(other);
    expect(other.runtime()).toEqual(runtime);
    expect(other.pendingInstallation()).toEqual({ runtime: candidate, consumer });
    expect(() => other.attach({ ...client("one"), compatibility: "contract" }, now)).toThrow(
      "activation is incomplete",
    );
    expect(other.completeInstallation()).toEqual(candidate);
    expect(registry.pendingInstallation()).toBeUndefined();
    expect(registry.admit({ ...keywork, compatibility: "contract" })).toEqual(candidate);
  });
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
