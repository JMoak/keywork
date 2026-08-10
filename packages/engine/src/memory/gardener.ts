import { ReviewInbox, type ReviewItemDetail } from "./inbox.ts";
import { InvalidTitleError, titleKey } from "./naming.ts";
import { tokenize } from "./search.ts";
import { DuplicateTitleError, type MemoryStore, type Note } from "./store.ts";

export interface DailyEntryCandidate {
  id: string;
  date: string;
  time: string;
  provenance: "user" | "agent";
  text: string;
}

export interface PromotionProposal {
  entryId: string;
  title: string;
  body: string;
  confidence: number;
}

export type PairRelation = "duplicate" | "supersedes" | "contradiction" | "distinct";

export interface PairVerdict {
  relation: PairRelation;
  confidence: number;
  keep?: "a" | "b";
  mergedBody?: string;
}

export interface CurationJudgmentPort {
  readonly id: string;
  proposePromotions(entries: DailyEntryCandidate[]): Promise<PromotionProposal[]>;
  classifyPair(a: Note, b: Note): Promise<PairVerdict>;
}

export interface CurationThresholds {
  promote: number;
  review: number;
  act: number;
  pairSimilarityFloor: number;
  emaAlpha: number;
  sessionRecallCap: number;
}

export const defaultCurationThresholds: CurationThresholds = {
  promote: 0.8,
  review: 0.5,
  act: 0.8,
  pairSimilarityFloor: 0.3,
  emaAlpha: 0.3,
  sessionRecallCap: 1,
};

export type ProposalRejection =
  | "unknown-entry"
  | "tainted-source"
  | "already-exists"
  | "invalid-title";

export interface SweepReport {
  inert: boolean;
  promoted: string[];
  rejected: { entryId: string; title: string; reason: ProposalRejection }[];
  merged: { keep: string; retired: string }[];
  superseded: { winner: string; loser: string }[];
  flagged: string[];
  usefulness: Record<string, number>;
}

export interface GardenerOptions {
  store: MemoryStore;
  inbox?: ReviewInbox;
  judgment?: CurationJudgmentPort;
  thresholds?: Partial<CurationThresholds>;
}

export interface SweepOptions {
  dates?: string[];
}

export class Gardener {
  private readonly store: MemoryStore;
  private readonly inbox: ReviewInbox;
  private readonly judgment: CurationJudgmentPort | undefined;
  private readonly thresholds: CurationThresholds;
  private readonly recallsBySession = new Map<string, Map<string, number>>();

  constructor(options: GardenerOptions) {
    this.store = options.store;
    this.inbox = options.inbox ?? new ReviewInbox();
    this.judgment = options.judgment;
    this.thresholds = { ...defaultCurationThresholds, ...options.thresholds };
  }

  recordRecall(noteName: string, sessionId: string): void {
    const session = this.recallsBySession.get(sessionId) ?? new Map<string, number>();
    session.set(noteName, (session.get(noteName) ?? 0) + 1);
    this.recallsBySession.set(sessionId, session);
  }

  async sweep(options: SweepOptions = {}): Promise<SweepReport> {
    const report = emptyReport();
    if (!this.store.trusted) return { ...report, inert: true };
    const proposals: ReviewItemDetail[] = [];
    await this.promoteFromDailyLogs(options.dates, report, proposals);
    await this.curateNotePairs(report, proposals);
    await this.foldUsefulness(report);
    this.proposeUnlinkedMentions(await this.store.listNotes(), proposals);
    report.flagged = (await this.inbox.add(proposals)).map((item) => item.key);
    await this.store.recordAudit(auditSummary(report));
    return report;
  }

  private async promoteFromDailyLogs(
    dates: string[] | undefined,
    report: SweepReport,
    proposals: ReviewItemDetail[],
  ): Promise<void> {
    if (this.judgment === undefined) return;
    const entries = await this.dailyEntries(dates ?? (await this.store.listDailyDates()));
    const candidates = entries.filter(isTrustedCandidate);
    if (candidates.length === 0) return;
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    for (const proposal of await this.judgment.proposePromotions(candidates)) {
      await this.applyPromotion(proposal, byId, report, proposals);
    }
  }

