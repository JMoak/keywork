import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Campaign,
  type CampaignActor,
  type CampaignCommand,
  type CampaignEvent,
  type CreateCampaignInput,
  campaignSchema,
  createCampaign,
  type ModelSelection,
  transitionCampaign,
  type UsageReceipt,
  usageReceiptSchema,
} from "@keywork/campaigns";
import type { ProviderResponseReceipt } from "../provider.ts";
import { durableTransaction, openSqlite, type SqliteDatabase } from "../routines/sqlite.ts";

export interface CampaignSnapshot {
  campaign: Campaign;
  sequence: number;
}

export interface CampaignLease {
  campaignId: string;
  owner: string;
  generation: number;
  expiresAt: number;
}

export interface CampaignOperationIntent {
  id: string;
  campaignId: string;
  attemptId: string | null;
  stage: "planning" | "building" | "evaluating" | "delivery" | "probe";
  model: ModelSelection | null;
  maximumMicros: number;
  pricing: string;
  pricingAt: number;
  request: unknown;
}

export interface CampaignOperation extends CampaignOperationIntent {
  state: "reserved" | "dispatched" | "unknown" | "settled" | "released";
  createdAt: number;
  dispatchedAt: number | null;
  settledAt: number | null;
  reason: string | null;
  receipt: UsageReceipt;
  response?: ProviderResponseReceipt & { costMicros?: number };
}

export interface CampaignSpending {
  limitMicros: number;
  settledMicros: number;
  estimatedMicros: number;
  reservedMicros: number;
  remainingMicros: number;
  unresolvedOperations: number;
}

export class CampaignStoreError extends Error {
  constructor(
    readonly code: "missing" | "conflict" | "lease" | "budget" | "operation" | "state" | "trust",
    message: string,
  ) {
    super(message);
    this.name = "CampaignStoreError";
  }
}

export class CampaignStore {
  static async open(path: string, now: () => number = Date.now): Promise<CampaignStore> {
    mkdirSync(dirname(path), { recursive: true });
    return new CampaignStore(await openSqlite(path), now);
  }

