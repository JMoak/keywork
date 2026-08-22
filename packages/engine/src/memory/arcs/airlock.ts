import { parseDocument } from "../frontmatter.ts";
import type { CurationJudgmentPort } from "../gardener.ts";
import { Gardener } from "../gardener.ts";
import type { ReviewInbox, ReviewItemDetail } from "../inbox.ts";
import { titleKey } from "../naming.ts";
import type { MemoryStore, Note, StagedItem } from "../store.ts";
import type { ArcBindings } from "./bindings.ts";
import type { CapEvents, OpenQuestion } from "./questions.ts";
import { type ArcRecord, type ArcRegistry, arcMocLink, MissingArcError } from "./registry.ts";

export type RubricShortfall = "uncited" | "contradicted" | "superseded";

export interface ArcCloseCandidate {
  note: Note;
  eligible: boolean;
  shortfalls: RubricShortfall[];
}

export interface AckSweep {
  acked: string[];
  wedged: string[];
  forced: boolean;
}

export interface ArcCloseDigest {
  arc: string;
  sweep: AckSweep;
  candidates: ArcCloseCandidate[];
  questions: OpenQuestion[];
  capEvents: CapEvents;
  inboxKeys: string[];
}

export type CandidateTriage = "deliver" | "leave";
export type QuestionTriage = "resolve" | "carry" | "drop";

export interface CloseDecisions {
  candidates: Record<string, CandidateTriage>;
  questions: Record<string, QuestionTriage>;
  successor?: string;
}

export interface ArcDelivery {
  arc: ArcRecord;
  delivered: string[];
  left: string[];
  recordNote: string;
  questions: Record<string, QuestionTriage>;
  releasedSessions: string[];
  drainedInboxKeys: string[];
}

export interface PrepareCloseOptions {
  flushes?: Map<string, () => Promise<unknown>>;
  force?: boolean;
}

export interface ArcAirlockOptions {
  registry: ArcRegistry;
  bindings: ArcBindings;
  workspace: MemoryStore;
  inbox: ReviewInbox;
  judgment?: CurationJudgmentPort;
  citedNotes?: (arc: string) => Promise<Iterable<string>>;
  now?: () => Date;
}

export class WedgedSessionsError extends Error {
  constructor(
    readonly arc: string,
    readonly sessions: string[],
  ) {
    super(`sessions still hold arc "${arc}": ${sessions.join(", ")}; flush them or force-complete`);
    this.name = "WedgedSessionsError";
  }
}

export class UndecidedItemsError extends Error {
  constructor(
    readonly arc: string,
    readonly items: string[],
  ) {
    super(`every item must be triaged before arc "${arc}" closes; undecided: ${items.join(", ")}`);
    this.name = "UndecidedItemsError";
  }
}

export class UnknownTriageTargetError extends Error {
  constructor(
    readonly arc: string,
    readonly items: string[],
  ) {
    super(`decisions name items arc "${arc}" does not hold: ${items.join(", ")}`);
    this.name = "UnknownTriageTargetError";
  }
}

export class IneligibleDeliveryError extends Error {
  constructor(
    readonly arc: string,
    readonly note: string,
    readonly shortfalls: RubricShortfall[],
  ) {
    super(`"${note}" is below the delivery bar (${shortfalls.join(", ")}); it stays archived`);
    this.name = "IneligibleDeliveryError";
  }
}

export class MissingSuccessorError extends Error {
  constructor(readonly arc: string) {
    super(`carrying a question out of arc "${arc}" needs an active successor arc`);
    this.name = "MissingSuccessorError";
  }
}

export class ArcStillActiveError extends Error {
  constructor(readonly arc: string) {
    super(`arc "${arc}" is still active; stragglers route only after archive`);
    this.name = "ArcStillActiveError";
  }
}

export class ArcAirlock {
  private readonly registry: ArcRegistry;
  private readonly bindings: ArcBindings;
  private readonly workspace: MemoryStore;
  private readonly inbox: ReviewInbox;
  private readonly judgment: CurationJudgmentPort | undefined;
  private readonly citedNotes: ((arc: string) => Promise<Iterable<string>>) | undefined;
  private readonly now: () => Date;

