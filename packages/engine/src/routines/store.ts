import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isoOf } from "./clock.ts";
import { grantDigest, type RoutineParse } from "./routine.ts";
import type {
  RunDelivery,
  RunEnding,
  RunProcess,
  RunRow,
  RunStatus,
  RunTrigger,
  RunUsage,
} from "./run.ts";
import {
  durableTransaction,
  openSqlite,
  type SqliteDatabase,
  type SqliteRow,
  type SqliteValue,
  transaction,
} from "./sqlite.ts";

export interface IndexedRoutine {
  creature: string;
  id: string;
  file: string;
  parse: RoutineParse;
  digest: string | null;
  anchorAt: number;
  handledThrough: number | null;
  retryAt: number | null;
  consecutiveErrors: number;
  disabled: { reason: string; at: number } | null;
  accepted: { digest: string; at: number } | null;
}

export interface NewRun {
  creature: string;
  routineId: string;
  attempt: number;
  trigger: RunTrigger;
  catchUp: boolean;
  firedAt: number;
  scheduledFor: number;
  status: RunStatus;
  reason?: string;
  endedAt?: number;
}

export type EffectState = "pending" | "done" | "failed";

export interface EffectRow {
  key: string;
  runId: string;
  kind: string;
  state: EffectState;
  result: unknown;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

export type EffectBegin =
  | { kind: "fresh" }
  | { kind: "done"; result: unknown }
  | { kind: "unknown"; startedAt: number };

export class IdempotencyKeyReuseError extends Error {
  constructor(readonly key: string) {
    super(`effect key "${key}" was first used with different parameters`);
    this.name = "IdempotencyKeyReuseError";
  }
}

export type ApprovalState = "pending" | "granted" | "denied" | "expired";

export interface ApprovalRow {
  callId: string;
  runId: string;
  tool: string;
  approvalClass: string;
  state: ApprovalState;
  requestedAt: number;
  deadlineAt: number;
  decidedAt: number | null;
}

export class RoutineStore {
  static async open(path: string): Promise<RoutineStore> {
    mkdirSync(dirname(path), { recursive: true });
    return new RoutineStore(await openSqlite(path));
  }

  constructor(private readonly db: SqliteDatabase) {
    configure(db);
    migrate(db);
  }

  close(): void {
    this.db.close();
  }

  journalMode(): string {
    return String(this.db.get("PRAGMA journal_mode")?.journal_mode ?? "");
  }

  index(creature: string, id: string, file: string, parse: RoutineParse, now: number) {
    const definition = "routine" in parse ? JSON.stringify(parse.routine) : null;
    const problem = "problem" in parse ? parse.problem : null;
    const digest = "routine" in parse ? grantDigest(parse.routine) : null;
    this.db.run(
      `INSERT INTO routines (creature, id, file, definition, problem, digest, anchor_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (creature, id) DO UPDATE SET
         file = excluded.file, definition = excluded.definition,
         problem = excluded.problem, digest = excluded.digest`,
      creature,
      id,
      file,
      definition,
      problem,
      digest,
      now,
    );
    return this.routine(creature, id) as IndexedRoutine;
  }

  forget(creature: string, id: string): boolean {
    this.db.run("DELETE FROM hooks WHERE creature = ? AND routine_id = ?", creature, id);
    return (
      this.db.run("DELETE FROM routines WHERE creature = ? AND id = ?", creature, id).changes > 0
    );
  }

  setHookToken(creature: string, id: string, tokenDigest: string, at: number): void {
    this.db.run(
      `INSERT INTO hooks (creature, routine_id, token_digest, minted_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (creature, routine_id) DO UPDATE SET
         token_digest = excluded.token_digest, minted_at = excluded.minted_at`,
      creature,
      id,
      tokenDigest,
      at,
    );
  }

  hookTokenDigest(creature: string, id: string): string | undefined {
    const row = this.db.get(
      "SELECT token_digest FROM hooks WHERE creature = ? AND routine_id = ?",
      creature,
      id,
    );
    return row === undefined ? undefined : String(row.token_digest);
  }

