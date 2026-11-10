import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type ArtifactManifest,
  type Attempt,
  type Campaign,
  type CampaignEvent,
  type CommandBody,
  campaignWorkloadSchema,
  currentPurpose,
  type Evaluation,
  type EvidenceItem,
  hasVerifiedEvidence,
  type ModelSelection,
  modelSelectionSchema,
  persistenceLimits,
  persistenceLimitsSchema,
  persistenceProfileSchema,
  planContinuation,
} from "@keywork/campaigns";
import { z } from "zod";
import { confinedPath, scopeContains, toolScope } from "../tools/confine.ts";
import type { CampaignCartridges, CartridgeSummary } from "./cartridges.ts";
import type { CampaignSources } from "./sources.ts";
import {
  type CampaignLease,
  type CampaignSnapshot,
  type CampaignStore,
  CampaignStoreError,
} from "./store.ts";

export const createCampaignRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(512),
  workload: campaignWorkloadSchema,
  objective: z.string().trim().min(1).max(16_000),
  criteria: z.array(z.string().trim().min(1).max(4000)).min(1).max(64),
  references: z.array(z.string().trim().min(1).max(4096)).max(128),
  model: z.strictObject({
    provider: z.string().trim().min(1).max(256),
    model: z.string().trim().min(1).max(512),
  }),
  budgetMicros: z.number().int().min(1).max(1_000_000_000),
  persistenceProfile: persistenceProfileSchema,
  artifactPath: z.string().trim().min(1).max(4096).optional(),
  text: z.string().max(1_000_000).optional(),
  sources: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(512),
        reference: z.string().trim().min(1).max(4096),
        text: z.string().min(1).max(500_000),
      }),
    )
    .max(16)
    .optional(),
});

export interface CampaignArtifactPreview {
  artifactId: string;
  path: string | null;
  mimeType: string;
  content: string | null;
  truncated: boolean;
  totalBytes: number;
}

export interface CampaignArtifactPort {
  capture(input: {
    sourcePath: string;
    allowedRoot: string;
    ownerScope: string;
    title: string;
    kind: ArtifactManifest["kind"];
    parentIds: string[];
    producerAttemptId: string | null;
  }): Promise<ArtifactManifest>;
  write(input: {
    files: Readonly<Record<string, string>>;
    ownerScope: string;
    title: string;
    kind: ArtifactManifest["kind"];
    parentIds: string[];
    producerAttemptId: string | null;
  }): Promise<ArtifactManifest>;
  preview(artifact: ArtifactManifest, path?: string): Promise<CampaignArtifactPreview>;
  export?(artifact: ArtifactManifest, destination: string): Promise<string>;
}

export interface CampaignExecutionResult {
  artifact: ArtifactManifest | null;
  evidence: EvidenceItem[];
  evaluation: Evaluation | null;
  finishProposed: boolean;
  summary: string;
}

export interface CampaignExecutionContext {
  campaign: Campaign;
  attempt: Attempt;
  store: CampaignStore;
  lease: CampaignLease;
  signal: AbortSignal;
  record(command: CommandBody): Campaign;
}

export interface CampaignExecutor {
  preflight(campaign: Campaign): Promise<{ maximumCostMicros: number; maximumDurationMs: number }>;
  execute(context: CampaignExecutionContext): Promise<CampaignExecutionResult>;
}

export interface CampaignServiceOptions {
  store: CampaignStore;
  artifacts: CampaignArtifactPort;
  workspace: string;
  ownerScope: string;
  executor: CampaignExecutor;
  cartridges?: CampaignCartridges;
  sources?: CampaignSources;
  now?: () => number;
  trusted: () => boolean;
  notice?: (message: string) => void;
}

export interface CampaignSummary {
  id: string;
  title: string;
  workload: Campaign["workload"];
  status: Campaign["status"];
  waitingReason: Campaign["waitingReason"];
  statusReason: string | null;
  revision: number;
  updatedAt: number;
  settledMicros: number;
  pendingMicros: number;
  latestAchievement: string | null;
}

export class CampaignService {
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly now: () => number;
  private closed = false;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: CampaignServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  list(): { campaigns: CampaignSummary[] } {
    return {
      campaigns: this.options.store
        .list()
        .filter(({ campaign }) => campaign.ownerScope === this.options.ownerScope)
        .map(({ campaign }) => {
          const spending = this.options.store.spending(campaign.id);
          return {
            id: campaign.id,
            title: campaign.title,
            workload: campaign.workload,
            status: campaign.status,
            waitingReason: campaign.waitingReason,
            statusReason: campaign.statusReason,
            revision: campaign.revision,
            updatedAt: campaign.updatedAt,
            settledMicros: spending.settledMicros,
            pendingMicros: spending.reservedMicros,
            latestAchievement:
              campaign.achievements.filter((item) => item.status === "verified").at(-1)?.title ??
              null,
          };
        })
        .sort((a, b) => b.updatedAt - a.updatedAt),
    };
  }

