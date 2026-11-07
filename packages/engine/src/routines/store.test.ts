import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRoutine } from "./routine.ts";
import { openSqlite, type SqliteDatabase } from "./sqlite.ts";
import { IdempotencyKeyReuseError, RoutineStore, runIdOf, schemaVersion } from "./store.ts";
import { routineInput } from "./testing.ts";

const t0 = Date.parse("2026-11-05T09:00:00Z");

let dir: string;
const opened: SqliteDatabase[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "keywork-routine-store-"));
});

afterEach(async () => {
  for (const db of opened.splice(0)) db.close();
  await rm(dir, { recursive: true, force: true });
});

async function database(): Promise<SqliteDatabase> {
  const db = await openSqlite(join(dir, "routines.db"));
  opened.push(db);
  return db;
}

interface ObservedWrite {
  table: string;
  synchronous: number;
}

function observing(db: SqliteDatabase, writes: ObservedWrite[]): SqliteDatabase {
  return {
    exec: (sql) => db.exec(sql),
    get: (sql, ...params) => db.get(sql, ...params),
    all: (sql, ...params) => db.all(sql, ...params),
    close: () => db.close(),
    run: (sql, ...params) => {
      const table = /(?:INTO|UPDATE)\s+(\w+)/i.exec(sql)?.[1];
      if (table !== undefined) {
        writes.push({ table, synchronous: Number(db.get("PRAGMA synchronous")?.synchronous) });
      }
      return db.run(sql, ...params);
    },
  };
}

const triage = parseRoutine(routineInput());

describe("RoutineStore", () => {
  it("opens in WAL mode at the current schema version and migrates once", async () => {
    const store = new RoutineStore(await database());
    expect(store.journalMode()).toBe("wal");
    store.index("wren", "triage", "triage.json", triage, t0);
    const reopened = new RoutineStore(await database());
    expect(reopened.routine("wren", "triage")?.anchorAt).toBe(t0);
    expect(Number((await database()).get("PRAGMA user_version")?.user_version)).toBe(schemaVersion);
  });

  it("writes effects and approvals with synchronous FULL and everything else with NORMAL", async () => {
    const writes: ObservedWrite[] = [];
    const store = new RoutineStore(observing(await database(), writes));
    store.index("wren", "triage", "triage.json", triage, t0);
    const run = store.insertRun(newRun(t0));
    const runId = run?.runId ?? "";
    store.beginEffect("deliver:1", runId, "deliver", { to: "conversation" }, t0);
    store.completeEffect("deliver:1", { ok: true }, t0);
    store.parkApproval({
      callId: "call-1",
      runId,
      tool: "bash",
      approvalClass: "outbound",
      requestedAt: t0,
      deadlineAt: t0 + 1000,
    });
    store.settleApproval("call-1", "expired", t0 + 1000);
    const full = 2;
    const normal = 1;
    expect(new Set(writes.filter(isDurable).map((write) => write.synchronous))).toEqual(
      new Set([full]),
    );
    expect(new Set(writes.filter((write) => !isDurable(write)).map((w) => w.synchronous))).toEqual(
      new Set([normal]),
    );
    expect(writes.map((write) => write.table)).toEqual(
      expect.arrayContaining(["routines", "runs", "effects", "approvals"]),
    );
  });

  it("keeps one run per routine, fired slot and attempt", async () => {
    const store = new RoutineStore(await database());
    const first = store.insertRun(newRun(t0));
    expect(first?.runId).toBe(runIdOf("wren", "triage", t0, 1));
    expect(store.insertRun(newRun(t0))).toBeUndefined();
    expect(store.insertRun({ ...newRun(t0), attempt: 2 })?.attempt).toBe(2);
    expect(store.runs("wren", "triage", 10)).toHaveLength(2);
  });

  it("refuses an idempotency key reused with different parameters", async () => {
    const store = new RoutineStore(await database());
    expect(store.beginEffect("send:1", "run-1", "send", { to: "a" }, t0)).toEqual({
      kind: "fresh",
    });
    expect(() => store.beginEffect("send:1", "run-1", "send", { to: "b" }, t0)).toThrow(
      IdempotencyKeyReuseError,
    );
  });

  it("answers a pending key as unknown and a finished one with its stored result", async () => {
    const store = new RoutineStore(await database());
    store.beginEffect("send:1", "run-1", "send", { to: "a" }, t0);
    expect(store.beginEffect("send:1", "run-2", "send", { to: "a" }, t0 + 5)).toEqual({
      kind: "unknown",
      startedAt: t0,
    });
    store.completeEffect("send:1", { id: 7 }, t0 + 9);
    expect(store.beginEffect("send:1", "run-2", "send", { to: "a" }, t0 + 10)).toEqual({
      kind: "done",
      result: { id: 7 },
    });
  });

  it("lets a definitely failed effect be attempted again", async () => {
    const store = new RoutineStore(await database());
    store.beginEffect("send:1", "run-1", "send", { to: "a" }, t0);
    store.failEffect("send:1", "connection refused", t0 + 1);
    expect(store.beginEffect("send:1", "run-2", "send", { to: "a" }, t0 + 2)).toEqual({
      kind: "fresh",
    });
  });

  it("indexes an unreadable routine with its problem and no digest", async () => {
    const store = new RoutineStore(await database());
    const indexed = store.index("wren", "bad", "bad.json", { problem: "not JSON" }, t0);
    expect(indexed.parse).toEqual({ problem: "not JSON" });
    expect(indexed.digest).toBeNull();
  });
});

function newRun(firedAt: number) {
  return {
    creature: "wren",
    routineId: "triage",
    attempt: 1,
    trigger: "cron" as const,
    catchUp: false,
    firedAt,
    scheduledFor: firedAt,
    status: "running" as const,
  };
}

function isDurable(write: ObservedWrite): boolean {
  return write.table === "effects" || write.table === "approvals";
}
