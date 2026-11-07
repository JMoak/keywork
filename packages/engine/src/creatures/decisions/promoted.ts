import { auditTag, modelOfRow } from "./calibration.ts";
import { askFactsOf } from "./facts.ts";
import { inLedgerOrder, keeperLedgerPath } from "./files.ts";
import { evidenceVersionFor, keeperPlan } from "./gate.ts";
import { demoteNow } from "./promote.ts";
import { type Promotion, promotionFor, readPromotionBook } from "./promotions.ts";
import {
  type Decision,
  type DecisionRecord,
  loadRatchet,
  type Oracle,
  type Ratchet,
} from "./ratchet.ts";
import {
  type KeeperCall,
  type KeeperDecisionsOptions,
  keeperTagsOf,
  openKeeperGate,
} from "./record.ts";
import { ruleClassOfRow } from "./report.ts";
import { keeperAuditRate } from "./review.ts";
import { keeperState } from "./state.ts";

export const promotedTag = "keeper:promoted";
export const keeperOverturnSource = "keywork:overturn";
export const keeperAuditWindow = 200;
export const keeperMinAudits = 30;

export type KeeperAskReason =
  | "not-promoted"
  | "model-moved"
  | "drifted"
  | "below-bar"
  | "blind-review"
  | "unavailable";

export type KeeperRuling =
  | {
      decidedForYou: true;
      recordId: string;
      ruleClass: string;
      pYes: number;
      promotion: Promotion;
    }
  | {
      decidedForYou: false;
      reason: KeeperAskReason;
      ruleClass: string;
      recordId?: string;
      detail?: string;
    };

export type OverturnOutcome =
  | { overturned: true; recordId: string; ruleClass: string; demoted: Promotion[] }
  | { overturned: false; reason: "not-decided-for-you" | "already-overturned" };

export interface OverturnOptions {
  nodeState: string;
  recordId: string;
  ratchet?: Ratchet | undefined;
  now?: (() => Date) | undefined;
}

export async function decideForKeeper(
  call: KeeperCall,
  options: KeeperDecisionsOptions,
): Promise<KeeperRuling> {
  const facts = askFactsOf(call.ask, { cwd: call.cwd, secrets: options.secrets });
  const asked = (reason: KeeperAskReason, extra: AskedExtra = {}): KeeperRuling => ({
    decidedForYou: false,
    reason,
    ruleClass: facts.ruleClass,
    ...extra,
  });
  const ledgerPath = keeperLedgerPath(options.nodeState);
  return inLedgerOrder(ledgerPath, async () => {
    try {
      const book = await readPromotionBook(options.nodeState);
      const promotion = promotionFor(book.active, facts.ruleClass, call.context.creature);
      if (promotion === undefined) return asked("not-promoted");
      const keeper = await openKeeperGate(ledgerPath, options, {
        mode: "enforce",
        oracle: (oracle) => pinnedTo(oracle, promotion.model),
        spec: (spec) => ({
          ...spec,
          policy: { ...spec.policy, actAbove: promotion.bar },
          mode: "enforce",
          auditRate: options.auditRate ?? keeperAuditRate,
        }),
      });
      if (evidenceVersionFor(keeper.oracle.id) !== promotion.evidenceVersion) {
        return asked("model-moved");
      }
      if (auditsDrifted(await keeper.engine.ledger.all(), promotion)) {
        await demoteNow({
          ...options,
          ruleClass: facts.ruleClass,
          by: "audits",
          reason: driftReason,
        });
        return asked("drifted");
      }
      const result = await keeper.gate.ask(keeperState(keeper.ratchet, facts, call.context), {
        baseline: "review",
        tags: [...keeperTagsOf(call, facts), promotedTag],
      });
      const recordId = result.recordId;
      if (result.action === "act") {
        const pYes = result.decision.verdict.pYes;
        return { decidedForYou: true, recordId, ruleClass: facts.ruleClass, pYes, promotion };
      }
      if (result.audited) return asked("blind-review", { recordId });
      return asked(result.decision.failedOpen === true ? "unavailable" : "below-bar", { recordId });
    } catch (error) {
      return asked("unavailable", {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export async function overturnKeeperDecision(options: OverturnOptions): Promise<OverturnOutcome> {
  const ledgerPath = keeperLedgerPath(options.nodeState);
  return inLedgerOrder(ledgerPath, async () => {
    const ratchet = options.ratchet ?? (await loadRatchet());
    const ledger = new ratchet.JsonlLedger(ledgerPath);
    const row = (await ledger.all()).find((candidate) => candidate.id === options.recordId);
    if (row === undefined || !wasDecidedForYou(row)) {
      return { overturned: false, reason: "not-decided-for-you" };
    }
    if (row.outcome !== undefined) return { overturned: false, reason: "already-overturned" };
    const at = (options.now ?? (() => new Date()))().toISOString();
    await ledger.label(row.id, {
      at,
      correct: false,
      truth: false,
      source: keeperOverturnSource,
      note: "overturned: the keeper would not have approved this call",
    });
    const ruleClass = ruleClassOfRow(row);
    const demotion = await demoteNow({
      nodeState: options.nodeState,
      ruleClass,
      by: "overturn",
      reason: `overturned ${row.id}`,
      ratchet,
      now: options.now,
    });
    return {
      overturned: true,
      recordId: row.id,
      ruleClass,
      demoted: demotion.demoted ? demotion.promotions : [],
    };
  });
}

export function wasDecidedForYou(row: DecisionRecord): boolean {
  return row.mode === "enforce" && row.action === "act" && row.tags.includes(promotedTag);
}

interface AskedExtra {
  recordId?: string;
  detail?: string;
}

const driftReason =
  `blind reviews of the decided calls fell below ${Math.round(keeperPlan.target * 100)}% ` +
  `over at least ${keeperMinAudits} of them`;

function pinnedTo(oracle: Oracle, model: string): Oracle {
  return {
    id: oracle.id,
    async decide(state, questions, opts) {
      const decisions = await oracle.decide(state, questions, opts);
      const moved = decisions.find((decision: Decision) => (decision.model ?? oracle.id) !== model);
      if (moved !== undefined) {
        throw new Error(
          `the promotion holds for ${model}, and ${moved.model ?? oracle.id} answered`,
        );
      }
      return decisions;
    },
  };
}

function auditsDrifted(rows: readonly DecisionRecord[], promotion: Promotion): boolean {
  const audits = rows
    .filter(
      (row) =>
        row.tags.includes(auditTag) &&
        row.tags.includes(promotedTag) &&
        row.at > promotion.at &&
        ruleClassOfRow(row) === promotion.ruleClass &&
        modelOfRow(row) === promotion.model &&
        typeof row.outcome?.truth === "boolean",
    )
    .slice(-keeperAuditWindow);
  if (audits.length < keeperMinAudits) return false;
  const approved = audits.filter((row) => row.outcome?.truth === true).length;
  return approved / audits.length < keeperPlan.target;
}