  read(id: string): CampaignSnapshot | undefined {
    const snapshot = this.options.store.snapshot(id);
    return snapshot?.campaign.ownerScope === this.options.ownerScope ? snapshot : undefined;
  }

  cartridgeInventory(): { cartridges: CartridgeSummary[] } {
    return { cartridges: this.options.cartridges?.inventory() ?? [] };
  }

  async create(body: unknown): Promise<CampaignSnapshot> {
    this.requireTrusted();
    const request = createCampaignRequestSchema.parse(body);
    const id = randomUUID();
    const createdAt = this.now();
    const kind = request.workload === "research-refinement" ? "report" : "code";
    const artifact =
      request.artifactPath === undefined
        ? await this.options.artifacts.write({
            files: { "brief.md": request.text ?? request.objective },
            ownerScope: this.options.ownerScope,
            title: `${request.title} baseline`,
            kind,
            parentIds: [],
            producerAttemptId: null,
          })
        : await this.options.artifacts.capture({
            sourcePath: resolve(this.options.workspace, request.artifactPath),
            allowedRoot: this.options.workspace,
            ownerScope: this.options.ownerScope,
            title: `${request.title} baseline`,
            kind,
            parentIds: [],
            producerAttemptId: null,
          });
    const model: ModelSelection = {
      providerId: request.model.provider,
      modelId: request.model.model,
      connectionId: null,
      effort: null,
    };
    const references = [...request.references];
    if (request.sources?.length) {
      if (this.options.sources === undefined)
        throw new CampaignStoreError("state", "source collections are unavailable");
      for (const input of request.sources) {
        const source = await this.options.sources.register({
          ...input,
          ownerScope: this.options.ownerScope,
        });
        references.push(`source:${source.id}`);
      }
    }
    this.options.store.create({
      id,
      title: request.title,
      workload: request.workload,
      ownerScope: this.options.ownerScope,
      createdAt,
      model,
      purpose: {
        revision: 1,
        outcome: request.objective,
        audience: "The person who requested this campaign",
        scope: [this.options.workspace],
        references,
        criteria: request.criteria.map((description, index) => ({
          id: `criterion-${index + 1}`,
          description,
          critical: true,
        })),
        invariants: [
          "Preserve the baseline and current best",
          "Stay within authorized scope and resource limits",
        ],
        sufficientDelivery: request.objective,
        createdAt,
      },
      budget: {
        currency: "USD",
        limitMicros: request.budgetMicros,
        evaluationReserveMicros: Math.ceil(request.budgetMicros * 0.2),
        deliveryReserveMicros: Math.ceil(request.budgetMicros * 0.05),
      },
      persistence: persistenceLimits(
        request.persistenceProfile,
        Math.floor(request.budgetMicros * 0.4),
        15 * 60_000,
      ),
      baseline: artifact,
    });
    if (this.options.cartridges !== undefined) {
      const selected =
        request.workload === "research-refinement"
          ? ["research", "critique", "delivery"]
          : request.workload === "project-development"
            ? ["exploration", "implementation", "critique", "delivery"]
            : ["implementation", "critique", "delivery"];
      const cartridges = await this.options.cartridges.activate(selected, [], {
        stage: "building",
        at: this.now(),
        capabilities: ["read", "write", "edit", "bash"],
      });
      this.record(
        id,
        {
          type: "set-cartridges",
          cartridges,
          reason: "Selected the built-in cartridges for this workload",
        },
        "controller",
      );
    }
    this.record(
      id,
      {
        type: "ready",
        reason: "Purpose, artifacts, and budget are configured; start authorizes execution",
      },
      "user",
    );
    return this.required(id);
  }

