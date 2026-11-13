import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqlite, type SqliteDatabase, transaction } from "../routines/sqlite.ts";

export type RuntimeProduct = "keywork" | "stead" | "keywork-cli";

export interface RuntimeVersion {
  version: string;
  contract: string;
}

export interface RuntimeRequirement extends RuntimeVersion {
  compatibility?: "contract";
}

export interface ManagedRuntime extends RuntimeVersion {
  binary: string;
  sha256: string;
  platform: string;
  arch: string;
}

export interface RuntimeConsumer extends RuntimeRequirement {
  id: string;
  product: RuntimeProduct;
  installedAt: number;
}

export interface RuntimeClient extends RuntimeRequirement {
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
  | "runtime-running"
  | "client-conflict";

export type RuntimeRecovery =
  | "start-runtime"
  | "update-products"
  | "close-clients"
  | "finish-work"
  | "stop-runtime"
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

export interface RuntimeSelection {
  runtime: ManagedRuntime;
  deferred?: {
    version: string;
    reason: "consumer-conflict" | "active-clients" | "active-work" | "runtime-running";
  };
}

interface InstallationOptions {
  now?: number;
  authorizedWork?: boolean;
  runtimeRunning?: boolean;
}

export interface RuntimeInstallation {
  runtime: ManagedRuntime;
  consumer: RuntimeConsumer;
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

  pendingInstallation(): RuntimeInstallation | undefined {
    return this.read<RuntimeInstallation>(
      this.database.get("SELECT record FROM runtime_state WHERE id = 'installation'"),
    );
  }

  prepareInstallation(installation: RuntimeInstallation): void {
    if (!runtimeSatisfies(installation.runtime, installation.consumer)) {
      throw incompatible(installation.runtime, installation.consumer);
    }
    this.database.run(
      "INSERT INTO runtime_state (id, record) VALUES ('installation', ?)",
      JSON.stringify(installation),
    );
  }

  completeInstallation(): ManagedRuntime {
    return transaction(this.database, () => {
      const installation = this.pendingInstallation();
      if (installation === undefined) throw new Error("No engine activation is pending");
      this.recordInstallation(installation.runtime, installation.consumer);
      this.database.run("DELETE FROM runtime_state WHERE id = 'installation'");
      return installation.runtime;
    });
  }

  install(
    candidate: ManagedRuntime,
    consumer: RuntimeConsumer,
    options: InstallationOptions = {},
  ): ManagedRuntime {
    return transaction(this.database, () => {
      this.requireSettledInstallation();
      const selected = this.selectInstallation(candidate, consumer, options).runtime;
      this.recordInstallation(selected, consumer);
      return selected;
    });
  }

  selectInstallation(
    candidate: ManagedRuntime,
    consumer: RuntimeConsumer,
    options: InstallationOptions = {},
  ): RuntimeSelection {
    if (!sameRuntime(candidate, consumer)) throw incompatible(candidate, consumer);
    const current = this.runtime();
    if (current === undefined) return { runtime: candidate };
    if (sameRuntime(current, candidate)) {
      if (current.sha256 !== candidate.sha256) {
        throw new RuntimeConflictError(
          "artifact-conflict",
          "This engine version and contract have different binary contents. Use the published immutable artifact or release a distinct engine version.",
          "update-products",
        );
      }
      return { runtime: current };
    }
    if (!newerRuntime(candidate.version, current.version)) {
      if (runtimeSatisfies(current, consumer)) return { runtime: current };
      throw incompatible(current, consumer);
    }
    try {
      this.admitReplacement(candidate, consumer.id, options);
    } catch (cause) {
      if (
        cause instanceof RuntimeConflictError &&
        runtimeSatisfies(current, consumer) &&
        (cause.code === "consumer-conflict" ||
          cause.code === "active-clients" ||
          cause.code === "active-work" ||
          cause.code === "runtime-running")
      ) {
        return { runtime: current, deferred: { version: candidate.version, reason: cause.code } };
      }
      throw cause;
    }
    return { runtime: candidate };
  }

