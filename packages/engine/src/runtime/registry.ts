import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqlite, type SqliteDatabase, transaction } from "../routines/sqlite.ts";

export type RuntimeProduct = "keywork" | "stead" | "keywork-cli";

export interface RuntimeVersion {
  version: string;
  contract: string;
}

export interface ManagedRuntime extends RuntimeVersion {
  binary: string;
  sha256: string;
  platform: string;
  arch: string;
}

export interface RuntimeConsumer extends RuntimeVersion {
  id: string;
  product: RuntimeProduct;
  installedAt: number;
}

export interface RuntimeClient extends RuntimeVersion {
  id: string;
  product: RuntimeProduct;
  workspace: string;
  pid: number;
  expiresAt: number;
}

export type RuntimeConflictCode =
  | "runtime-unavailable"
  | "incompatible-runtime"
  | "artifact-conflict"
  | "consumer-conflict"
  | "active-clients"
  | "active-work"
  | "client-conflict";

export type RuntimeRecovery =
  | "start-runtime"
  | "update-products"
  | "close-clients"
  | "finish-work"
  | "new-client";

export class RuntimeConflictError extends Error {
  constructor(
    readonly code: RuntimeConflictCode,
    message: string,
    readonly recovery: RuntimeRecovery,
  ) {
    super(message);
    this.name = "RuntimeConflictError";
  }
}

export const runtimeLeaseMs = 30_000;
export const runtimeHeartbeatMs = 10_000;

export interface RuntimeRetention {
  retain: boolean;
  reasons: ("consumers" | "clients" | "work")[];
}

export class RuntimeRegistry {
  private constructor(
    readonly file: string,
    private readonly database: SqliteDatabase,
  ) {}