  async command(id: string, body: unknown): Promise<CampaignSnapshot> {
    this.requireTrusted();
    const request = userCommandRequestSchema.parse(body);
    const snapshot = this.required(id);
    if (snapshot.campaign.revision !== request.expectedRevision)
      throw new CampaignStoreError("conflict", "campaign changed; reload before steering");
    if (request.command.type === "reconcile") return this.reconcile(id, request.command);
    if (request.command.type === "review-artifact")
      return this.reviewArtifact(snapshot, request.command);
    if (request.command.type === "set-cartridges") {
      if (this.options.cartridges === undefined)
        throw new CampaignStoreError("state", "cartridges are unavailable");
      const input = z
        .strictObject({
          type: z.literal("set-cartridges"),
          cartridgeIds: z.array(z.string().min(1)).max(32),
          reason: z.string().trim().min(1).max(4000),
        })
        .parse(request.command);
      const cartridges = await this.options.cartridges.activate(
        input.cartridgeIds,
        snapshot.campaign.cartridges,
        { stage: "building", at: this.now(), capabilities: ["read", "write", "edit", "bash"] },
      );
      this.record(
        id,
        { type: "set-cartridges", cartridges, reason: input.reason },
        "controller",
        request.expectedRevision,
      );
      return this.required(id);
    }
    const command = userCommand(snapshot.campaign, request.command, this.now());
    if (command.type === "start" || command.type === "resume") {
      if (this.closed) throw new CampaignStoreError("state", "campaign host is closing");
      await this.options.executor.preflight(snapshot.campaign);
      this.requireTrusted();
    }
    this.record(id, command, "user", request.expectedRevision);
    if (command.type === "cancel")
      this.active.get(id)?.abort.abort(new Error("Campaign cancelled"));
    if (command.type === "start" || command.type === "resume") this.launch(id);
    return this.required(id);
  }

  events(id: string, after: number): CampaignEvent[] {
    this.required(id);
    return this.options.store.events(id, after, 1000);
  }

  subscribe(id: string, listener: (event: CampaignEvent) => void): () => void {
    this.required(id);
    return this.options.store.subscribe((event) => {
      if (event.campaignId === id) listener(event);
    });
  }

  async artifact(id: string, artifactId: string, path?: string): Promise<CampaignArtifactPreview> {
    const campaign = this.required(id).campaign;
    const artifact = campaign.artifacts.find((item) => item.id === artifactId);
    if (artifact === undefined || artifact.ownerScope !== this.options.ownerScope)
      throw new CampaignStoreError("missing", "no accessible artifact has that id");
    this.requireTrusted();
    const preview = await this.options.artifacts.preview(artifact, path);
    this.requireTrusted();
    return preview;
  }

  async exportArtifact(
    id: string,
    artifactId: string,
    body: unknown,
  ): Promise<{ artifactId: string; path: string }> {
    this.requireTrusted();
    const request = z.strictObject({ destination: z.string().trim().min(1).max(4096) }).parse(body);
    const campaign = this.required(id).campaign;
    const artifact = campaign.artifacts.find(
      (item) => item.id === artifactId && item.ownerScope === this.options.ownerScope,
    );
    if (artifact === undefined)
      throw new CampaignStoreError("missing", "no accessible artifact has that id");
    if (this.options.artifacts.export === undefined)
      throw new CampaignStoreError("state", "artifact export is unavailable");
    const scope = toolScope(this.options.workspace);
    if (!scopeContains(scope, request.destination))
      throw new CampaignStoreError(
        "state",
        "Artifact export destination must stay inside the workspace",
      );
    const destination = confinedPath(scope, request.destination);
    await mkdir(dirname(destination), { recursive: true });
    this.requireTrusted();
    return {
      artifactId,
      path: await this.options.artifacts.export(artifact, confinedPath(scope, destination)),
    };
  }