  private async applyPromotion(
    proposal: PromotionProposal,
    byId: Map<string, TaintableEntry>,
    report: SweepReport,
    proposals: ReviewItemDetail[],
  ): Promise<void> {
    const reject = (reason: ProposalRejection): void => {
      report.rejected.push({ entryId: proposal.entryId, title: proposal.title, reason });
    };
    const entry = byId.get(proposal.entryId);
    if (entry === undefined) return reject("unknown-entry");
    if (entry.provenance === "untrusted") return reject("tainted-source");
    if (proposal.confidence < this.thresholds.review) return;
    if ((await this.store.readNote(proposal.title)) !== undefined) return reject("already-exists");
    if (proposal.confidence < this.thresholds.promote) {
      proposals.push({
        kind: "borderline-promotion",
        title: proposal.title,
        body: proposal.body,
        confidence: proposal.confidence,
        source: entry.id,
      });
      return;
    }
    try {
      await this.store.writeNote({
        title: proposal.title,
        body: proposal.body,
        provenance: "agent",
        confidence: proposal.confidence,
      });
      report.promoted.push(proposal.title);
    } catch (error) {
      if (error instanceof InvalidTitleError) return reject("invalid-title");
      if (error instanceof DuplicateTitleError) return reject("already-exists");
      throw error;
    }
  }

  private async dailyEntries(dates: string[]): Promise<TaintableEntry[]> {
    const entries: TaintableEntry[] = [];
    for (const date of dates) {
      (await this.store.readDaily(date)).forEach((entry, index) => {
        entries.push({
          id: `${date}#${index}`,
          date,
          time: entry.time,
          provenance: entry.provenance,
          text: entry.text,
        });
      });
    }
    return entries;
  }

  private async curateNotePairs(report: SweepReport, proposals: ReviewItemDetail[]): Promise<void> {
    if (this.judgment === undefined) return;
    const notes = await this.store.listNotes();
    const eligible = notes.filter(
      (note) => note.supersededBy === undefined && !note.path.startsWith("entities/"),
    );
    const retired = new Set<string>();
    for (const [a, b] of similarPairs(eligible, this.thresholds.pairSimilarityFloor)) {
      if (retired.has(a.name) || retired.has(b.name)) continue;
      const verdict = await this.judgment.classifyPair(a, b);
      if (verdict.relation === "distinct") continue;
      if (verdict.relation === "contradiction") {
        proposals.push({
          kind: "contradiction",
          a: a.name,
          b: b.name,
          aProvenance: a.provenance,
          bProvenance: b.provenance,
          confidence: verdict.confidence,
        });
        continue;
      }
      await this.applyPairAction(a, b, verdict, report, proposals, retired);
    }
  }

  private async applyPairAction(
    a: Note,
    b: Note,
    verdict: PairVerdict,
    report: SweepReport,
    proposals: ReviewItemDetail[],
    retired: Set<string>,
  ): Promise<void> {
    const { keep, retire } = resolveKeep(a, b, verdict);
    const withinBlastRadius = keep.provenance === "agent" && retire.provenance === "agent";
    if (!withinBlastRadius || verdict.confidence < this.thresholds.act) {
      proposals.push(
        verdict.relation === "duplicate"
          ? {
              kind: "merge-proposal",
              keep: keep.name,
              retire: retire.name,
              confidence: verdict.confidence,
            }
          : {
              kind: "supersession-proposal",
              winner: keep.name,
              loser: retire.name,
              confidence: verdict.confidence,
            },
      );
      return;
    }
    const body = verdict.relation === "duplicate" ? (verdict.mergedBody ?? keep.body) : keep.body;
    await this.store.writeNote({
      title: keep.title,
      body,
      provenance: "agent",
      supersedes: retire.name,
    });
    retired.add(retire.name);
    if (verdict.relation === "duplicate")
      report.merged.push({ keep: keep.name, retired: retire.name });
    else report.superseded.push({ winner: keep.name, loser: retire.name });
  }

  private async foldUsefulness(report: SweepReport): Promise<void> {
    if (this.recallsBySession.size === 0) return;
    const notes = await this.store.listNotes();
    const byLookupKey = noteLookup(notes);
    const byName = new Map(notes.map((note) => [note.name, note]));
    const values = new Map<string, number>();
    for (const note of notes) {
      if (note.usefulness !== undefined) values.set(note.name, note.usefulness);
    }
    for (const recalls of this.recallsBySession.values()) {
      this.foldSession(recalls, byLookupKey, values);
    }
    this.recallsBySession.clear();
    for (const [name, value] of values) {
      const note = byName.get(name);
      if (note === undefined) continue;
      report.usefulness[name] = value;
      if (note.provenance !== "agent") continue;
      if (Math.abs((note.usefulness ?? 0) - value) < 1e-9) continue;
      await this.stampUsefulness(note, value);
    }
  }