  routine(creature: string, id: string): IndexedRoutine | undefined {
    const row = this.db.get("SELECT * FROM routines WHERE creature = ? AND id = ?", creature, id);
    return row === undefined ? undefined : indexedRoutineOf(row);
  }

  routines(creature?: string): IndexedRoutine[] {
    const rows =
      creature === undefined
        ? this.db.all("SELECT * FROM routines ORDER BY creature, id")
        : this.db.all("SELECT * FROM routines WHERE creature = ? ORDER BY id", creature);
    return rows.map(indexedRoutineOf);
  }

  markHandled(creature: string, id: string, through: number): void {
    this.update(creature, id, "handled_through = max(coalesce(handled_through, 0), ?)", through);
  }

  recordFailure(creature: string, id: string, retryAt: number): number {
    this.update(creature, id, "consecutive_errors = consecutive_errors + 1, retry_at = ?", retryAt);
    return this.routine(creature, id)?.consecutiveErrors ?? 0;
  }

  recordRetry(creature: string, id: string, retryAt: number): void {
    this.update(creature, id, "retry_at = ?", retryAt);
  }

  recordSuccess(creature: string, id: string): void {
    this.update(creature, id, "consecutive_errors = 0, retry_at = NULL");
  }

  clearRetry(creature: string, id: string): void {
    this.update(creature, id, "retry_at = NULL");
  }

  disable(creature: string, id: string, reason: string, at: number): void {
    this.update(creature, id, "disabled_reason = ?, disabled_at = ?, retry_at = NULL", reason, at);
  }

  reinstate(creature: string, id: string): void {
    this.update(
      creature,
      id,
      "disabled_reason = NULL, disabled_at = NULL, consecutive_errors = 0, retry_at = NULL",
    );
  }

  accept(creature: string, id: string, digest: string, at: number): void {
    this.update(creature, id, "accepted_digest = ?, accepted_at = ?", digest, at);
  }