  constructor(options: ArcAirlockOptions) {
    this.registry = options.registry;
    this.bindings = options.bindings;
    this.workspace = options.workspace;
    this.inbox = options.inbox;
    this.judgment = options.judgment;
    this.citedNotes = options.citedNotes;
    this.now = options.now ?? (() => new Date());
  }

  async prepareClose(slug: string, options: PrepareCloseOptions = {}): Promise<ArcCloseDigest> {
    await this.registry.requireActive(slug);
    const sweep = await this.sweepSessions(slug, options);
    await this.distillDailyLogs(slug);
    const candidates = await this.gatherCandidates(slug);
    const questions = await this.registry.openQuestions(slug).open();
    const capEvents = await this.registry.openQuestions(slug).capEvents();
    const inboxKeys = await this.openFourthDoor(slug, candidates, questions);
    return { arc: slug, sweep, candidates, questions, capEvents, inboxKeys };
  }

  async completeClose(slug: string, decisions: CloseDecisions): Promise<ArcDelivery> {
    await this.registry.requireActive(slug);
    const candidates = await this.gatherCandidates(slug);
    const questions = await this.registry.openQuestions(slug).open();
    this.validateCoverage(slug, candidates, questions, decisions);
    await this.validateSuccessor(slug, decisions);
    const deliveryTime = this.now().toISOString();
    const delivered = await this.deliver(slug, candidates, decisions, deliveryTime);
    await this.triageQuestions(slug, decisions);
    const left = candidates
      .map((candidate) => candidate.note.name)
      .filter((name) => !delivered.includes(name));
    const sessions = this.bindings.sessionsBoundTo(slug);
    const recordNote = await this.writeDeliveryRecord(
      slug,
      delivered,
      left,
      decisions,
      sessions,
      deliveryTime,
    );
    await this.workspace.appendDaily(
      `arc ${slug} delivered · distilled ${delivered.length} notes`,
      "agent",
    );
    const arc = await this.registry.archiveArc(slug, { delivered: deliveryTime });
    const releasedSessions = this.bindings.releaseArc(slug);
    const drainedInboxKeys = await this.drainFourthDoor(slug);
    await this.workspace.recordAudit(
      `arc ${slug} closed: delivered ${delivered.length}, left ${left.length} archived, ` +
        `questions ${questionTally(decisions)}`,
    );
    return {
      arc,
      delivered,
      left,
      recordNote,
      questions: decisions.questions,
      releasedSessions,
      drainedInboxKeys,
    };
  }

  async abandon(slug: string): Promise<ArcRecord> {
    const arc = await this.registry.archiveArc(slug, { abandoned: true });
    this.bindings.releaseArc(slug);
    await this.drainFourthDoor(slug);
    await this.workspace.recordAudit(`arc ${slug} abandoned: archived without distillation`);
    return arc;
  }

  async routeStragglers(slug: string): Promise<string[]> {
    const record = await this.registry.readArc(slug);
    if (record === undefined) throw new MissingArcError(slug);
    if (record.status !== "archived") throw new ArcStillActiveError(slug);
    const arcStore = this.registry.arcStore(slug);
    const routed: string[] = [];
    for (const item of await arcStore.listStaged()) {
      await this.routeStraggler(slug, item);
      await arcStore.discard(item.id);
      routed.push(item.target);
    }
    if (routed.length > 0)
      await this.workspace.recordAudit(
        `arc ${slug} stragglers routed to the workspace inbox: ${routed.join(", ")}`,
      );
    return routed;
  }

  private async sweepSessions(slug: string, options: PrepareCloseOptions): Promise<AckSweep> {
    const acked: string[] = [];
    const wedged: string[] = [];
    for (const sessionId of this.bindings.sessionsBoundTo(slug)) {
      const flush = options.flushes?.get(sessionId);
      if (flush === undefined) {
        wedged.push(sessionId);
        continue;
      }
      try {
        await flush();
        acked.push(sessionId);
      } catch {
        wedged.push(sessionId);
      }
    }
    const forced = options.force === true;
    if (wedged.length > 0 && !forced) throw new WedgedSessionsError(slug, wedged);
    return { acked, wedged, forced };
  }