  recover(): void {
    if (this.closed) return;
    let pending = false;
    for (const { campaign } of this.options.store.list()) {
      if (
        campaign.ownerScope !== this.options.ownerScope ||
        !["running", "waiting"].includes(campaign.status)
      )
        continue;
      if (this.active.has(campaign.id)) continue;
      const lease = this.options.store.claim(campaign.id, `recovery-${randomUUID()}`, leaseMs);
      if (lease === undefined) {
        pending = true;
        continue;
      }
      try {
        this.options.store.recover(lease);
        const current = this.required(campaign.id).campaign;
        for (const attempt of current.attempts.filter((item) => item.status === "running"))
          this.record(
            campaign.id,
            {
              type: "settle-attempt",
              attemptId: attempt.id,
              status: this.options.store
                .operations(campaign.id)
                .some(
                  (operation) =>
                    operation.attemptId === attempt.id && operation.state === "unknown",
                )
                ? "unknown"
                : "failed",
              candidateArtifactId:
                current.artifacts.findLast((artifact) => artifact.producerAttemptId === attempt.id)
                  ?.id ?? null,
              failure:
                "Execution ended without a durable result; review any pending receipts before resuming",
            },
            "controller",
            undefined,
            lease,
          );
        if (this.required(campaign.id).campaign.status === "running")
          this.record(
            campaign.id,
            {
              type: "pause",
              reason: "Recovered after restart; review the campaign before resuming",
            },
            "controller",
            undefined,
            lease,
          );
      } finally {
        this.options.store.release(lease);
      }
    }
    if (pending && this.recoveryTimer === undefined) {
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = undefined;
        this.recover();
      }, 5000);
      this.recoveryTimer.unref?.();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.recoveryTimer);
    for (const run of this.active.values())
      run.abort.abort(new Error("Campaign runtime is closing"));
    await Promise.allSettled([...this.active.values()].map((run) => run.done));
    this.options.store.close();
  }

  async settled(id: string): Promise<void> {
    await this.active.get(id)?.done;
  }

  private launch(id: string): void {
    const previous = this.active.get(id);
    if (previous !== undefined) {
      void previous.done.then(() => {
        if (!this.closed && this.read(id)?.campaign.status === "running") this.launch(id);
      });
      return;
    }
    const abort = new AbortController();
    const done = Promise.resolve()
      .then(() => this.run(id, abort))
      .catch((cause: unknown) => {
        this.options.notice?.(
          `Campaign ${id}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      })
      .finally(() => this.active.delete(id));
    this.active.set(id, { abort, done });
  }

  private async run(id: string, abort: AbortController): Promise<void> {
    const lease = this.options.store.claim(id, randomUUID(), leaseMs);
    if (lease === undefined)
      throw new CampaignStoreError("lease", "another controller owns this campaign");
    const heartbeat = setInterval(() => {
      try {
        this.options.store.renew(lease, leaseMs);
      } catch (cause) {
        abort.abort(cause);
      }
    }, leaseMs / 3);
    heartbeat.unref?.();
    try {
      for (let iteration = 0; iteration < 100; iteration += 1) {
        const campaign = this.required(id).campaign;
        if (
          campaign.status !== "running" ||
          campaign.controlRequested !== null ||
          abort.signal.aborted
        )
          return;
        this.requireTrusted();
        const bound = await this.options.executor.preflight(campaign);
        this.requireTrusted();
        if (this.required(id).campaign.revision !== campaign.revision) continue;
        if (abort.signal.aborted) return;
        const next = planContinuation(campaign, {
          now: this.now(),
          availableMicros: this.options.store.spending(id).remainingMicros,
          ...bound,
          authority: "allowed",
          safetyAllowed: true,
          userStopped: abort.signal.aborted,
          unresolvedEffect: this.options.store.spending(id).unresolvedOperations > 0,
        });
        if (next.action === "wait" || next.action === "stop") {
          this.record(
            id,
            {
              type: "wait",
              waitingReason:
                next.action === "wait" && this.options.store.spending(id).unresolvedOperations > 0
                  ? "reconciliation"
                  : "person",
              reason: next.reason,
            },
            "controller",
            undefined,
            lease,
          );
          return;
        }
        if (next.action === "finish") {
          this.finish(id, next.reason, next.boundary ?? "exhausted", lease);
          return;
        }
        const startedAt = Math.max(this.now(), campaign.updatedAt);
        const branch = campaign.decisions.findLast(
          (decision) =>
            decision.kind === "branch" && decision.at >= (campaign.attempts.at(-1)?.startedAt ?? 0),
        );
        const perspective =
          probePerspectives[campaign.persistence.probesUsed % probePerspectives.length] ??
          probePerspectives[0];
        const attempt: Attempt = {
          id: randomUUID(),
          operationId: randomUUID(),
          purposeRevision: campaign.purposeRevision,
          parentArtifactId: branch?.artifactId ?? campaign.currentBestArtifactId,
          branch: branch?.id ?? "main",
          hypothesis:
            next.action === "probe"
              ? `${perspective.hypothesis} Use the prior attempts to avoid repeating an unsupported approach.`
              : currentPurpose(campaign).outcome.slice(0, 8_000),
          method:
            next.action === "probe"
              ? `${perspective.method}:${campaign.persistence.probesUsed + 1}`
              : "refine-and-review",
          expectedBenefit: "Improve the artifact against the accepted criteria",
          model: campaign.model,
          probe: next.action === "probe",
          status: "running",
          startedAt,
          finishedAt: null,
          candidateArtifactId: null,
          failure: null,
        };
        this.record(
          id,
          { type: "begin-attempt", attempt },
          "controller",
          undefined,
          lease,
          startedAt,
        );
        try {
          const result = await this.options.executor.execute({
            campaign: this.required(id).campaign,
            attempt,
            store: this.options.store,
            lease,
            signal: abort.signal,
            record: (command) => this.record(id, command, "controller", undefined, lease),
          });
          if (
            result.artifact !== null &&
            !this.required(id).campaign.artifacts.some(
              (artifact) => artifact.id === result.artifact?.id,
            )
          )
            this.record(
              id,
              { type: "record-artifact", artifact: result.artifact },
              "controller",
              undefined,
              lease,
            );
          for (const evidence of result.evidence)
            this.record(id, { type: "record-evidence", evidence }, "controller", undefined, lease);
          if (result.evaluation !== null)
            this.record(
              id,
              { type: "record-evaluation", evaluation: result.evaluation },
              "controller",
              undefined,
              lease,
            );
          this.record(
            id,
            {
              type: "settle-attempt",
              attemptId: attempt.id,
              status: "succeeded",
              candidateArtifactId: result.artifact?.id ?? null,
              failure: null,
            },
            "controller",
            undefined,
            lease,
          );
          const current = this.required(id).campaign;
          if (current.status !== "running") return;
          let adopted = false;
          if (result.artifact !== null && result.evaluation?.materialImprovement === true) {
            try {
              this.record(
                id,
                {
                  type: "adopt",
                  artifactId: result.artifact.id,
                  evaluationId: result.evaluation.id,
                  reason: result.evaluation.summary,
                },
                "controller",
                undefined,
                lease,
              );
              adopted = true;
            } catch (cause) {
              this.options.notice?.(
                `Candidate retained without adoption: ${cause instanceof Error ? cause.message : String(cause)}`,
              );
            }
            if (adopted) this.recordAchievements(id, result, lease);
          }
          if (result.finishProposed || !adopted)
            this.record(
              id,
              {
                type: "propose-finish",
                reason: result.summary || "No evaluated improvement in this attempt",
              },
              "worker",
              undefined,
              lease,
            );
        } catch (cause) {
          const current = this.required(id).campaign;
          const unfinished = current.attempts.find(
            (item) => item.id === attempt.id && item.status === "running",
          );
          if (unfinished !== undefined)
            this.record(
              id,
              {
                type: "settle-attempt",
                attemptId: attempt.id,
                status:
                  this.options.store.spending(id).unresolvedOperations > 0
                    ? "unknown"
                    : abort.signal.aborted
                      ? "cancelled"
                      : "failed",
                candidateArtifactId:
                  current.artifacts.findLast(
                    (artifact) => artifact.producerAttemptId === attempt.id,
                  )?.id ?? null,
                failure: cause instanceof Error ? cause.message : String(cause),
              },
              "controller",
              undefined,
              lease,
            );
          if (this.required(id).campaign.status === "running")
            this.record(
              id,
              {
                type: "wait",
                waitingReason: "person",
                reason: cause instanceof Error ? cause.message : String(cause),
              },
              "controller",
              undefined,
              lease,
            );
          return;
        }
      }
      this.finish(
        id,
        "The campaign reached its execution limit; review before extending",
        "scope",
        lease,
      );
    } catch (cause) {
      const current = this.required(id).campaign;
      if (current.status === "running")
        this.record(
          id,
          {
            type: "wait",
            waitingReason: "person",
            reason: cause instanceof Error ? cause.message : String(cause),
          },
          "controller",
          undefined,
          lease,
        );
      throw cause;
    } finally {
      clearInterval(heartbeat);
      this.options.store.release(lease);
    }
  }

  private reconcile(id: string, input: Record<string, unknown>): CampaignSnapshot {
    const request = z
      .strictObject({
        type: z.literal("reconcile"),
        operationId: z.string().min(1),
        costMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        reference: z.string().trim().min(1).max(200),
        reason: z.string().trim().min(1).max(200),
      })
      .parse(input);
    if (this.active.has(id))
      throw new CampaignStoreError(
        "state",
        "wait for the active attempt to settle before reconciling",
      );
    const operation = this.options.store.operation(request.operationId);
    if (operation === undefined || operation.campaignId !== id)
      throw new CampaignStoreError("missing", "no matching campaign operation");
    if (operation.state !== "unknown" && operation.receipt.state !== "estimated")
      throw new CampaignStoreError("state", "only uncertain usage needs reconciliation");
    const lease = this.options.store.claim(id, `reconciliation-${randomUUID()}`, leaseMs);
    if (lease === undefined)
      throw new CampaignStoreError("lease", "another controller owns this campaign");
    try {
      this.options.store.settle(
        operation.id,
        {
          ...operation.receipt,
          costMicros: request.costMicros,
          state: "reconciled",
          costSource: `User receipt ${request.reference}: ${request.reason}`,
          recordedAt: this.now(),
        },
        lease,
      );
      const campaign = this.required(id).campaign;
      for (const attempt of campaign.attempts.filter((item) => item.status === "unknown")) {
        const pending = this.options.store
          .operations(id)
          .some(
            (item) =>
              item.attemptId === attempt.id &&
              item.state !== "released" &&
              (item.state !== "settled" || item.receipt.state === "estimated"),
          );
        if (!pending)
          this.record(
            id,
            {
              type: "settle-attempt",
              attemptId: attempt.id,
              status: "failed",
              candidateArtifactId: null,
              failure: "Usage reconciled; interrupted output remains unaccepted",
            },
            "controller",
            undefined,
            lease,
          );
      }
      return this.required(id);
    } finally {
      this.options.store.release(lease);
    }
  }

  private reviewArtifact(
    snapshot: CampaignSnapshot,
    input: Record<string, unknown>,
  ): CampaignSnapshot {
    const request = z
      .strictObject({
        type: z.literal("review-artifact"),
        artifactId: z.string().min(1),
        attested: z.literal(true),
        adopt: z.boolean(),
        reason: z.string().trim().min(1).max(4000),
        observations: z
          .array(
            z.strictObject({
              criterionId: z.string().min(1),
              verdict: z.enum(["pass", "fail", "uncertain"]),
              summary: z.string().trim().min(1).max(4000),
            }),
          )
          .min(1)
          .max(64),
      })
      .parse(input);
    const { campaign } = snapshot;
    if (
      campaign.attempts.some(
        (attempt) => attempt.status === "running" || attempt.status === "unknown",
      )
    )
      throw new CampaignStoreError(
        "state",
        "pause and resolve the active attempt before recording an authoritative review",
      );
    if (
      !campaign.artifacts.some(
        (artifact) =>
          artifact.id === request.artifactId && artifact.ownerScope === this.options.ownerScope,
      )
    )
      throw new CampaignStoreError("missing", "no accessible artifact has that id");
    const criteria = currentPurpose(campaign).criteria;
    if (
      request.observations.length !== criteria.length ||
      new Set(request.observations.map((observation) => observation.criterionId)).size !==
        criteria.length ||
      request.observations.some(
        (observation) => !criteria.some((criterion) => criterion.id === observation.criterionId),
      )
    )
      throw new CampaignStoreError("state", "review every current criterion exactly once");
    const at = Math.max(this.now(), campaign.updatedAt);
    const actor = { id: this.options.ownerScope, role: "user" } as const;
    const evidence: EvidenceItem[] = request.observations.map((observation) => ({
      id: randomUUID(),
      artifactId: request.artifactId,
      purposeRevision: campaign.purposeRevision,
      criterionIds: [observation.criterionId],
      kind: "human-review",
      verdict: observation.verdict,
      summary: observation.summary,
      sourceRefs: [`artifact:${request.artifactId}`],
      methodId: "explicit-human-review",
      methodVersion: "1",
      observedAt: at,
      producer: actor,
    }));
    const evaluation: Evaluation = {
      id: randomUUID(),
      artifactId: request.artifactId,
      comparedToArtifactId: campaign.currentBestArtifactId,
      purposeRevision: campaign.purposeRevision,
      observations: request.observations.map((observation, index) => ({
        ...observation,
        evidenceIds: [evidence[index]?.id ?? ""],
      })),
      materialImprovement: request.adopt && request.artifactId !== campaign.currentBestArtifactId,
      summary: request.reason,
      evaluator: actor,
      model: null,
      createdAt: at,
    };
    const commands: CommandBody[] = [
      ...evidence.map((item): CommandBody => ({ type: "record-evidence", evidence: item })),
      { type: "record-evaluation", evaluation },
    ];
    if (request.adopt && request.artifactId !== campaign.currentBestArtifactId)
      commands.push({
        type: "adopt",
        artifactId: request.artifactId,
        evaluationId: evaluation.id,
        reason: request.reason,
      });
    if (request.adopt || request.artifactId === campaign.currentBestArtifactId) {
      for (const observation of evaluation.observations.filter((item) => item.verdict === "pass")) {
        const contradicted = campaign.evidence.some(
          (item) =>
            item.artifactId === request.artifactId &&
            item.purposeRevision === campaign.purposeRevision &&
            item.criterionIds.includes(observation.criterionId) &&
            item.verdict === "fail" &&
            item.kind !== "critique" &&
            item.kind !== "claim" &&
            (item.producer.role === "controller" ||
              (item.kind === "human-review" && item.producer.role === "user")),
        );
        commands.push({
          type: "record-achievement",
          achievement: {
            id: randomUUID(),
            criterionId: observation.criterionId,
            artifactId: request.artifactId,
            purposeRevision: campaign.purposeRevision,
            title:
              criteria
                .find((criterion) => criterion.id === observation.criterionId)
                ?.description.slice(0, 512) ?? "Human-reviewed outcome",
            summary: observation.summary,
            evidenceIds: observation.evidenceIds,
            status: contradicted ? "observed" : "verified",
            verifiedBy: contradicted ? null : actor,
            adoptedAt: null,
            history: [],
          },
        });
      }
    }
    return this.options.store.applyBatch(
      campaign.id,
      commands.map((command, index) => ({
        ...command,
        id: randomUUID(),
        at,
        expectedRevision: campaign.revision + index,
      })),
      { id: "human-review-intake", role: "controller" },
    );
  }

  private recordAchievements(
    id: string,
    result: CampaignExecutionResult,
    lease: CampaignLease,
  ): void {
    if (result.artifact === null || result.evaluation === null) return;
    const campaign = this.required(id).campaign;
    for (const observation of result.evaluation.observations.filter(
      (item) => item.verdict === "pass",
    )) {
      const criterion = currentPurpose(campaign).criteria.find(
        (item) => item.id === observation.criterionId,
      );
      const verified = hasVerifiedEvidence(
        result.evidence.filter((evidence) => observation.evidenceIds.includes(evidence.id)),
      );
      this.record(
        id,
        {
          type: "record-achievement",
          achievement: {
            id: randomUUID(),
            criterionId: observation.criterionId,
            artifactId: result.artifact.id,
            purposeRevision: campaign.purposeRevision,
            title: criterion?.description.slice(0, 512) ?? "Accepted improvement",
            summary: observation.summary,
            evidenceIds: observation.evidenceIds,
            status: verified ? "verified" : "observed",
            verifiedBy: verified ? result.evaluation.evaluator : null,
            adoptedAt: this.now(),
            history: [],
          },
        },
        "controller",
        undefined,
        lease,
      );
    }
  }

  private finish(
    id: string,
    reason: string,
    boundary: "exhausted" | "budget" | "time" | "scope" | "safety" | "user" | "sufficient",
    lease: CampaignLease,
  ): void {
    const campaign = this.required(id).campaign;
    this.record(
      id,
      {
        type: "finish",
        reason,
        boundary,
        delivery: campaign.currentBestArtifactId === null ? "pending" : "available",
        verification: campaign.verification,
        handoff: campaignHandoff(campaign, reason),
      },
      "controller",
      undefined,
      lease,
    );
  }

  private record(
    id: string,
    command: CommandBody,
    role: "user" | "controller" | "worker",
    expectedRevision?: number,
    lease?: CampaignLease,
    at = this.now(),
  ): Campaign {
    const current = this.required(id).campaign;
    return this.options.store.apply(
      id,
      {
        ...command,
        id: randomUUID(),
        expectedRevision: expectedRevision ?? current.revision,
        at: Math.max(at, current.updatedAt),
      },
      { id: role === "user" ? this.options.ownerScope : "campaign-host", role },
      lease,
    ).campaign;
  }

  private required(id: string): CampaignSnapshot {
    const snapshot = this.read(id);
    if (snapshot === undefined)
      throw new CampaignStoreError("missing", "no accessible campaign has that id");
    return snapshot;
  }

  private requireTrusted(): void {
    if (!this.options.trusted())
      throw new CampaignStoreError("trust", "campaign execution requires a trusted workspace");
  }
}

export function campaignDatabase(root: string): string {
  return join(root, "campaigns.db");
}

const leaseMs = 30_000;
const probePerspectives = [
  {
    method: "simplification",
    hypothesis:
      "Find a way to achieve the purpose with less complexity, friction, or unnecessary material.",
  },
  {
    method: "user-journey",
    hypothesis:
      "Walk through a realistic use of the artifact and look for an incomplete transition or avoidable burden.",
  },
  {
    method: "counterevidence",
    hypothesis:
      "Challenge the strongest assumption with a concrete counterexample or conflicting source.",
  },
  {
    method: "alternative-structure",
    hypothesis:
      "Explore a materially different structure while preserving the useful properties of the current best.",
  },
  {
    method: "craft",
    hypothesis:
      "Inspect coherence, clarity, interaction details, and whether the artifact feels finished for its audience.",
  },
  {
    method: "failure-recovery",
    hypothesis:
      "Examine an edge case, failure, or uncertainty and improve how the artifact responds or explains it.",
  },
  {
    method: "missing-evidence",
    hypothesis:
      "Identify the most consequential unresolved claim and seek evidence that would change the next decision.",
  },
  {
    method: "synthesis",
    hypothesis:
      "Combine the strongest supported ideas from prior attempts without importing their regressions or extra complexity.",
  },
] as const;
const userCommandRequestSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  command: z.record(z.string(), z.unknown()),
});

function userCommand(campaign: Campaign, input: Record<string, unknown>, at: number): CommandBody {
  const reason =
    typeof input.reason === "string" && input.reason.trim() ? input.reason : "User steering";
  switch (input.type) {
    case "start":
    case "pause":
    case "resume":
    case "cancel":
      return { type: input.type, reason };
    case "finish":
      return {
        type: "finish",
        boundary: "user",
        reason,
        handoff: campaignHandoff(campaign, reason),
        delivery: campaign.currentBestArtifactId === null ? "pending" : "available",
        verification: campaign.verification,
      };
    case "retain":
    case "branch": {
      if (typeof input.artifactId !== "string")
        throw new CampaignStoreError("state", "an artifact id is required");
      return { type: input.type, artifactId: input.artifactId, reason };
    }
    case "adopt": {
      if (typeof input.artifactId !== "string" || typeof input.evaluationId !== "string")
        throw new CampaignStoreError("state", "an artifact and evaluation are required");
      return {
        type: "adopt",
        artifactId: input.artifactId,
        evaluationId: input.evaluationId,
        reason,
      };
    }
    case "select-model": {
      const selected = z
        .strictObject({ provider: z.string().min(1), model: z.string().min(1) })
        .parse(input.model);
      return {
        type: "select-model",
        reason,
        model: modelSelectionSchema.parse({
          providerId: selected.provider,
          modelId: selected.model,
          connectionId: null,
          effort: null,
        }),
      };
    }
    case "renew-persistence":
      return {
        type: "renew-persistence",
        reason,
        limits: persistenceLimitsSchema.parse({
          profile: campaign.persistence.profile,
          probeLimit: input.probeLimit,
          spendLimitMicros: input.spendLimitMicros,
          timeLimitMs: input.timeLimitMs,
        }),
      };
    case "redirect": {
      const objective = typeof input.objective === "string" ? input.objective.trim() : "";
      if (!objective) throw new CampaignStoreError("state", "a new objective is required");
      return {
        type: "revise-purpose",
        reason,
        purpose: {
          ...currentPurpose(campaign),
          revision: campaign.purposeRevision + 1,
          outcome: objective,
          sufficientDelivery: objective,
          createdAt: at,
        },
      };
    }
    default:
      throw new CampaignStoreError("state", "unsupported campaign steering command");
  }
}

function campaignHandoff(campaign: Campaign, reason: string): NonNullable<Campaign["handoff"]> {
  return {
    summary: reason,
    currentBestArtifactId: campaign.currentBestArtifactId,
    obligations: [
      ...new Set([
        ...currentPurpose(campaign).invariants,
        ...campaign.cartridges.flatMap((cartridge) => cartridge.obligations),
      ]),
    ],
    unresolved: [
      ...new Set([
        ...currentPurpose(campaign)
          .criteria.filter(
            (criterion) =>
              !campaign.achievements.some(
                (item) =>
                  item.criterionId === criterion.id &&
                  item.status === "verified" &&
                  item.artifactId === campaign.currentBestArtifactId &&
                  item.purposeRevision === campaign.purposeRevision,
              ),
          )
          .map((criterion) => criterion.description),
        ...campaign.evidence
          .filter(
            (item) =>
              item.methodId === "worker-handoff" &&
              item.purposeRevision === campaign.purposeRevision &&
              [campaign.currentBestArtifactId, campaign.latestArtifactId].includes(item.artifactId),
          )
          .slice(-64)
          .map((item) => item.summary),
      ]),
    ].slice(0, 128),
    options: ["Inspect the best artifact", "Change purpose or explicitly extend the allowance"],
    attemptedApproaches: [...new Set(campaign.attempts.map((attempt) => attempt.method))].slice(
      -128,
    ),
    nextStep: "Review the artifact and evidence",
  };
}