  insertRun(run: NewRun): RunRow | undefined {
    const runId = runIdOf(run.creature, run.routineId, run.firedAt, run.attempt);
    const inserted = this.db.run(
      `INSERT INTO runs (run_id, creature, routine_id, attempt, trigger, catch_up, fired_at,
         scheduled_for, status, reason, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      runId,
      run.creature,
      run.routineId,
      run.attempt,
      run.trigger,
      run.catchUp ? 1 : 0,
      run.firedAt,
      run.scheduledFor,
      run.status,
      run.reason ?? null,
      run.endedAt ?? null,
    );
    return inserted.changes === 0 ? undefined : this.run(runId);
  }

  startRun(runId: string, sessionId: string, at: number): void {
    this.db.run(
      `UPDATE runs SET session_id = ?, started_at = ?, status = 'running',
         reason = NULL, notify_tier = NULL, notify_at = NULL
       WHERE run_id = ?`,
      sessionId,
      at,
      runId,
    );
  }

  holdRun(runId: string, reason: string, notify: RunEnding["notify"]): RunRow {
    this.db.run(
      "UPDATE runs SET status = 'parked', reason = ?, notify_tier = ?, notify_at = ? WHERE run_id = ?",
      reason,
      notify.tier,
      notify.at,
      runId,
    );
    return this.run(runId) as RunRow;
  }

  heldRun(creature: string, routineId: string): RunRow | undefined {
    const row = this.db.get(
      `SELECT * FROM runs WHERE creature = ? AND routine_id = ? AND status = 'parked'
         AND session_id IS NULL ORDER BY fired_at DESC LIMIT 1`,
      creature,
      routineId,
    );
    return row === undefined ? undefined : runRowOf(row);
  }

  setActiveStatus(runId: string, status: "running" | "parked", reason: string | null = null): void {
    this.db.run("UPDATE runs SET status = ?, reason = ? WHERE run_id = ?", status, reason, runId);
  }

  endRun(runId: string, ending: RunEnding, at: number): RunRow {
    this.db.run(
      `UPDATE runs SET status = 'ended', ended_at = ?, process = ?, delivery = ?, verified = ?,
         reason = ?, usage = ?, cost_usd = ?, output = ?, notify_tier = ?, notify_at = ?
       WHERE run_id = ?`,
      at,
      ending.process,
      ending.delivery,
      ending.verified === null ? null : ending.verified ? 1 : 0,
      ending.reason,
      ending.usage === null ? null : JSON.stringify(ending.usage),
      ending.costUsd,
      ending.output,
      ending.notify.tier,
      ending.notify.at,
      runId,
    );
    return this.run(runId) as RunRow;
  }

  run(runId: string): RunRow | undefined {
    const row = this.db.get("SELECT * FROM runs WHERE run_id = ?", runId);
    return row === undefined ? undefined : runRowOf(row);
  }

  runs(creature: string, routineId: string, limit: number): RunRow[] {
    return this.db
      .all(
        `SELECT * FROM runs WHERE creature = ? AND routine_id = ?
         ORDER BY fired_at DESC, attempt DESC LIMIT ?`,
        creature,
        routineId,
        limit,
      )
      .map(runRowOf);
  }

  activeRuns(): RunRow[] {
    return this.db
      .all("SELECT * FROM runs WHERE status IN ('running', 'parked') ORDER BY fired_at")
      .map(runRowOf);
  }

  countFiredSince(creature: string, routineId: string | undefined, since: number): number {
    const counted =
      routineId === undefined
        ? this.db.get(
            `SELECT count(*) AS n FROM runs WHERE creature = ? AND trigger != 'manual'
               AND status NOT IN ('skipped', 'dropped') AND scheduled_for > ?`,
            creature,
            since,
          )
        : this.db.get(
            `SELECT count(*) AS n FROM runs WHERE creature = ? AND routine_id = ?
               AND trigger != 'manual' AND status NOT IN ('skipped', 'dropped')
               AND scheduled_for > ?`,
            creature,
            routineId,
            since,
          );
    return Number(counted?.n ?? 0);
  }

  beginEffect(key: string, runId: string, kind: string, params: unknown, at: number): EffectBegin {
    const digest = digestOf(params);
    return durableTransaction(this.db, () => {
      const existing = this.db.get("SELECT * FROM effects WHERE key = ?", key);
      if (existing !== undefined && existing.params_digest !== digest) {
        throw new IdempotencyKeyReuseError(key);
      }
      if (existing?.state === "done") return { kind: "done", result: parsedJson(existing.result) };
      if (existing?.state === "pending") {
        return { kind: "unknown", startedAt: Number(existing.started_at) };
      }
      this.db.run(
        `INSERT INTO effects (key, run_id, kind, params_digest, state, started_at)
         VALUES (?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (key) DO UPDATE SET state = 'pending', run_id = excluded.run_id,
           started_at = excluded.started_at, error = NULL, ended_at = NULL`,
        key,
        runId,
        kind,
        digest,
        at,
      );
      return { kind: "fresh" };
    });
  }

  completeEffect(key: string, result: unknown, at: number): void {
    durableTransaction(this.db, () =>
      this.db.run(
        "UPDATE effects SET state = 'done', result = ?, ended_at = ? WHERE key = ?",
        JSON.stringify(result ?? null),
        at,
        key,
      ),
    );
  }

  failEffect(key: string, error: string, at: number): void {
    durableTransaction(this.db, () =>
      this.db.run(
        "UPDATE effects SET state = 'failed', error = ?, ended_at = ? WHERE key = ?",
        error,
        at,
        key,
      ),
    );
  }

  effectsOf(runId: string): EffectRow[] {
    return this.db
      .all("SELECT * FROM effects WHERE run_id = ? ORDER BY started_at, key", runId)
      .map(effectRowOf);
  }

  parkApproval(approval: Omit<ApprovalRow, "state" | "decidedAt">): void {
    durableTransaction(this.db, () =>
      this.db.run(
        `INSERT INTO approvals (call_id, run_id, tool, class, state, requested_at, deadline_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (call_id) DO NOTHING`,
        approval.callId,
        approval.runId,
        approval.tool,
        approval.approvalClass,
        approval.requestedAt,
        approval.deadlineAt,
      ),
    );
  }

  settleApproval(callId: string, state: Exclude<ApprovalState, "pending">, at: number): boolean {
    return durableTransaction(
      this.db,
      () =>
        this.db.run(
          `UPDATE approvals SET state = ?, decided_at = ? WHERE call_id = ? AND state = 'pending'`,
          state,
          at,
          callId,
        ).changes > 0,
    );
  }

  pendingApprovals(runId?: string): ApprovalRow[] {
    const rows =
      runId === undefined
        ? this.db.all("SELECT * FROM approvals WHERE state = 'pending' ORDER BY deadline_at")
        : this.db.all(
            "SELECT * FROM approvals WHERE state = 'pending' AND run_id = ? ORDER BY deadline_at",
            runId,
          );
    return rows.map(approvalRowOf);
  }

  private update(creature: string, id: string, assignments: string, ...values: SqliteValue[]) {
    this.db.run(
      `UPDATE routines SET ${assignments} WHERE creature = ? AND id = ?`,
      ...values,
      creature,
      id,
    );
  }
}

export function runIdOf(creature: string, routineId: string, firedAt: number, attempt: number) {
  const identity = `${creature}\n${routineId}\n${firedAt}\n${attempt}`;
  return `run-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

export const schemaVersion = 2;

const migrations: readonly (readonly string[])[] = [
  [
    `CREATE TABLE routines (
       creature TEXT NOT NULL,
       id TEXT NOT NULL,
       file TEXT NOT NULL,
       definition TEXT,
       problem TEXT,
       digest TEXT,
       anchor_at INTEGER NOT NULL,
       handled_through INTEGER,
       retry_at INTEGER,
       consecutive_errors INTEGER NOT NULL DEFAULT 0,
       disabled_reason TEXT,
       disabled_at INTEGER,
       accepted_digest TEXT,
       accepted_at INTEGER,
       PRIMARY KEY (creature, id)
     ) STRICT`,
    `CREATE TABLE runs (
       run_id TEXT PRIMARY KEY,
       creature TEXT NOT NULL,
       routine_id TEXT NOT NULL,
       attempt INTEGER NOT NULL,
       trigger TEXT NOT NULL,
       catch_up INTEGER NOT NULL,
       fired_at INTEGER NOT NULL,
       scheduled_for INTEGER NOT NULL,
       status TEXT NOT NULL,
       session_id TEXT,
       started_at INTEGER,
       ended_at INTEGER,
       process TEXT,
       delivery TEXT,
       verified INTEGER,
       reason TEXT,
       usage TEXT,
       cost_usd REAL,
       output TEXT,
       notify_tier TEXT,
       notify_at INTEGER,
       UNIQUE (creature, routine_id, fired_at, attempt)
     ) STRICT`,
    "CREATE INDEX runs_by_routine ON runs (creature, routine_id, fired_at)",
    "CREATE INDEX runs_by_status ON runs (status)",
    `CREATE TABLE effects (
       key TEXT PRIMARY KEY,
       run_id TEXT NOT NULL,
       kind TEXT NOT NULL,
       params_digest TEXT NOT NULL,
       state TEXT NOT NULL,
       result TEXT,
       error TEXT,
       started_at INTEGER NOT NULL,
       ended_at INTEGER
     ) STRICT`,
    "CREATE INDEX effects_by_run ON effects (run_id)",
    `CREATE TABLE approvals (
       call_id TEXT PRIMARY KEY,
       run_id TEXT NOT NULL,
       tool TEXT NOT NULL,
       class TEXT NOT NULL,
       state TEXT NOT NULL,
       requested_at INTEGER NOT NULL,
       deadline_at INTEGER NOT NULL,
       decided_at INTEGER
     ) STRICT`,
  ],
  [
    `CREATE TABLE hooks (
       creature TEXT NOT NULL,
       routine_id TEXT NOT NULL,
       token_digest TEXT NOT NULL,
       minted_at INTEGER NOT NULL,
       PRIMARY KEY (creature, routine_id)
     ) STRICT`,
  ],
];

function configure(db: SqliteDatabase): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
}

function migrate(db: SqliteDatabase): void {
  const applied = Number(db.get("PRAGMA user_version")?.user_version ?? 0);
  migrations.slice(applied).forEach((statements, offset) => {
    transaction(db, () => {
      for (const statement of statements) db.exec(statement);
      db.exec(`PRAGMA user_version = ${applied + offset + 1}`);
    });
  });
}

function indexedRoutineOf(row: SqliteRow): IndexedRoutine {
  const definition = text(row.definition);
  return {
    creature: String(row.creature),
    id: String(row.id),
    file: String(row.file),
    parse:
      definition === null
        ? { problem: text(row.problem) ?? "unreadable" }
        : { routine: JSON.parse(definition) },
    digest: text(row.digest),
    anchorAt: Number(row.anchor_at),
    handledThrough: numeric(row.handled_through),
    retryAt: numeric(row.retry_at),
    consecutiveErrors: Number(row.consecutive_errors),
    disabled:
      row.disabled_reason === null
        ? null
        : { reason: String(row.disabled_reason), at: Number(row.disabled_at) },
    accepted:
      row.accepted_digest === null
        ? null
        : { digest: String(row.accepted_digest), at: Number(row.accepted_at) },
  };
}

function runRowOf(row: SqliteRow): RunRow {
  const tier = text(row.notify_tier);
  const cost = numeric(row.cost_usd);
  return {
    runId: String(row.run_id),
    creature: String(row.creature),
    routineId: String(row.routine_id),
    attempt: Number(row.attempt),
    trigger: String(row.trigger) as RunTrigger,
    catchUp: row.catch_up === 1,
    firedAt: isoOf(Number(row.fired_at)),
    scheduledFor: isoOf(Number(row.scheduled_for)),
    status: String(row.status) as RunStatus,
    sessionId: text(row.session_id),
    startedAt: isoOrNull(row.started_at),
    endedAt: isoOrNull(row.ended_at),
    process: text(row.process) as RunProcess | null,
    delivery: text(row.delivery) as RunDelivery | null,
    verified: row.verified === null ? null : row.verified === 1,
    reason: text(row.reason),
    usage: parsedJson(row.usage) as RunUsage | null,
    cost: cost === null ? null : { usd: cost },
    output: text(row.output),
    notify:
      tier === null
        ? null
        : { tier: tier as NonNullable<RunRow["notify"]>["tier"], at: isoOrNull(row.notify_at) },
  };
}

function effectRowOf(row: SqliteRow): EffectRow {
  return {
    key: String(row.key),
    runId: String(row.run_id),
    kind: String(row.kind),
    state: String(row.state) as EffectState,
    result: parsedJson(row.result),
    error: text(row.error),
    startedAt: Number(row.started_at),
    endedAt: numeric(row.ended_at),
  };
}

function approvalRowOf(row: SqliteRow): ApprovalRow {
  return {
    callId: String(row.call_id),
    runId: String(row.run_id),
    tool: String(row.tool),
    approvalClass: String(row.class),
    state: String(row.state) as ApprovalState,
    requestedAt: Number(row.requested_at),
    deadlineAt: Number(row.deadline_at),
    decidedAt: numeric(row.decided_at),
  };
}

function digestOf(params: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(params ?? null))
    .digest("hex");
}

function parsedJson(value: SqliteValue | undefined): unknown {
  return typeof value === "string" ? JSON.parse(value) : null;
}

function text(value: SqliteValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function numeric(value: SqliteValue | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function isoOrNull(value: SqliteValue | undefined): string | null {
  return value === null || value === undefined ? null : isoOf(Number(value));
}