  private foldSession(
    recalls: Map<string, number>,
    byLookupKey: Map<string, Note>,
    values: Map<string, number>,
  ): void {
    const { emaAlpha, sessionRecallCap } = this.thresholds;
    const signals = new Map<string, number>();
    for (const [name, count] of recalls) {
      const note = byLookupKey.get(titleKey(name));
      if (note !== undefined)
        signals.set(note.name, Math.min(count, sessionRecallCap) / sessionRecallCap);
    }
    for (const name of new Set([...values.keys(), ...signals.keys()])) {
      const previous = values.get(name) ?? 0;
      values.set(name, round6(previous + emaAlpha * ((signals.get(name) ?? 0) - previous)));
    }
  }

  private async stampUsefulness(note: Note, usefulness: number): Promise<void> {
    const target = note.path.startsWith("entities/")
      ? { entity: note.name.slice("entities/".length) }
      : { title: note.title };
    await this.store.writeNote({ ...target, body: note.body, provenance: "agent", usefulness });
  }

  private proposeUnlinkedMentions(notes: Note[], proposals: ReviewItemDetail[]): void {
    const targets = notes.map((note) => ({
      note,
      keys: new Set([note.name, note.title, ...note.aliases].map(titleKey)),
      names: [note.title, ...note.aliases].filter((name) => name.length >= minimumMentionLength),
    }));
    for (const source of notes) {
      const text = source.body.replace(/\[\[[^\]]*\]\]/g, " ").toLowerCase();
      const linked = source.links.map(titleKey);
      for (const target of targets) {
        if (target.note.name === source.name) continue;
        if (linked.some((link) => target.keys.has(link))) continue;
        const mention = target.names.find((name) => mentionPattern(name).test(text));
        if (mention !== undefined) {
          proposals.push({
            kind: "link-proposal",
            note: source.name,
            target: target.note.name,
            mention,
          });
        }
      }
    }
  }
}

const minimumMentionLength = 3;

interface TaintableEntry {
  id: string;
  date: string;
  time: string;
  provenance: "user" | "agent" | "untrusted";
  text: string;
}

function isTrustedCandidate(entry: TaintableEntry): entry is DailyEntryCandidate {
  return entry.provenance !== "untrusted";
}

function emptyReport(): SweepReport {
  return {
    inert: false,
    promoted: [],
    rejected: [],
    merged: [],
    superseded: [],
    flagged: [],
    usefulness: {},
  };
}

function auditSummary(report: SweepReport): string {
  return (
    `gardener sweep: promoted ${report.promoted.length}, merged ${report.merged.length}, ` +
    `superseded ${report.superseded.length}, flagged ${report.flagged.length}, ` +
    `rejected ${report.rejected.length}`
  );
}

function resolveKeep(a: Note, b: Note, verdict: PairVerdict): { keep: Note; retire: Note } {
  const keep = verdict.keep === "a" ? a : verdict.keep === "b" ? b : newerOf(a, b);
  return keep === a ? { keep: a, retire: b } : { keep: b, retire: a };
}

function newerOf(a: Note, b: Note): Note {
  return (b.created ?? "") > (a.created ?? "") ? b : a;
}

function* similarPairs(notes: Note[], floor: number): Generator<[Note, Note]> {
  const termSets = notes.map((note) => new Set(tokenize(`${note.title} ${note.body}`)));
  for (let i = 0; i < notes.length; i += 1) {
    for (let j = i + 1; j < notes.length; j += 1) {
      const a = notes[i];
      const b = notes[j];
      const aTerms = termSets[i];
      const bTerms = termSets[j];
      if (a === undefined || b === undefined || aTerms === undefined || bTerms === undefined)
        continue;
      if (jaccard(aTerms, bTerms) >= floor) yield [a, b];
    }
  }
}

function noteLookup(notes: Note[]): Map<string, Note> {
  const byKey = new Map<string, Note>();
  for (const note of notes) {
    for (const name of [note.name, note.title, ...note.aliases]) {
      const key = titleKey(name);
      if (!byKey.has(key)) byKey.set(key, note);
    }
  }
  return byKey;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const term of a) {
    if (b.has(term)) shared += 1;
  }
  return shared / (a.size + b.size - shared);
}

function mentionPattern(name: string): RegExp {
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(name.toLowerCase())}(?![a-z0-9])`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
