export interface WorkshopRefusal {
  readonly refused: string;
  readonly error: string;
}

export interface RestartingWorkshops {
  restartRunning(): Promise<readonly WorkshopRefusal[]>;
}

export interface StartingRoutines {
  start(): Promise<void>;
}

export interface HeldClaimCode {
  code: string;
  expiresAt: string;
}

export interface ClaimDesk {
  claimState(): Promise<"unclaimed" | "claimed">;
  live(): Promise<HeldClaimCode | null>;
  issue(): Promise<HeldClaimCode>;
}

export interface ReconcilePorts {
  workshops?: RestartingWorkshops | undefined;
  routines?: StartingRoutines | undefined;
  claim?: ClaimDesk | undefined;
  headless: boolean;
}

export type Step<Done> = { kind: "absent" } | { kind: "failed"; error: string } | Done;

export type WorkshopsReconciled = Step<{ kind: "restarted"; refused: readonly WorkshopRefusal[] }>;
export type RoutinesReconciled = Step<{ kind: "started" }>;
export type ClaimReconciled = Step<
  | { kind: "claimed" }
  | { kind: "not-headless" }
  | { kind: "live"; claim: HeldClaimCode }
  | { kind: "issued"; claim: HeldClaimCode }
>;

export interface ReconcileReport {
  workshops: WorkshopsReconciled;
  routines: RoutinesReconciled;
  claim: ClaimReconciled;
}

export async function reconcileOnStart(ports: ReconcilePorts): Promise<ReconcileReport> {
  const workshops = await restartWorkshops(ports.workshops);
  const routines = await startRoutines(ports.routines);
  const claim = await offerClaimCode(ports.claim, ports.headless);
  return { workshops, routines, claim };
}

export function reconcileLines(report: ReconcileReport): string[] {
  return [
    workshopsLine(report.workshops),
    routinesLine(report.routines),
    ...claimLines(report.claim),
  ];
}

export function groupedClaimCode(code: string): string {
  const bare = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return bare.match(/.{1,4}/g)?.join("-") ?? bare;
}

async function restartWorkshops(
  workshops: RestartingWorkshops | undefined,
): Promise<WorkshopsReconciled> {
  if (workshops === undefined) return { kind: "absent" };
  return attempt(async () => ({ kind: "restarted", refused: await workshops.restartRunning() }));
}

async function startRoutines(routines: StartingRoutines | undefined): Promise<RoutinesReconciled> {
  if (routines === undefined) return { kind: "absent" };
  return attempt(async () => {
    await routines.start();
    return { kind: "started" };
  });
}

async function offerClaimCode(
  claim: ClaimDesk | undefined,
  headless: boolean,
): Promise<ClaimReconciled> {
  if (claim === undefined) return { kind: "absent" };
  return attempt(async () => {
    if ((await claim.claimState()) === "claimed") return { kind: "claimed" };
    if (!headless) return { kind: "not-headless" };
    const live = await claim.live();
    return live === null
      ? { kind: "issued", claim: await claim.issue() }
      : { kind: "live", claim: live };
  });
}

async function attempt<Done>(
  work: () => Promise<Done>,
): Promise<Done | { kind: "failed"; error: string }> {
  try {
    return await work();
  } catch (cause) {
    return { kind: "failed", error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function workshopsLine(step: WorkshopsReconciled): string {
  switch (step.kind) {
    case "absent":
      return "reconcile: workshops are not composed in this node";
    case "failed":
      return `reconcile: workshops could not be listed: ${step.error}`;
    case "restarted":
      return step.refused.length === 0
        ? "reconcile: workshops that were running before the node stopped are started again, none refused"
        : `reconcile: ${step.refused.length} workshop(s) did not restart: ${step.refused.map((refusal) => `${refusal.refused} (${refusal.error})`).join("; ")}`;
  }
}

function routinesLine(step: RoutinesReconciled): string {
  switch (step.kind) {
    case "absent":
      return "reconcile: no routine scheduler is composed in this node";
    case "failed":
      return `reconcile: the routine scheduler did not start: ${step.error}`;
    case "started":
      return "reconcile: interrupted runs settled from the journal; at most one catch-up per routine is paced in";
  }
}

function claimLines(step: ClaimReconciled): string[] {
  switch (step.kind) {
    case "absent":
    case "claimed":
    case "not-headless":
      return [];
    case "failed":
      return [`pairing: could not read or issue a claim code: ${step.error}`];
    case "live":
    case "issued":
      return [
        `pairing: this headless node is unclaimed; claim it from your console with code ${groupedClaimCode(step.claim.code)} (valid until ${step.claim.expiresAt})`,
      ];
  }
}