  private readonly listeners = new Set<(event: CampaignEvent) => void>();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => number = Date.now,
  ) {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    migrate(db);
  }

  close(): void {
    this.listeners.clear();
    this.db.close();
  }

  create(input: CreateCampaignInput): CampaignSnapshot {
    const campaign = createCampaign(input);
    const event = durableTransaction(this.db, () => {
      if (this.read(campaign.id))
        throw new CampaignStoreError("conflict", "campaign already exists");
      this.db.run(
        "INSERT INTO campaigns (id, revision, sequence, document) VALUES (?, ?, 0, ?)",
        campaign.id,
        campaign.revision,
        JSON.stringify(campaign),
      );
      return this.append(campaign, "created", "Campaign created", {
        id: campaign.ownerScope,
        role: "user",
      });
    });
    this.emit(event);
    return this.requiredSnapshot(campaign.id);
  }

  read(id: string): Campaign | undefined {
    const row = this.db.get("SELECT document FROM campaigns WHERE id = ?", id);
    return row === undefined ? undefined : campaignSchema.parse(JSON.parse(String(row.document)));
  }

  snapshot(id: string): CampaignSnapshot | undefined {
    const row = this.db.get("SELECT document, sequence FROM campaigns WHERE id = ?", id);
    return row === undefined
      ? undefined
      : {
          campaign: campaignSchema.parse(JSON.parse(String(row.document))),
          sequence: Number(row.sequence),
        };
  }

  list(): CampaignSnapshot[] {
    return this.db.all("SELECT document, sequence FROM campaigns ORDER BY id").map((row) => ({
      campaign: campaignSchema.parse(JSON.parse(String(row.document))),
      sequence: Number(row.sequence),
    }));
  }

  apply(
    id: string,
    command: CampaignCommand,
    actor: CampaignActor,
    lease?: CampaignLease,
  ): CampaignSnapshot {
    return this.applyBatch(id, [command], actor, lease);
  }

  applyBatch(
    id: string,
    commands: readonly CampaignCommand[],
    actor: CampaignActor,
    lease?: CampaignLease,
  ): CampaignSnapshot {
    const events = durableTransaction(this.db, () =>
      commands.map((command) => {
        if (lease !== undefined) this.requireLease(lease, id);
        const current = this.required(id);
        const applied = this.db.get(
          "SELECT document FROM campaign_events WHERE campaign_id = ? AND command_id = ?",
          id,
          command.id,
        );
        if (applied !== undefined)
          throw new CampaignStoreError("conflict", "command already applied; reload the campaign");
        const result = transitionCampaign(current, command, actor);
        this.save(result.campaign, current.revision);
        return this.append(
          result.campaign,
          result.event.kind,
          result.event.summary,
          actor,
          command.id,
          result.event.refs,
        );
      }),
    );
    for (const event of events) this.emit(event);
    return this.requiredSnapshot(id);
  }

  events(id: string, after = 0, limit = 500): CampaignEvent[] {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new CampaignStoreError("state", "invalid event cursor or limit");
    return this.db
      .all(
        "SELECT document FROM campaign_events WHERE campaign_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
        id,
        after,
        limit,
      )
      .map((row) => JSON.parse(String(row.document)) as CampaignEvent);
  }

  subscribe(listener: (event: CampaignEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  note(id: string, kind: string, summary: string, refs: string[], lease: CampaignLease): void {
    const event = durableTransaction(this.db, () => {
      this.requireLease(lease, id);
      return this.append(
        this.required(id),
        kind,
        summary,
        { id: "campaign-host", role: "controller" },
        randomUUID(),
        refs,
      );
    });
    this.emit(event);
  }

  claim(id: string, owner: string, ttlMs: number): CampaignLease | undefined {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300_000)
      throw new CampaignStoreError("lease", "invalid execution lease duration");
    return durableTransaction(this.db, () => {
      this.required(id);
      const row = this.db.get(
        "SELECT owner, generation, expires_at FROM campaign_leases WHERE campaign_id = ?",
        id,
      );
      const now = this.now();
      if (row !== undefined && Number(row.expires_at) > now) return undefined;
      const lease = {
        campaignId: id,
        owner,
        generation: Number(row?.generation ?? 0) + 1,
        expiresAt: now + ttlMs,
      };
      this.db.run(
        "INSERT INTO campaign_leases (campaign_id, owner, generation, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(campaign_id) DO UPDATE SET owner = excluded.owner, generation = excluded.generation, expires_at = excluded.expires_at",
        id,
        owner,
        lease.generation,
        lease.expiresAt,
      );
      return lease;
    });
  }

  renew(lease: CampaignLease, ttlMs: number): CampaignLease {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300_000)
      throw new CampaignStoreError("lease", "invalid execution lease duration");
    return durableTransaction(this.db, () => {
      this.requireLease(lease, lease.campaignId);
      const expiresAt = this.now() + ttlMs;
      this.db.run(
        "UPDATE campaign_leases SET expires_at = ? WHERE campaign_id = ?",
        expiresAt,
        lease.campaignId,
      );
      return { ...lease, expiresAt };
    });
  }

  release(lease: CampaignLease): void {
    this.db.run(
      "UPDATE campaign_leases SET expires_at = 0 WHERE campaign_id = ? AND owner = ? AND generation = ?",
      lease.campaignId,
      lease.owner,
      lease.generation,
    );
  }

  reserve(intent: CampaignOperationIntent, lease: CampaignLease): CampaignOperation {
    let event: CampaignEvent | undefined;
    const operation = durableTransaction(this.db, () => {
      this.requireLease(lease, intent.campaignId);
      const existing = this.operation(intent.id);
      if (existing !== undefined) {
        if (digest(intentOf(existing)) !== digest(intent))
          throw new CampaignStoreError(
            "operation",
            "operation identity was reused with different parameters",
          );
        return existing;
      }
      const campaign = this.required(intent.campaignId);
      if (campaign.status !== "running" || campaign.controlRequested !== null)
        throw new CampaignStoreError("state", "campaign is not running or a stop is pending");
      if (!Number.isSafeInteger(intent.maximumMicros) || intent.maximumMicros < 0)
        throw new CampaignStoreError("budget", "operation needs a bounded cost");
      const spending = this.spending(intent.campaignId);
      const protectedMicros =
        (intent.stage === "evaluating" || intent.stage === "delivery"
          ? 0
          : campaign.budget.evaluationReserveMicros) +
        (intent.stage === "delivery" ? 0 : campaign.budget.deliveryReserveMicros);
      if (intent.maximumMicros > spending.remainingMicros - protectedMicros)
        throw new CampaignStoreError(
          "budget",
          "operation would consume the campaign or protected evaluation and delivery budget",
        );
      const probe =
        campaign.attempts.find((attempt) => attempt.id === intent.attemptId)?.probe === true;
      if (
        probe &&
        intent.maximumMicros >
          campaign.persistence.spendLimitMicros -
            campaign.persistence.spentMicros -
            campaign.persistence.reservedMicros
      )
        throw new CampaignStoreError(
          "budget",
          "operation would exceed the authorized persistence allowance",
        );
      const now = this.now();
      const receipt: UsageReceipt = {
        id: intent.id,
        operationId: intent.id,
        attemptId: intent.attemptId,
        providerRequestId: null,
        stage: intent.stage,
        model: intent.model,
        currency: "USD",
        reservedMicros: intent.maximumMicros,
        costMicros: null,
        state: "reserved",
        costSource: intent.pricing,
        pricingAt: intent.pricingAt,
        recordedAt: now,
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
      };
      const next: CampaignOperation = {
        ...intent,
        state: "reserved",
        createdAt: now,
        dispatchedAt: null,
        settledAt: null,
        reason: null,
        receipt,
      };
      this.db.run(
        "INSERT INTO campaign_operations (id, campaign_id, document) VALUES (?, ?, ?)",
        intent.id,
        intent.campaignId,
        JSON.stringify(next),
      );
      event = this.projectReceipt(campaign, receipt, "usage.reserved", "Reserved operation budget");
      return next;
    });
    if (event !== undefined) this.emit(event);
    return operation;
  }

  dispatch(id: string, lease: CampaignLease): CampaignOperation {
    return this.changeOperation(
      id,
      lease,
      (operation, campaign) => {
        if (campaign.status !== "running" || campaign.controlRequested !== null)
          throw new CampaignStoreError("state", "dispatch stopped by campaign state");
        if (operation.state !== "reserved")
          throw new CampaignStoreError("operation", "operation is not available for dispatch");
        return { ...operation, state: "dispatched", dispatchedAt: this.now() };
      },
      "operation.dispatched",
      "Operation dispatched",
    );
  }

  settle(id: string, receipt: UsageReceipt, lease: CampaignLease): CampaignOperation {
    usageReceiptSchema.parse(receipt);
    return this.changeOperation(
      id,
      lease,
      (operation) => {
        if (
          receipt.operationId !== id ||
          receipt.id !== operation.receipt.id ||
          receipt.attemptId !== operation.attemptId ||
          receipt.stage !== operation.stage ||
          receipt.reservedMicros !== operation.maximumMicros
        )
          throw new CampaignStoreError("operation", "receipt does not match the operation");
        if (
          receipt.state !== "reported" &&
          receipt.state !== "reconciled" &&
          receipt.state !== "estimated"
        )
          throw new CampaignStoreError("operation", "receipt has no accounted outcome");
        if (receipt.costMicros === null)
          throw new CampaignStoreError("operation", "receipt cost is unresolved");
        if (operation.state === "released" || operation.state === "reserved")
          throw new CampaignStoreError("operation", "operation was never dispatched");
        if (operation.state === "settled") {
          if (digest(operation.receipt) === digest(receipt)) return operation;
          if (operation.receipt.state !== "estimated" || receipt.state === "estimated")
            throw new CampaignStoreError(
              "conflict",
              "settled receipt differs; reconcile explicitly",
            );
        }
        return { ...operation, state: "settled", settledAt: this.now(), receipt };
      },
      "usage.settled",
      "Operation usage accounted",
    );
  }

  observeResponse(
    id: string,
    response: ProviderResponseReceipt & { costMicros?: number },
    lease: CampaignLease,
  ): CampaignOperation {
    return this.changeOperation(
      id,
      lease,
      (operation) => {
        if (operation.state !== "dispatched" && operation.state !== "unknown")
          throw new CampaignStoreError(
            "operation",
            "response metadata requires a dispatched operation",
          );
        if (
          response.costMicros !== undefined &&
          (!Number.isSafeInteger(response.costMicros) || response.costMicros < 0)
        )
          throw new CampaignStoreError("operation", "observed cost is invalid");
        const combined = { ...operation.response, ...response };
        const costMicros =
          response.costMicros === undefined
            ? operation.receipt.costMicros
            : Math.max(response.costMicros, operation.receipt.costMicros ?? 0);
        return {
          ...operation,
          response: combined,
          receipt: {
            ...operation.receipt,
            costMicros,
            providerRequestId:
              combined.responseId ?? combined.requestId ?? operation.receipt.providerRequestId,
            recordedAt: this.now(),
          },
        };
      },
      "operation.response",
      "Provider response identity recorded",
    );
  }

  unknown(id: string, reason: string, lease: CampaignLease): CampaignOperation {
    return this.changeOperation(
      id,
      lease,
      (operation) => {
        if (operation.state !== "dispatched" && operation.state !== "unknown")
          throw new CampaignStoreError(
            "operation",
            "only dispatched operations can have unknown outcomes",
          );
        return {
          ...operation,
          state: "unknown",
          reason,
          receipt: { ...operation.receipt, state: "unknown", recordedAt: this.now() },
        };
      },
      "operation.unknown",
      reason,
      true,
    );
  }

  releaseReservation(id: string, lease: CampaignLease): CampaignOperation {
    return this.changeOperation(
      id,
      lease,
      (operation) => {
        if (operation.state !== "reserved")
          throw new CampaignStoreError(
            "operation",
            "a dispatched reservation cannot be released without reconciliation",
          );
        return {
          ...operation,
          state: "released",
          settledAt: this.now(),
          receipt: {
            ...operation.receipt,
            state: "released",
            costMicros: 0,
            recordedAt: this.now(),
          },
        };
      },
      "usage.released",
      "Undispatched reservation released",
    );
  }

  operation(id: string): CampaignOperation | undefined {
    const row = this.db.get("SELECT document FROM campaign_operations WHERE id = ?", id);
    return row === undefined ? undefined : (JSON.parse(String(row.document)) as CampaignOperation);
  }

  operations(id: string): CampaignOperation[] {
    return this.db
      .all("SELECT document FROM campaign_operations WHERE campaign_id = ? ORDER BY rowid", id)
      .map((row) => JSON.parse(String(row.document)) as CampaignOperation);
  }

  spending(id: string): CampaignSpending {
    const campaign = this.required(id);
    let settledMicros = 0;
    let estimatedMicros = 0;
    let reservedMicros = 0;
    let unresolvedOperations = 0;
    for (const operation of this.operations(id)) {
      if (operation.state === "released") continue;
      if (operation.state === "settled" && operation.receipt.state !== "estimated")
        settledMicros += operation.receipt.costMicros ?? 0;
      else {
        if (operation.receipt.state === "estimated")
          estimatedMicros += operation.receipt.costMicros ?? 0;
        reservedMicros += Math.max(operation.maximumMicros, operation.receipt.costMicros ?? 0);
        if (operation.state === "unknown") unresolvedOperations += 1;
      }
    }
    return {
      limitMicros: campaign.budget.limitMicros,
      settledMicros,
      estimatedMicros,
      reservedMicros,
      remainingMicros: Math.max(0, campaign.budget.limitMicros - settledMicros - reservedMicros),
      unresolvedOperations,
    };
  }

  recover(lease: CampaignLease): CampaignSnapshot {
    for (const operation of this.operations(lease.campaignId)) {
      if (operation.state === "reserved") this.releaseReservation(operation.id, lease);
      if (operation.state === "dispatched")
        this.unknown(
          operation.id,
          "Execution stopped before an outcome was recorded; reconcile before retrying",
          lease,
        );
    }
    return this.requiredSnapshot(lease.campaignId);
  }

  private changeOperation(
    id: string,
    lease: CampaignLease,
    change: (operation: CampaignOperation, campaign: Campaign) => CampaignOperation,
    kind: string,
    summary: string,
    wait = false,
  ): CampaignOperation {
    let event: CampaignEvent | undefined;
    const result = durableTransaction(this.db, () => {
      const current = this.operation(id);
      if (current === undefined)
        throw new CampaignStoreError("missing", "unknown campaign operation");
      this.requireLease(lease, current.campaignId);
      const campaign = this.required(current.campaignId);
      const next = change(current, campaign);
      if (digest(current) === digest(next)) return current;
      this.db.run(
        "UPDATE campaign_operations SET document = ? WHERE id = ?",
        JSON.stringify(next),
        id,
      );
      event = this.projectReceipt(campaign, next.receipt, kind, summary, wait);
      return next;
    });
    if (event !== undefined) this.emit(event);
    return result;
  }

  private projectReceipt(
    campaign: Campaign,
    receipt: UsageReceipt,
    kind: string,
    summary: string,
    wait = false,
  ): CampaignEvent {
    const actor = { id: "campaign-ledger", role: "controller" } as const;
    const command = {
      id: randomUUID(),
      expectedRevision: campaign.revision,
      at: Math.max(this.now(), campaign.updatedAt),
      type: "record-usage",
      receipt,
    } as const;
    const projected = transitionCampaign(campaign, command, actor).campaign;
    const blocking = wait && campaign.status !== "cancelled" && campaign.status !== "completed";
    const next: Campaign = {
      ...projected,
      ...(blocking
        ? ({ status: "waiting", waitingReason: "reconciliation", statusReason: summary } as const)
        : {}),
    };
    this.save(next, campaign.revision);
    return this.append(next, kind, summary, actor, command.id, [receipt.operationId]);
  }

  private save(campaign: Campaign, expectedRevision: number): void {
    campaignSchema.parse(campaign);
    const result = this.db.run(
      "UPDATE campaigns SET document = ?, revision = ? WHERE id = ? AND revision = ?",
      JSON.stringify(campaign),
      campaign.revision,
      campaign.id,
      expectedRevision,
    );
    if (result.changes !== 1) throw new CampaignStoreError("conflict", "campaign revision changed");
  }

  private append(
    campaign: Campaign,
    kind: string,
    summary: string,
    actor: CampaignActor,
    commandId: string = randomUUID(),
    refs: string[] = [],
  ): CampaignEvent {
    const row = this.db.get("SELECT sequence FROM campaigns WHERE id = ?", campaign.id);
    const sequence = Number(row?.sequence ?? 0) + 1;
    const event: CampaignEvent = {
      schemaVersion: 1,
      id: randomUUID(),
      campaignId: campaign.id,
      sequence,
      commandId,
      kind,
      at: this.now(),
      actor,
      summary,
      refs,
    };
    this.db.run(
      "INSERT INTO campaign_events (campaign_id, sequence, command_id, document) VALUES (?, ?, ?, ?)",
      campaign.id,
      sequence,
      commandId,
      JSON.stringify(event),
    );
    this.db.run("UPDATE campaigns SET sequence = ? WHERE id = ?", sequence, campaign.id);
    return event;
  }

  private requireLease(lease: CampaignLease, campaignId: string): void {
    const row = this.db.get(
      "SELECT owner, generation, expires_at FROM campaign_leases WHERE campaign_id = ?",
      campaignId,
    );
    if (
      lease.campaignId !== campaignId ||
      row?.owner !== lease.owner ||
      Number(row?.generation) !== lease.generation ||
      Number(row?.expires_at) <= this.now()
    )
      throw new CampaignStoreError(
        "lease",
        "campaign execution lease is absent, expired, or superseded",
      );
  }

  private required(id: string): Campaign {
    const campaign = this.read(id);
    if (campaign === undefined) throw new CampaignStoreError("missing", "no campaign has that id");
    return campaign;
  }

  private requiredSnapshot(id: string): CampaignSnapshot {
    const snapshot = this.snapshot(id);
    if (snapshot === undefined) throw new CampaignStoreError("missing", "no campaign has that id");
    return snapshot;
  }

  private emit(event: CampaignEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }
}

function intentOf(operation: CampaignOperation): CampaignOperationIntent {
  const { id, campaignId, attemptId, stage, model, maximumMicros, pricing, pricingAt, request } =
    operation;
  return { id, campaignId, attemptId, stage, model, maximumMicros, pricing, pricingAt, request };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function migrate(db: SqliteDatabase): void {
  const version = Number(db.get("PRAGMA user_version")?.user_version ?? 0);
  if (version > 1)
    throw new CampaignStoreError("state", "campaign database is newer than this runtime");
  if (version === 1) return;
  durableTransaction(db, () => {
    db.exec(`CREATE TABLE campaigns (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, sequence INTEGER NOT NULL, document TEXT NOT NULL);
      CREATE TABLE campaign_events (campaign_id TEXT NOT NULL REFERENCES campaigns(id), sequence INTEGER NOT NULL, command_id TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(campaign_id, sequence), UNIQUE(campaign_id, command_id));
      CREATE TABLE campaign_operations (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), document TEXT NOT NULL);
      CREATE INDEX campaign_operation_owner ON campaign_operations(campaign_id);
      CREATE TABLE campaign_leases (campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id), owner TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      PRAGMA user_version = 1;`);
  });
}