  private async distillDailyLogs(slug: string): Promise<void> {
    if (this.judgment === undefined) return;
    const gardener = new Gardener({
      store: this.registry.arcStore(slug),
      inbox: this.inbox,
      judgment: this.judgment,
    });
    await gardener.sweep();
  }

  private async gatherCandidates(slug: string): Promise<ArcCloseCandidate[]> {
    const notes = await this.registry.arcStore(slug).listNotes();
    const cited = new Set(
      [...((await this.citedNotes?.(slug)) ?? [])].map((name) => titleKey(name)),
    );
    const contradicted = await this.contradictedNames();
    return notes.map((note) => {
      const shortfalls: RubricShortfall[] = [];
      if (!cited.has(titleKey(note.name)) && !cited.has(titleKey(note.title)))
        shortfalls.push("uncited");
      if (contradicted.has(titleKey(note.name))) shortfalls.push("contradicted");
      if (note.supersededBy !== undefined) shortfalls.push("superseded");
      return { note, eligible: shortfalls.length === 0, shortfalls };
    });
  }

  private async contradictedNames(): Promise<Set<string>> {
    const names = new Set<string>();
    for (const item of await this.inbox.list()) {
      if (item.kind !== "contradiction") continue;
      names.add(titleKey(item.a));
      names.add(titleKey(item.b));
    }
    return names;
  }

  private async openFourthDoor(
    slug: string,
    candidates: ArcCloseCandidate[],
    questions: OpenQuestion[],
  ): Promise<string[]> {
    const details: ReviewItemDetail[] = [
      ...candidates.map(
        (candidate): ReviewItemDetail => ({
          kind: "arc-distillation",
          arc: slug,
          note: candidate.note.name,
          eligible: candidate.eligible,
        }),
      ),
      ...questions.map(
        (question): ReviewItemDetail => ({ kind: "arc-question", arc: slug, note: question.title }),
      ),
    ];
    return (await this.inbox.add(details)).map((item) => item.key);
  }

  private async drainFourthDoor(slug: string): Promise<string[]> {
    const drained: string[] = [];
    for (const item of await this.inbox.list()) {
      if (item.kind !== "arc-distillation" && item.kind !== "arc-question") continue;
      if (item.arc !== slug) continue;
      await this.inbox.resolve(item.id);
      drained.push(item.key);
    }
    return drained;
  }

  private validateCoverage(
    slug: string,
    candidates: ArcCloseCandidate[],
    questions: OpenQuestion[],
    decisions: CloseDecisions,
  ): void {
    const candidateNames = new Set(candidates.map((candidate) => candidate.note.name));
    const questionTitles = new Set(questions.map((question) => question.title));
    const unknown = [
      ...Object.keys(decisions.candidates).filter((name) => !candidateNames.has(name)),
      ...Object.keys(decisions.questions).filter((title) => !questionTitles.has(title)),
    ];
    if (unknown.length > 0) throw new UnknownTriageTargetError(slug, unknown);
    const undecided = [
      ...[...candidateNames].filter((name) => decisions.candidates[name] === undefined),
      ...[...questionTitles].filter((title) => decisions.questions[title] === undefined),
    ];
    if (undecided.length > 0) throw new UndecidedItemsError(slug, undecided);
  }

  private async validateSuccessor(slug: string, decisions: CloseDecisions): Promise<void> {
    if (!Object.values(decisions.questions).includes("carry")) return;
    if (decisions.successor === undefined || decisions.successor === slug)
      throw new MissingSuccessorError(slug);
    await this.registry.requireActive(decisions.successor);
  }

  private async deliver(
    slug: string,
    candidates: ArcCloseCandidate[],
    decisions: CloseDecisions,
    deliveryTime: string,
  ): Promise<string[]> {
    const delivered: string[] = [];
    for (const candidate of candidates) {
      if (decisions.candidates[candidate.note.name] !== "deliver") continue;
      if (!candidate.eligible)
        throw new IneligibleDeliveryError(slug, candidate.note.name, candidate.shortfalls);
      const result = await this.workspace.writeNote({
        ...noteTarget(candidate.note),
        body: candidate.note.body,
        provenance: candidate.note.provenance,
        ...(candidate.note.confidence !== undefined && { confidence: candidate.note.confidence }),
        delivered: deliveryTime,
        distilledFrom: arcMocLink(slug),
      });
      delivered.push(noteNameFromPath(result.path));
    }
    return delivered;
  }

