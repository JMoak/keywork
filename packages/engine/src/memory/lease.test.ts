import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { Gardener } from "./gardener.ts";
import { leaseFile, SweepLease } from "./lease.ts";
import { MemoryStore } from "./store.ts";

const scratch = scratchDirs("keywork-lease-");

const t0 = Date.parse("2026-08-10T09:00:00Z");

function leaseFor(root: string, host: string, atMs: () => number): SweepLease {
  return new SweepLease({ vaultRoot: root, host, now: () => new Date(atMs()), ttlMs: 60_000 });
}

describe("the sweep lease", () => {
  it("is taken, renewed by its holder, refused to a foreign host while fresh, and released", async () => {
    const root = await scratch();
    let clock = t0;
    const alpha = leaseFor(root, "alpha", () => clock);
    const beta = leaseFor(root, "beta", () => clock);
    expect(await alpha.acquire()).toEqual({ kind: "held", until: "2026-08-10T09:01:00.000Z" });
    expect(await beta.acquire()).toEqual({
      kind: "foreign",
      host: "alpha",
      until: "2026-08-10T09:01:00.000Z",
    });
    clock += 30_000;
    expect(await alpha.acquire()).toEqual({ kind: "held", until: "2026-08-10T09:01:30.000Z" });
    await beta.release();
    expect(JSON.parse(await readFile(join(root, leaseFile), "utf8")).host).toBe("alpha");
    await alpha.release();
    expect(await alpha.inspect()).toBeUndefined();
    expect(await beta.acquire()).toMatchObject({ kind: "held" });
  });

  it("takes over a stale foreign lease and ignores a corrupt one", async () => {
    const root = await scratch();
    let clock = t0;
    const alpha = leaseFor(root, "alpha", () => clock);
    const beta = leaseFor(root, "beta", () => clock);
    await alpha.acquire();
    clock += 61_000;
    expect(await beta.acquire()).toMatchObject({ kind: "held" });
    expect((await beta.inspect())?.host).toBe("beta");
    await mkdir(join(root, ".sync"), { recursive: true });
    await writeFile(join(root, leaseFile), "{not json", "utf8");
    expect(await alpha.inspect()).toBeUndefined();
    expect(await alpha.acquire()).toMatchObject({ kind: "held" });
  });
});

describe("gardener under a lease", () => {
  it("defers to a fresh foreign lease, records why, and sweeps once it is stale", async () => {
    const root = await scratch();
    let clock = t0;
    const now = () => new Date(clock);
    const store = new MemoryStore({ vaultRoot: root, trusted: true, host: "alpha", now });
    await leaseFor(root, "beta", () => clock).acquire();
    const gardener = new Gardener({ store, now, lease: leaseFor(root, "alpha", () => clock) });
    const deferred = await gardener.sweep();
    expect(deferred.deferred).toEqual({ host: "beta", until: "2026-08-10T09:01:00.000Z" });
    const audit = (await store.readAudit()).map((entry) => entry.event);
    expect(audit).toEqual([
      "gardener deferred: beta holds the sweep lease until 2026-08-10T09:01:00.000Z",
    ]);
    clock += 120_000;
    const swept = await gardener.sweep();
    expect(swept.deferred).toBeUndefined();
    expect((await store.readAudit()).at(-1)?.event).toMatch(/^gardener sweep:/);
    expect(await leaseFor(root, "alpha", () => clock).inspect()).toBeUndefined();
  });

  it("sweeps without a lease exactly as before", async () => {
    const root = await scratch();
    const store = new MemoryStore({ vaultRoot: root, trusted: true });
    const report = await new Gardener({ store }).sweep();
    expect(report.deferred).toBeUndefined();
    expect(await new SweepLease({ vaultRoot: root, host: "x" }).inspect()).toBeUndefined();
  });
});