  checkInstallation(
    candidate: RuntimeRequirement,
    consumerId: string,
    options: InstallationOptions = {},
  ): void {
    const current = this.runtime();
    if (current !== undefined && !runtimeSatisfies(current, candidate)) {
      if (!newerRuntime(candidate.version, current.version)) throw incompatible(current, candidate);
      this.admitReplacement(candidate, consumerId, options);
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

  admit(expected: RuntimeRequirement): ManagedRuntime {
    this.requireSettledInstallation();
    const runtime = this.runtime();
    if (runtime === undefined) {
      throw new RuntimeConflictError(
        "runtime-unavailable",
        "No shared runtime is installed; install the engine before attaching this client.",
        "start-runtime",
      );
    }
    if (!runtimeSatisfies(runtime, expected)) throw incompatible(runtime, expected);
    return runtime;
  }

  private admitReplacement(
    candidate: RuntimeVersion,
    replacingConsumer: string,
    options: InstallationOptions,
  ): void {
    const incompatibleConsumers = this.consumers().filter(
      (consumer) => consumer.id !== replacingConsumer && !runtimeSatisfies(candidate, consumer),
    );
    if (incompatibleConsumers.length > 0) {
      const products = [...new Set(incompatibleConsumers.map((consumer) => consumer.product))];
      throw new RuntimeConflictError(
        "consumer-conflict",
        `The shared engine is still required by ${products.join(" and ")} with a different contract or a legacy exact-version registration. Update legacy apps to contract-aware releases before retrying; different contracts require docs/runtime-upgrades.md maintenance. Home and history files are preserved.`,
        "update-products",
      );
    }
    if (this.clients(options.now ?? Date.now()).length > 0) {
      throw new RuntimeConflictError(
        "active-clients",
        "The shared runtime has active clients; close their windows before replacing its engine.",
        "close-clients",
      );
    }
    if (options.runtimeRunning) {
      throw new RuntimeConflictError(
        "runtime-running",
        "The compatible engine is still running. It remains available; finish work, close its clients, run keywork node stop, then retry installation to activate the newer engine.",
        "stop-runtime",
      );
    }
    if (options.authorizedWork) {
      throw new RuntimeConflictError(
        "active-work",
        "Authorized work or configured workspaces still need this runtime. Idle creatures and unavailable workspaces also retain it. After finishing current tasks, explicitly stop serving the affected workspaces using docs/runtime-upgrades.md before replacing the engine; keep their home and history files.",
        "finish-work",
      );
    }
  }

  private recordInstallation(runtime: ManagedRuntime, consumer: RuntimeConsumer): void {
    this.database.run(
      "INSERT INTO runtime_state (id, record) VALUES ('runtime', ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
      JSON.stringify(runtime),
    );
    this.database.run(
      "INSERT INTO runtime_consumers (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
      consumer.id,
      JSON.stringify(consumer),
    );
  }

  private requireSettledInstallation(): void {
    if (this.pendingInstallation() !== undefined) {
      throw new RuntimeConflictError(
        "runtime-unavailable",
        "An engine activation is incomplete. Retry consumer installation to repair the selected artifact before attaching clients; do not restore an older binary.",
        "start-runtime",
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

export function runtimeSatisfies(
  runtime: RuntimeVersion,
  requirement: RuntimeRequirement,
): boolean {
  return (
    runtime.contract === requirement.contract &&
    (requirement.compatibility === "contract" || runtime.version === requirement.version)
  );
}

function newerRuntime(candidate: string, current: string): boolean {
  const left = stableVersion(candidate);
  const right = stableVersion(current);
  for (const index of [0, 1, 2] as const) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

function stableVersion(version: string): readonly [number, number, number] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Shared-engine replacement requires stable published versions, got ${version}`);
  }
  const parts = version.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error("Invalid engine version");
  return parts as [number, number, number];
}

function incompatible(actual: RuntimeVersion, expected: RuntimeRequirement): RuntimeConflictError {
  return new RuntimeConflictError(
    "incompatible-runtime",
    `The shared runtime is engine ${actual.version} / contract ${actual.contract}; this client requires ${expected.compatibility === "contract" ? `contract ${expected.contract}` : `engine ${expected.version} / contract ${expected.contract} (legacy exact-version client)`}. Use a matching app release or update the legacy client. Engine downgrades are never automatic; docs/runtime-upgrades.md describes contract-changing maintenance that preserves home and history.`,
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
