import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordedHost, recordedHouse, recordedKeeper } from "../transport/testing/recorded.ts";
import { auditDeniedCallers } from "./admissions.ts";
import {
  type AuditEntry,
  type AuditRow,
  fileAuditLog,
  genesisHash,
  memoryAuditLog,
  mergeAuditRows,
  meshAuditFile,
  parseAuditJsonl,
  rowHash,
  verifyAuditChain,
  verifyAuditFile,
} from "./log.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function auditFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "keywork-mesh-audit-"));
  directories.push(directory);
  return meshAuditFile(directory);
}

function entry(index: number, decision: AuditEntry["decision"] = "allow"): AuditEntry {
  return {
    actor: { stableId: recordedHouse.stableId, userId: recordedKeeper.userId, tags: [] },
    target: recordedHost.stableId,
    capability: "exec",
    request: { tool: "bash", arguments: { command: `echo ${index}` } },
    decision,
    reason: decision === "allow" ? "allowed by the grant's rules" : "no-grant",
  };
}

function ticking(): () => Date {
  let at = Date.parse("2026-11-05T12:00:00Z");
  return () => {
    at += 1_000;
    return new Date(at);
  };
}

async function filled(count: number): Promise<AuditRow[]> {
  const log = memoryAuditLog({ now: ticking() });
  for (let index = 0; index < count; index += 1) await log.append(entry(index));
  return log.rows();
}

describe("the mesh audit log", () => {
  it("writes the spec's fields and chains each row to the one before", async () => {
    const rows = await filled(3);
    expect(rows[0]).toMatchObject({
      ts: "2026-11-05T12:00:01.000Z",
      actorStableID: recordedHouse.stableId,
      actorUserID: recordedKeeper.userId,
      actorTags: [],
      targetStableID: recordedHost.stableId,
      capability: "exec",
      decision: "allow",
      prevHash: genesisHash,
    });
    expect(rows[0]?.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
    expect(rows[2]?.prevHash).toBe(rows[1]?.hash);
    expect(verifyAuditChain(rows)).toEqual({ intact: true, head: rows[2]?.hash, rows: 3 });
  });

  it("detects an edited, removed or reordered row", async () => {
    const rows = await filled(4);
    const edited = rows.map((row, index) =>
      index === 1 ? { ...row, decision: "deny" as const } : row,
    );
    expect(verifyAuditChain(edited)).toEqual({ intact: false, index: 1, reason: "hash" });
    const rehashed = edited.map((row, index) => {
      if (index !== 1) return row;
      const { hash: _hash, ...body } = row;
      return { ...row, hash: rowHash(body) };
    });
    expect(verifyAuditChain(rehashed)).toEqual({ intact: false, index: 2, reason: "prev-hash" });
    expect(verifyAuditChain([rows[0], rows[2], rows[3]] as AuditRow[])).toEqual({
      intact: false,
      index: 1,
      reason: "prev-hash",
    });
    expect(verifyAuditChain([rows[1], rows[0]] as AuditRow[])).toMatchObject({
      intact: false,
      index: 0,
    });
    expect(verifyAuditChain(rows.slice(2), rows[1]?.hash)).toMatchObject({ intact: true, rows: 2 });
  });

  it("keeps the chain across concurrent appends", async () => {
    const log = memoryAuditLog();
    await Promise.all(Array.from({ length: 20 }, (_, index) => log.append(entry(index))));
    expect(verifyAuditChain(await log.rows())).toMatchObject({ intact: true, rows: 20 });
  });

  it("appends JSON lines to a file and continues the chain after a restart", async () => {
    const file = auditFile();
    await fileAuditLog(file).append(entry(1));
    const reopened = fileAuditLog(file);
    await reopened.append(entry(2, "deny"));
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const rows = await reopened.rows();
    expect(rows.map(({ decision }) => decision)).toEqual(["allow", "deny"]);
    expect(await verifyAuditFile(file)).toMatchObject({ intact: true, rows: 2 });
  });

  it("reports a tampered or torn file", async () => {
    const file = auditFile();
    const log = fileAuditLog(file);
    await log.append(entry(1));
    await log.append(entry(2));
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace('"decision":"allow"', '"decision":"deny"'));
    expect(await verifyAuditFile(file)).toEqual({ intact: false, index: 0, reason: "hash" });
    writeFileSync(file, original);
    appendFileSync(file, '{"ts":"2026-11');
    expect(await verifyAuditFile(file)).toEqual({ intact: false, index: 2, reason: "unreadable" });
    expect(parseAuditJsonl(readFileSync(file, "utf8")).rows).toHaveLength(2);
  });

  it("pages rows after a known hash", async () => {
    const log = memoryAuditLog();
    for (let index = 0; index < 5; index += 1) await log.append(entry(index));
    const all = await log.rows();
    expect(await log.rows({ after: all[1]?.hash, limit: 2 })).toEqual(all.slice(2, 4));
    expect(await log.rows({ after: all[4]?.hash })).toEqual([]);
  });

  it("merges several nodes' rows into one timeline", async () => {
    const house = await filled(2);
    const host = (await filled(1)).map((row) => ({ ...row, ts: "2026-11-05T12:00:01.500Z" }));
    const merged = mergeAuditRows([
      { node: "house", rows: house },
      { node: "host", rows: host },
    ]);
    expect(merged.map(({ node, ts }) => `${node} ${ts}`)).toEqual([
      "house 2026-11-05T12:00:01.000Z",
      "host 2026-11-05T12:00:01.500Z",
      "house 2026-11-05T12:00:02.000Z",
    ]);
  });

  it("records denied WhoIs lookups from the listener", async () => {
    const log = memoryAuditLog();
    const failures: unknown[] = [];
    const record = auditDeniedCallers(
      log,
      () => recordedHost.stableId,
      (error) => failures.push(error),
    );
    record({
      type: "mesh.caller.denied",
      address: "100.99.99.99",
      reason: "not-a-peer",
      detail: "no node",
    });
    record({ type: "mesh.listener.idle", reason: "not-running" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await log.rows()).toEqual([
      expect.objectContaining({
        capability: "connect",
        decision: "deny",
        reason: "not-a-peer: no node",
      }),
    ]);
  });
});