  private async triageQuestions(slug: string, decisions: CloseDecisions): Promise<void> {
    const questions = this.registry.openQuestions(slug);
    for (const [title, triage] of Object.entries(decisions.questions)) {
      if (triage === "resolve") await questions.resolve(title);
      if (triage === "drop") await questions.drop(title);
      if (triage === "carry") await this.carryQuestion(slug, title, decisions);
    }
  }

  private async carryQuestion(
    slug: string,
    title: string,
    decisions: CloseDecisions,
  ): Promise<void> {
    const successor = decisions.successor;
    if (successor === undefined) throw new MissingSuccessorError(slug);
    const questions = this.registry.openQuestions(slug);
    const question = (await questions.open()).find((candidate) => candidate.title === title);
    if (question === undefined) return;
    await this.registry.openQuestions(successor).add({
      title: question.title,
      body: question.body,
      provenance: question.provenance,
    });
    await questions.markCarried(title, successor);
  }

  private async writeDeliveryRecord(
    slug: string,
    delivered: string[],
    left: string[],
    decisions: CloseDecisions,
    sessions: string[],
    deliveryTime: string,
  ): Promise<string> {
    const result = await this.workspace.writeNote({
      title: `arc ${slug} delivery`,
      body: deliveryRecordBody(slug, delivered, left, decisions, sessions, deliveryTime),
      provenance: "agent",
      delivered: deliveryTime,
      distilledFrom: arcMocLink(slug),
    });
    return noteNameFromPath(result.path);
  }

  private async routeStraggler(slug: string, item: StagedItem): Promise<void> {
    if (item.kind === "note") {
      const { body } = parseDocument(item.content, item.target);
      await this.workspace.writeNote({
        ...stagedNoteTarget(item.target),
        body,
        provenance: "untrusted",
      });
      return;
    }
    const text =
      item.kind === "daily" ? stripDailyMarkers(item.content) : `arc ${slug} straggler MOC update`;
    await this.workspace.appendDaily(`straggler from arc ${slug}: ${text}`, "untrusted");
  }
}

function noteTarget(note: Note): { title: string } | { entity: string } {
  return note.path.startsWith("entities/")
    ? { entity: note.name.slice("entities/".length) }
    : { title: note.title };
}

function stagedNoteTarget(target: string): { title: string } | { entity: string } {
  const name = noteNameFromPath(target);
  return target.startsWith("entities/")
    ? { entity: name.slice("entities/".length) }
    : { title: name.slice(name.lastIndexOf("/") + 1) };
}

function noteNameFromPath(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -".md".length) : path;
}

function stripDailyMarkers(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^- \d{2}:\d{2} \[prov: (?:user|agent|untrusted)\] /, ""))
    .join("\n")
    .trim();
}

function questionTally(decisions: CloseDecisions): string {
  const triages = Object.values(decisions.questions);
  const count = (triage: QuestionTriage) => triages.filter((value) => value === triage).length;
  return `${count("resolve")} resolved / ${count("carry")} carried / ${count("drop")} dropped`;
}

function deliveryRecordBody(
  slug: string,
  delivered: string[],
  left: string[],
  decisions: CloseDecisions,
  sessions: string[],
  deliveryTime: string,
): string {
  const deliveredLines =
    delivered.length > 0 ? delivered.map((name) => `- [[${name}]]`).join("\n") : "- none";
  return [
    `arc ${slug} closed ${deliveryTime}; distilled ${delivered.length} notes into the workspace garden.`,
    "",
    "delivered:",
    deliveredLines,
    "",
    `rubric: cited at least once, uncontradicted, survived to close; ${left.length} below-bar notes stay archived in the arc layer.`,
    `questions: ${questionTally(decisions)}.`,
    `sessions: ${sessions.length > 0 ? sessions.join(", ") : "none"}.`,
    "",
    `source: [[${arcMocLink(slug)}]]`,
    "",
  ].join("\n");
}