  static async open(file: string): Promise<RuntimeRegistry> {
    mkdirSync(dirname(file), { recursive: true });
    const database = await openSqlite(file);
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = FULL");
      database.exec(
        "CREATE TABLE IF NOT EXISTS runtime_state (id TEXT PRIMARY KEY, record TEXT NOT NULL)",
      );
      database.exec(
        "CREATE TABLE IF NOT EXISTS runtime_consumers (id TEXT PRIMARY KEY, record TEXT NOT NULL)",
      );
      database.exec(
        "CREATE TABLE IF NOT EXISTS runtime_clients (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, record TEXT NOT NULL)",
      );
      return new RuntimeRegistry(file, database);
    } catch (cause) {
      database.close();
      throw cause;
    }
  }

  runtime(): ManagedRuntime | undefined {
    return this.read<ManagedRuntime>(
      this.database.get("SELECT record FROM runtime_state WHERE id = 'runtime'"),
    );
  }

  consumers(): RuntimeConsumer[] {
    return this.database
      .all("SELECT record FROM runtime_consumers ORDER BY id")
      .map((row) => this.read<RuntimeConsumer>(row) as RuntimeConsumer);
  }

  clients(now = Date.now()): RuntimeClient[] {
    return this.database
      .all("SELECT record FROM runtime_clients WHERE expires_at > ? ORDER BY id", now)
      .map((row) => this.read<RuntimeClient>(row) as RuntimeClient);
  }

  install(
    candidate: ManagedRuntime,
    consumer: RuntimeConsumer,
    options: { now?: number; authorizedWork?: boolean } = {},
  ): ManagedRuntime {
    if (!sameRuntime(candidate, consumer)) {
      throw incompatible(candidate, consumer);
    }
    return transaction(this.database, () => {
      const current = this.runtime();
      const now = options.now ?? Date.now();
      if (
        current !== undefined &&
        sameRuntime(current, candidate) &&
        current.sha256 !== candidate.sha256
      ) {
        throw new RuntimeConflictError(
          "artifact-conflict",
          "This engine version and contract have different binary contents. Build both products from the same tested engine artifact, or release a distinct engine version before replacing it.",
          "update-products",
        );
      }
      if (current !== undefined && !sameRuntime(current, candidate)) {
        this.admitReplacement(candidate, consumer.id, now, options.authorizedWork === true);
      }
      const selected =
        current !== undefined && sameRuntime(current, candidate) ? current : candidate;
      this.database.run(
        "INSERT INTO runtime_state (id, record) VALUES ('runtime', ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
        JSON.stringify(selected),
      );
      this.database.run(
        "INSERT INTO runtime_consumers (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
        consumer.id,
        JSON.stringify(consumer),
      );
      return selected;
    });
  }

  checkInstallation(
    candidate: RuntimeVersion,
    consumerId: string,
    options: { now?: number; authorizedWork?: boolean } = {},
  ): void {
    const current = this.runtime();
    if (current !== undefined && !sameRuntime(current, candidate)) {
      this.admitReplacement(
        candidate,
        consumerId,
        options.now ?? Date.now(),
        options.authorizedWork === true,
      );
    }
  }

  removeConsumer(id: string): boolean {
    return this.database.run("DELETE FROM runtime_consumers WHERE id = ?", id).changes > 0;
  }

  attach(client: RuntimeClient, now = Date.now()): ManagedRuntime {
    validateClient(client, now);
    return transaction(this.database, () => {
      const runtime = this.admit(client);
      const previous = this.read<RuntimeClient>(
        this.database.get("SELECT record FROM runtime_clients WHERE id = ?", client.id),
      );
      if (
        previous !== undefined &&
        (previous.product !== client.product ||
          previous.workspace !== client.workspace ||
          previous.pid !== client.pid)
      ) {
        throw new RuntimeConflictError(
          "client-conflict",
          "This client identity already belongs to another window or workspace; create a fresh client identity.",
          "new-client",
        );
      }
      this.database.run(
        "INSERT INTO runtime_clients (id, expires_at, record) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at, record = excluded.record",
        client.id,
        client.expiresAt,
        JSON.stringify(client),
      );
      return runtime;
    });
  }

  detach(id: string): boolean {
    return this.database.run("DELETE FROM runtime_clients WHERE id = ?", id).changes > 0;
  }

  prune(now: number, isAlive: (pid: number) => boolean): number {
    return transaction(this.database, () => {
      let removed = this.database.run(
        "DELETE FROM runtime_clients WHERE expires_at <= ?",
        now,
      ).changes;
      for (const client of this.clients(now)) {
        if (!isAlive(client.pid)) removed += Number(this.detach(client.id));
      }
      return removed;
    });
  }

  retention(authorizedWork: boolean, now = Date.now()): RuntimeRetention {
    const reasons: RuntimeRetention["reasons"] = [];
    if (this.consumers().length > 0) reasons.push("consumers");
    if (this.clients(now).length > 0) reasons.push("clients");
    if (authorizedWork) reasons.push("work");
    return { retain: reasons.length > 0, reasons };
  }

  close(): void {
    this.database.close();
  }

  admit(expected: RuntimeVersion): ManagedRuntime {
    const runtime = this.runtime();
    if (runtime === undefined) {
      throw new RuntimeConflictError(
        "runtime-unavailable",
        "No shared runtime is installed; install the engine before attaching this client.",
        "start-runtime",
      );
    }
    if (!sameRuntime(runtime, expected)) throw incompatible(runtime, expected);
    return runtime;
  }

  private admitReplacement(
    candidate: RuntimeVersion,
    replacingConsumer: string,
    now: number,
    authorizedWork: boolean,
  ): void {
    const incompatibleConsumers = this.consumers().filter(
      (consumer) => consumer.id !== replacingConsumer && !sameRuntime(consumer, candidate),
    );
    if (incompatibleConsumers.length > 0) {
      const products = [...new Set(incompatibleConsumers.map((consumer) => consumer.product))];
      throw new RuntimeConflictError(
        "consumer-conflict",
        `The shared engine is still required by ${products.join(" and ")}. Updating the apps one at a time cannot replace these registrations. Engine ${candidate.version} / contract ${candidate.contract} needs the explicit maintenance procedure in docs/runtime-upgrades.md: finish work, quit the apps, stop serving their workspaces, and remove the old product registrations before installing a compatible pair. Home and history files are preserved.`,
        "update-products",
      );
    }
    if (this.clients(now).length > 0) {
      throw new RuntimeConflictError(
        "active-clients",
        "The shared runtime has active clients; close their windows before replacing its engine.",
        "close-clients",
      );
    }
    if (authorizedWork) {
      throw new RuntimeConflictError(
        "active-work",
        "Authorized work or configured workspaces still need this runtime. Idle creatures and unavailable workspaces also retain it. After finishing current tasks, explicitly stop serving the affected workspaces using docs/runtime-upgrades.md before replacing the engine; keep their home and history files.",
        "finish-work",
      );
    }
  }

  private read<Value>(row: Readonly<Record<string, unknown>> | undefined): Value | undefined {
    return row === undefined ? undefined : (JSON.parse(String(row.record)) as Value);
  }
}

export function sameRuntime(left: RuntimeVersion, right: RuntimeVersion): boolean {
  return left.version === right.version && left.contract === right.contract;
}

function incompatible(actual: RuntimeVersion, expected: RuntimeVersion): RuntimeConflictError {
  return new RuntimeConflictError(
    "incompatible-runtime",
    `The shared runtime is engine ${actual.version} / contract ${actual.contract}; this client requires engine ${expected.version} / contract ${expected.contract}. Use a matching app release. Updating incompatible apps one at a time cannot replace old registrations; docs/runtime-upgrades.md describes the explicit maintenance procedure that preserves home and history.`,
    "update-products",
  );
}

function validateClient(client: RuntimeClient, now: number): void {
  if (
    client.id === "" ||
    client.workspace === "" ||
    !Number.isInteger(client.pid) ||
    client.pid <= 0 ||
    !Number.isFinite(client.expiresAt) ||
    client.expiresAt <= now ||
    client.expiresAt > now + runtimeLeaseMs
  ) {
    throw new Error(
      "A client lease needs an identity, workspace, process and expiry within 30 seconds.",
    );
  }
}
