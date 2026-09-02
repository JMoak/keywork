import {
  type AirlockCandidateView,
  type AirlockDigestView,
  type AirlockQuestionView,
  arcTag,
} from "./arcs.ts";
import { type MarkdownRow, markdownRowText, renderMarkdown } from "./markdown.ts";
import type {
  CuringStage,
  InboxItemView,
  InboxKind,
  LedgerEventView,
  MemoryLayerView,
  MemoryNoteView,
  MemoryPaneInputs,
  MemoryProvenance,
  MemoryQueryHit,
  MemoryQueryState,
  NoteRelationView,
} from "./memory-pane-model.ts";
import { proseWidth, resolvePage } from "./page.ts";
import type { RowTone } from "./pane-chrome.ts";
import { pluralize } from "./pluralize.ts";
import { relativeAge } from "./sessions-overview-model.ts";

export type MemoryRowKind =
  | "state"
  | "query"
  | "layer"
  | "section"
  | "inbox"
  | "airlock"
  | "note"
  | "strip"
  | "body"
  | "header"
  | "link"
  | "ledger"
  | "hit"
  | "why"
  | "empty";

export type SpanInk = "text" | "mid" | "dim" | "heading" | "accent" | "arc";

export interface RowSpan {
  text: string;
  ink: SpanInk;
}

export interface MemoryRow {
  id: string;
  kind: MemoryRowKind;
  text: string;
  tone: RowTone;
  selectable: boolean;
  note?: string;
  layer?: string;
  inboxId?: string;
  ledgerId?: string;
  file?: string;
  arc?: string;
  airlock?: AirlockRowRef;
  spans?: RowSpan[];
  markdown?: MarkdownRow;
  rail?: boolean;
}

export type DigestTreatment = "tail" | "stamp";

export type GardenHeat = "lead" | "ink";

export function noteHeat(note: MemoryNoteView): number {
  if (note.supersededBy !== undefined) return 0;
  const usefulness = Math.min(1, Math.max(0, note.usefulness ?? 0));
  const recalled = Math.min(3, note.recalls ?? 0) / 3;
  return usefulness * 0.7 + recalled * 0.3;
}

export type AirlockRowKind = "candidate" | "question" | "fold" | "finish";

export interface AirlockRowRef {
  arc: string;
  kind: AirlockRowKind;
  key: string;
}

export interface GardenOptions {
  focusedArc: string | undefined;
  now: number;
  treatment?: DigestTreatment;
  heat?: GardenHeat;
  unfolded?: (arc: string) => boolean;
}

export interface NoteLensOptions {
  now: number;
  bodyWidth: number;
}

export interface LedgerOptions {
  note: string | undefined;
  now: number;
}

export function gardenRows(inputs: MemoryPaneInputs, options: GardenOptions): MemoryRow[] {
  if (inputs.notes.length === 0 && inputs.inbox.length === 0) return calmRows(inputs.layers);
  return [
    stateRow(inputs, options.now),
    ...orderedLayers(inputs.layers, options.focusedArc).flatMap((layer) =>
      layerRows(layer, inputs, options),
    ),
  ];
}

export function queryRows(
  inputs: MemoryPaneInputs,
  query: MemoryQueryState,
  now: number,
): MemoryRow[] {
  const line = queryLineRow(query);
  if (query.text === "") return [line, emptyRow("ask-hint", askHint)];
  if (query.outcome === undefined) return [line, emptyRow("asking", "░ asking…")];
  if (query.outcome.hits.length === 0) return [line, emptyRow("no-hits", "░ nothing matches")];
  return [line, ...query.outcome.hits.flatMap((hit, at) => hitRows(inputs, hit, at, now))];
}

export function noteRows(
  inputs: MemoryPaneInputs,
  focus: MemoryNoteView,
  options: NoteLensOptions,
): MemoryRow[] {
  const layer = inputs.layers.find((candidate) => candidate.id === focus.layer);
  const outline = [
    ...linksOutRows(inputs.notes, focus, options.now),
    ...linksInRows(inputs.notes, focus, options.now),
    ...typedRelationRows(inputs.notes, focus, options.now),
    ...stagedForRows(inputs.inbox, focus, options.now),
  ];
  return [
    titleRow(focus),
    stripRow("facts", noteFacts(focus, layer, options.now)),
    ...relationStrip(focus, options.now),
    ...bodyRows(focus, options.bodyWidth),
    ...(outline.length === 0 ? [emptyRow("no-links", "no links yet")] : outline),
  ].map((row) => ({ ...row, rail: true }));
}

export function ledgerRows(inputs: MemoryPaneInputs, options: LedgerOptions): MemoryRow[] {
  const focus = options.note === undefined ? undefined : findNote(inputs.notes, options.note);
  const events = inputs.ledger
    .filter((event) => options.note === undefined || event.notes.includes(options.note))
    .sort((a, b) => b.at.localeCompare(a.at));
  const subject = focus?.title ?? options.note;
  const facts = [pluralize(events.length, "event"), ...(subject === undefined ? [] : [subject])];
  const rows = events.map((event, at) => ledgerRow(event, at, options.now));
  return [
    header(`ledger · ${facts.join(" · ")}`),
    ...(rows.length === 0
      ? [
          emptyRow(
            "ledger-empty",
            subject === undefined ? "nothing recorded yet" : `nothing recorded for ${subject} yet`,
          ),
        ]
      : rows),
  ];
}

export function findNote(
  notes: readonly MemoryNoteView[],
  reference: string,
  layer?: string,
): MemoryNoteView | undefined {
  const matches = notes.filter((note) => matchesNote(note, reference));
  return matches.find((note) => note.layer === layer) ?? matches[0];
}

export function curingGlyph(stage: CuringStage): string {
  return densityRamp[stage];
}

export function provenanceGlyph(provenance: MemoryProvenance): string {
  return provenanceMarks[provenance];
}

export function curingWord(stage: CuringStage): string {
  return curingWords[stage];
}

export function compactTokens(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

const densityRamp = ["░", "▒", "▓", "█"] as const;
const curingWords = ["fresh", "curing", "cured", "settled"] as const;
const provenanceMarks: Record<MemoryProvenance, string> = {
  user: "█",
  agent: "▓",
  untrusted: "░",
};
const inboxKindWords: Record<InboxKind, string> = {
  staged: "staged",
  promotion: "promote",
  contradiction: "conflict",
  proposal: "proposal",
  airlock: "airlock",
};
const tileFill = ["▌", "▌▀", "▌▀▗", "█"] as const;
const askHint = "what do you know about … · enter opens a hit · esc closes";
const whyIndent = "   ";

function calmRows(layers: readonly MemoryLayerView[]): MemoryRow[] {
  const rows = [emptyRow("calm", "nothing remembered yet")];
  if (layers.length > 0) {
    rows.push(emptyRow("calm-layers", layers.map((layer) => layerLabel(layer)).join(" · ")));
  }
  return rows;
}

export const askHintText = "? ask";

function stateRow(inputs: MemoryPaneInputs, now: number): MemoryRow {
  const facts = stateFacts(inputs, now);
  return {
    id: "state",
    kind: "state",
    text: `${facts.join(" · ")} · ${askHintText}`,
    tone: "normal",
    selectable: false,
    spans: [
      ...facts.map((fact): RowSpan => ({ text: fact, ink: "mid" })),
      { text: askHintText, ink: "dim" },
    ],
  };
}

function stateFacts(inputs: MemoryPaneInputs, now: number): string[] {
  const curing = inputs.notes.filter((note) => note.curing < 3).length;
  const staged = inputs.inbox.filter((item) => item.kind === "staged").length;
  const conflicts = inputs.inbox.filter((item) => item.kind === "contradiction").length;
  const airlock = inputs.inbox.filter((item) => item.kind === "airlock").length;
  const proposals = inputs.inbox.length - staged - conflicts - airlock;
  return [
    pluralize(inputs.notes.length, "note"),
    ...(curing === 0 ? [] : [`${curing} curing`]),
    ...(staged === 0 ? [] : [`░${staged}`]),
    ...(conflicts === 0 ? [] : [pluralize(conflicts, "conflict")]),
    ...(proposals === 0 ? [] : [pluralize(proposals, "proposal")]),
    ...(airlock === 0 ? [] : [`airlock ░${airlock}`]),
    ...sweepFact(inputs, now),
  ];
}

function sweepFact(inputs: MemoryPaneInputs, now: number): string[] {
  const gardener = inputs.gardener;
  if (gardener?.state === "working") return [`sweeping ${tileFillGlyph(gardener)}`];
  if (gardener?.state === "failed") return ["sweep failed ▛"];
  const swept = gardener?.sweptAt;
  return swept === undefined ? [] : [`swept ${relativeAge(now, Date.parse(swept))}`];
}

function tileFillGlyph(activity: { phasesDone?: number; phaseCount?: number }): string {
  const { phasesDone, phaseCount } = activity;
  if (phasesDone === undefined || phaseCount === undefined || phaseCount === 0) return tileFill[0];
  const step = Math.min(tileFill.length - 1, Math.floor((phasesDone / phaseCount) * 3));
  return tileFill[step] ?? tileFill[0];
}

function orderedLayers(
  layers: readonly MemoryLayerView[],
  focusedArc: string | undefined,
): MemoryLayerView[] {
  const focused = layers.filter((layer) => layer.kind === "arc" && layer.arc === focusedArc);
  const workspace = layers.filter((layer) => layer.kind === "workspace");
  const otherArcs = layers.filter((layer) => layer.kind === "arc" && layer.arc !== focusedArc);
  const user = layers.filter((layer) => layer.kind === "user");
  return [...focused, ...workspace, ...otherArcs, ...user];
}

function layerRows(
  layer: MemoryLayerView,
  inputs: MemoryPaneInputs,
  options: GardenOptions,
): MemoryRow[] {
  const notes = inputs.notes.filter((note) => note.layer === layer.id);
  const digest = digestOf(layer, inputs);
  const inbox = inputs.inbox.filter(
    (item) =>
      inboxLayerOf(item, inputs.layers) === layer.id &&
      (digest === undefined || item.kind !== "airlock"),
  );
  const focused = layer.kind === "arc" && layer.arc === options.focusedArc;
  if (notes.length === 0 && inbox.length === 0 && digest === undefined && !focused) return [];
  const waiting = inbox.length + (digest === undefined ? 0 : digestSize(digest));
  return [
    layerHeader(layer, notes.length, waiting, digest),
    ...(digest === undefined ? [] : digestRows(digest, options)),
    ...sortedInbox(inbox).map((item) => inboxRow(item, options.now)),
    ...noteSectionRows(layer, notes, options),
  ];
}

function digestOf(layer: MemoryLayerView, inputs: MemoryPaneInputs): AirlockDigestView | undefined {
  if (layer.kind !== "arc") return undefined;
  return inputs.airlocks?.find((digest) => digest.arc === layer.arc);
}

function digestSize(digest: AirlockDigestView): number {
  return digest.candidates.length + digest.questions.length;
}

function digestRows(digest: AirlockDigestView, options: GardenOptions): MemoryRow[] {
  const treatment = options.treatment ?? "stamp";
  const eligible = digest.candidates.filter((candidate) => candidate.eligible);
  const belowBar = digest.candidates.filter((candidate) => !candidate.eligible);
  const unfolded = options.unfolded?.(digest.arc) === true;
  return [
    ...eligible.map((candidate) => candidateRow(digest.arc, candidate, treatment, options.now)),
    ...digest.questions.map((question) =>
      questionRow(digest.arc, question, digest.successor, treatment, options.now),
    ),
    ...(belowBar.length === 0 ? [] : [foldRow(digest.arc, belowBar, unfolded)]),
    ...(unfolded ? belowBar.map((candidate) => belowBarRow(digest.arc, candidate)) : []),
    finishRow(digest),
  ];
}

function candidateRow(
  arc: string,
  candidate: AirlockCandidateView,
  treatment: DigestTreatment,
  now: number,
): MemoryRow {
  const facts = candidate.created === undefined ? [] : [ageOf(now, candidate.created)];
  return decisionRow(
    { arc, kind: "candidate", key: candidate.note },
    treatment,
    provenanceGlyph(candidate.provenance),
    candidate.title,
    facts,
    candidate.choice,
    candidate.note,
  );
}

function questionRow(
  arc: string,
  question: AirlockQuestionView,
  successor: string | undefined,
  treatment: DigestTreatment,
  now: number,
): MemoryRow {
  const facts = [
    "question",
    ...(question.created === undefined ? [] : [ageOf(now, question.created)]),
  ];
  const choice =
    question.choice === "carry" && successor !== undefined
      ? `carry to ${arcTag(successor)}`
      : question.choice;
  return decisionRow(
    { arc, kind: "question", key: question.title },
    treatment,
    provenanceGlyph(question.provenance),
    question.title,
    facts,
    choice,
  );
}

function decisionRow(
  ref: AirlockRowRef,
  treatment: DigestTreatment,
  provenance: string,
  title: string,
  facts: string[],
  choice: string | undefined,
  note?: string,
): MemoryRow {
  const tail = facts.length === 0 ? "" : ` · ${facts.join(" · ")}`;
  const spans: RowSpan[] =
    treatment === "stamp"
      ? [
          { text: `${choice === undefined ? "░" : "█"}${provenance} `, ink: "text" },
          ...(choice === undefined ? [] : [{ text: `${choice} · `, ink: "accent" as const }]),
          { text: title, ink: "text" },
          { text: tail, ink: "dim" },
        ]
      : [
          { text: `${provenance} `, ink: "text" },
          { text: title, ink: "text" },
          { text: tail, ink: "dim" },
          choice === undefined
            ? { text: " · undecided", ink: "dim" }
            : { text: ` → ${choice}`, ink: "accent" },
        ];
  return {
    id: `airlock:${ref.arc}:${ref.kind}:${ref.key}`,
    kind: "airlock",
    text: spans.map((span) => span.text).join(""),
    tone: "normal",
    selectable: true,
    airlock: ref,
    ...(note !== undefined && { note }),
    spans,
  };
}

function foldRow(arc: string, belowBar: AirlockCandidateView[], unfolded: boolean): MemoryRow {
  const shortfalls = [...new Set(belowBar.flatMap((candidate) => candidate.shortfalls))];
  const lead = unfolded ? "▒ " : "░ ";
  const text = `${lead}${belowBar.length} below the bar · ${shortfalls.join(", ")} · archived, searchable`;
  return {
    id: `airlock:${arc}:fold`,
    kind: "airlock",
    text,
    tone: "dim",
    selectable: true,
    airlock: { arc, kind: "fold", key: "fold" },
  };
}

function belowBarRow(arc: string, candidate: AirlockCandidateView): MemoryRow {
  return {
    id: `airlock:${arc}:below:${candidate.note}`,
    kind: "airlock",
    text: `  ${provenanceGlyph(candidate.provenance)} ${candidate.title} · ${candidate.shortfalls.join(", ")}`,
    tone: "dim",
    selectable: true,
    note: candidate.note,
  };
}

function finishRow(digest: AirlockDigestView): MemoryRow {
  const undecided = [
    ...digest.candidates.filter(
      (candidate) => candidate.eligible && candidate.choice === undefined,
    ),
    ...digest.questions.filter((question) => question.choice === undefined),
  ].length;
  const wedged = digest.sweep?.wedged ?? 0;
  const lead = undecided === 0 ? "█ close " : "░ close ";
  const facts = [
    ...(undecided === 0
      ? ["enter closes"]
      : [`${undecided} to decide`, "a here delivers all eligible"]),
    ...(wedged === 0
      ? []
      : [`${wedged} ${wedged === 1 ? "session" : "sessions"} didn't flush · f forces`]),
  ];
  const tail = ` · ${facts.join(" · ")}`;
  return {
    id: `airlock:${digest.arc}:finish`,
    kind: "airlock",
    text: `${lead}${arcTag(digest.arc)}${tail}`,
    tone: "normal",
    selectable: true,
    arc: digest.arc,
    airlock: { arc: digest.arc, kind: "finish", key: "finish" },
    spans: [
      { text: lead, ink: "text" },
      { text: arcTag(digest.arc), ink: "arc" },
      { text: tail, ink: "dim" },
    ],
  };
}

function inboxLayerOf(item: InboxItemView, layers: readonly MemoryLayerView[]): string {
  const arcLayer =
    item.arc === undefined
      ? undefined
      : layers.find((layer) => layer.kind === "arc" && layer.arc === item.arc);
  return arcLayer?.id ?? layers.find((layer) => layer.kind === "workspace")?.id ?? "workspace";
}

function layerHeader(
  layer: MemoryLayerView,
  notes: number,
  inbox: number,
  digest: AirlockDigestView | undefined,
): MemoryRow {
  const label = layerLabel(layer);
  const queue = layer.kind === "arc" ? "airlock" : "inbox";
  const facts = [
    notes === 0 ? "no notes yet" : pluralize(notes, "note"),
    ...(inbox === 0 ? [] : [`${queue} ░${inbox}`]),
    ...sweepFacts(digest?.sweep),
    ...(digest?.direction === undefined ? [] : [`steered: ${digest.direction}`]),
  ];
  const tail = ` · ${facts.join(" · ")}`;
  return {
    id: `layer:${layer.id}`,
    kind: "layer",
    text: `${label}${tail}`,
    tone: "heading",
    selectable: false,
    ...(layer.arc !== undefined && { arc: layer.arc }),
    spans: [
      { text: label, ink: layer.kind === "arc" ? "arc" : "heading" },
      { text: tail, ink: "dim" },
    ],
  };
}

function sweepFacts(sweep: AirlockDigestView["sweep"]): string[] {
  if (sweep === undefined) return [];
  return [
    ...(sweep.acked === 0 ? [] : [`${sweep.acked} flushed`]),
    ...(sweep.wedged === 0 ? [] : [`${sweep.wedged} didn't flush`]),
  ];
}

function layerLabel(layer: MemoryLayerView): string {
  return layer.arc === undefined ? layer.label : arcTag(layer.arc);
}

function noteSectionRows(
  layer: MemoryLayerView,
  notes: readonly MemoryNoteView[],
  options: Pick<GardenOptions, "now" | "heat">,
): MemoryRow[] {
  const { now } = options;
  const live = notes.filter((note) => note.supersededBy === undefined);
  const superseded = notes.filter((note) => note.supersededBy !== undefined);
  const row = (note: MemoryNoteView): MemoryRow =>
    noteRow(note, `note:${layer.id}:${note.name}`, 0, now, options.heat);
  if (layer.prompt === undefined) {
    return [...mostUsefulFirst(live).map(row), ...byTitle(superseded).map(row)];
  }
  const injected = live.filter((note) => note.injected === true);
  const searchable = [
    ...mostUsefulFirst(live.filter((note) => note.injected !== true)),
    ...byTitle(superseded),
  ];
  const budget = `in prompt · ${compactTokens(layer.prompt.used)} of ${compactTokens(layer.prompt.budget)} tokens`;
  return [
    sectionRow(`${layer.id}:prompt`, budget),
    ...injected.map(row),
    ...(searchable.length === 0 ? [] : [sectionRow(`${layer.id}:search`, "by search only")]),
    ...searchable.map(row),
  ];
}

function mostUsefulFirst(notes: readonly MemoryNoteView[]): MemoryNoteView[] {
  return [...notes].sort(
    (a, b) => (b.usefulness ?? -1) - (a.usefulness ?? -1) || a.title.localeCompare(b.title),
  );
}

function byTitle(notes: readonly MemoryNoteView[]): MemoryNoteView[] {
  return [...notes].sort((a, b) => a.title.localeCompare(b.title));
}

function sortedInbox(inbox: readonly InboxItemView[]): InboxItemView[] {
  return [...inbox].sort((a, b) => a.created.localeCompare(b.created));
}

function inboxRow(item: InboxItemView, now: number): MemoryRow {
  const detail = item.detail === undefined ? "" : ` · ${item.detail}`;
  const lead = `${provenanceGlyph(item.provenance)} ${inboxKindWords[item.kind]} · `;
  const facts = `${detail} · ${ageOf(now, item.created)}`;
  return {
    id: `inbox:${item.id}`,
    kind: "inbox",
    text: `${lead}${item.title}${facts}`,
    tone: "normal",
    selectable: true,
    ...(item.kind !== "airlock" && { inboxId: item.id }),
    ...(item.note !== undefined && { note: item.note }),
    spans: [
      { text: lead, ink: "text" },
      { text: item.title, ink: "text" },
      { text: facts, ink: "dim" },
    ],
  };
}

function noteRow(
  note: MemoryNoteView,
  id: string,
  indent: number,
  now: number,
  heat?: GardenHeat,
): MemoryRow {
  const heatLead = heat === "lead" ? `${heatGlyph(noteHeat(note))} ` : "";
  const lead = `${"  ".repeat(indent)}${heatLead}${curingGlyph(note.curing)}${provenanceGlyph(note.provenance)} `;
  const successor = note.supersededBy === undefined ? "" : ` → ${note.supersededBy}`;
  const facts = noteRowFacts(note, now);
  const tail = facts.length === 0 ? "" : ` · ${facts.join(" · ")}`;
  const dimmed = note.supersededBy !== undefined;
  return {
    id,
    kind: "note",
    text: `${lead}${note.title}${successor}${tail}`,
    tone: dimmed ? "dim" : "normal",
    selectable: true,
    note: note.name,
    layer: note.layer,
    ...(note.file !== undefined && { file: note.file }),
    spans: [
      { text: lead, ink: dimmed ? "dim" : "text" },
      { text: note.title, ink: titleInk(note, dimmed, heat) },
      { text: `${successor}${tail}`, ink: "dim" },
    ],
  };
}

function heatGlyph(heat: number): string {
  if (heat <= 0) return "·";
  return densityRamp[Math.min(3, Math.floor(heat * 4))] ?? "░";
}

function titleInk(note: MemoryNoteView, dimmed: boolean, heat: GardenHeat | undefined): SpanInk {
  if (dimmed) return "dim";
  if (heat !== "ink") return "text";
  const warmth = noteHeat(note);
  if (warmth >= 0.66) return "accent";
  if (warmth >= 0.33) return "text";
  return "dim";
}

function noteRowFacts(note: MemoryNoteView, now: number): string[] {
  return [
    ...(note.pinned === true ? ["pinned"] : []),
    ...(note.created === undefined ? [] : [ageOf(now, note.created)]),
    ...(note.recalls === undefined || note.recalls === 0 ? [] : [`${note.recalls}×`]),
  ];
}

function titleRow(note: MemoryNoteView): MemoryRow {
  const lead = `${curingGlyph(note.curing)}${provenanceGlyph(note.provenance)} `;
  return {
    id: `focus:${note.name}`,
    kind: "note",
    text: `${lead}${note.title}`,
    tone: "normal",
    selectable: true,
    note: note.name,
    layer: note.layer,
    ...(note.file !== undefined && { file: note.file }),
    spans: [
      { text: lead, ink: "text" },
      { text: note.title, ink: "accent" },
    ],
  };
}

function noteFacts(
  note: MemoryNoteView,
  layer: MemoryLayerView | undefined,
  now: number,
): RowSpan[] {
  const words = [
    note.provenance,
    curingWord(note.curing),
    ...(layer?.prompt === undefined
      ? []
      : [note.injected === true ? "in prompt" : "by search only"]),
    ...(note.pinned === true ? ["pinned"] : []),
    ...(note.created === undefined ? [] : [ageOf(now, note.created)]),
    ...(note.recalls === undefined || note.recalls === 0 ? [] : [`recalled ${note.recalls}×`]),
  ];
  const spans: RowSpan[] = [{ text: words.join(" · "), ink: "mid" }];
  if (layer?.arc !== undefined) {
    spans.push({ text: " · ", ink: "mid" }, { text: arcTag(layer.arc), ink: "arc" });
  }
  return spans;
}

function relationStrip(note: MemoryNoteView, now: number): MemoryRow[] {
  const facts = [
    ...(note.supersedes === undefined ? [] : [`supersedes ${note.supersedes}`]),
    ...(note.supersededBy === undefined ? [] : [`superseded by ${note.supersededBy}`]),
    ...(note.distilledFrom === undefined ? [] : [`from ${arcTagOfMoc(note.distilledFrom)}`]),
    ...(note.delivered === undefined ? [] : [`delivered ${ageOf(now, note.delivered)} ago`]),
  ];
  if (facts.length === 0) return [];
  return [stripRow("relations", [{ text: facts.join(" · "), ink: "mid" }])];
}

function arcTagOfMoc(link: string): string {
  const match = /^arcs\/([^/]+)\/MOC$/.exec(link);
  return match?.[1] === undefined ? link : arcTag(match[1]);
}

function stripRow(id: string, spans: RowSpan[]): MemoryRow {
  return {
    id: `strip:${id}`,
    kind: "strip",
    text: spans.map((span) => span.text).join(""),
    tone: "dim",
    selectable: false,
    spans,
  };
}

function bodyRows(note: MemoryNoteView, bodyWidth: number): MemoryRow[] {
  const body = note.body?.trim() ?? "";
  if (body === "") return [];
  const page = resolvePage(bodyWidth);
  const rendered = renderMarkdown(body, proseWidth(page, bodyWidth), bodyWidth);
  return [
    blankRow("before-body"),
    ...rendered.map((row, at) => {
      const text = markdownRowText(row);
      return {
        id: `body:${at}`,
        kind: "body" as const,
        text,
        tone: "normal" as const,
        selectable: text !== "",
        markdown: row,
      };
    }),
    blankRow("after-body"),
  ];
}

function linksOutRows(
  notes: readonly MemoryNoteView[],
  focus: MemoryNoteView,
  now: number,
): MemoryRow[] {
  const rows: MemoryRow[] = [];
  for (const link of focus.links) {
    const target = findNote(notes, link, focus.layer);
    if (target === undefined) {
      rows.push(deadLinkRow(`out:${link}`, link, 1));
      continue;
    }
    rows.push(linkRow(target, `out:${target.name}`, 1, now));
    for (const hop of target.links) {
      if (matchesNote(focus, hop)) continue;
      const second = findNote(notes, hop, target.layer);
      if (second === undefined) rows.push(deadLinkRow(`out:${target.name}:${hop}`, hop, 2));
      else rows.push(linkRow(second, `out:${target.name}:${second.name}`, 2, now));
    }
  }
  return rows.length === 0 ? [] : [header("links out"), ...rows];
}

function linksInRows(
  notes: readonly MemoryNoteView[],
  focus: MemoryNoteView,
  now: number,
): MemoryRow[] {
  const sources = notes.filter(
    (note) => note.name !== focus.name && note.links.some((link) => matchesNote(focus, link)),
  );
  if (sources.length === 0) return [];
  return [
    header("links in"),
    ...sources.map((source) => linkRow(source, `in:${source.name}`, 1, now)),
  ];
}

function typedRelationRows(
  notes: readonly MemoryNoteView[],
  focus: MemoryNoteView,
  now: number,
): MemoryRow[] {
  const groups = new Map<string, NoteRelationView[]>();
  const seen = new Set<string>();
  for (const relation of (focus.relations ?? []).map(canonicalRelation)) {
    if (relation.predicate === "relates_to") continue;
    const key = `${relation.direction}:${relation.predicate}:${relation.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const heading = relationHeading(relation);
    groups.set(heading, [...(groups.get(heading) ?? []), relation]);
  }
  return [...groups].flatMap(([heading, relations]) => [
    header(heading),
    ...relations.map((relation) => {
      const target = findNote(notes, relation.name, focus.layer);
      const id = `${relation.direction}:${relation.predicate}:${relation.name}`;
      return target === undefined ? deadLinkRow(id, relation.name, 1) : linkRow(target, id, 1, now);
    }),
  ]);
}

const inversePredicates: Record<string, string> = {
  superseded_by: "supersedes",
  consolidated_by: "consolidates",
};

function canonicalRelation(relation: NoteRelationView): NoteRelationView {
  const forward = inversePredicates[relation.predicate];
  if (forward === undefined) return relation;
  return {
    name: relation.name,
    predicate: forward,
    direction: relation.direction === "out" ? "in" : "out",
  };
}

function relationHeading(relation: NoteRelationView): string {
  const words = relation.predicate.replace(/_/g, " ");
  return relation.direction === "out" ? `→ ${words}` : `← ${words}`;
}

function stagedForRows(
  inbox: readonly InboxItemView[],
  focus: MemoryNoteView,
  now: number,
): MemoryRow[] {
  const mine = inbox.filter((item) => item.note !== undefined && matchesNote(focus, item.note));
  if (mine.length === 0) return [];
  return [header("staged"), ...sortedInbox(mine).map((item) => inboxRow(item, now))];
}

function linkRow(note: MemoryNoteView, id: string, indent: number, now: number): MemoryRow {
  return { ...noteRow(note, id, indent, now), kind: "link" };
}

function deadLinkRow(id: string, link: string, indent: number): MemoryRow {
  return {
    id,
    kind: "link",
    text: `${"  ".repeat(indent)}? ${link}`,
    tone: "dim",
    selectable: false,
  };
}

function queryLineRow(query: MemoryQueryState): MemoryRow {
  const prompt = `? ${query.text}▌`;
  const disclosure = queryDisclosure(query);
  return {
    id: "query",
    kind: "query",
    text: `${prompt}${disclosure}`,
    tone: "normal",
    selectable: false,
    spans: [
      { text: prompt, ink: "accent" },
      { text: disclosure, ink: "dim" },
    ],
  };
}

function queryDisclosure(query: MemoryQueryState): string {
  if (query.text === "") return "";
  if (query.pending || query.outcome === undefined) return " · asking…";
  const { source, embeddings } = query.outcome;
  if (source === "lexical") return " · lexical";
  if (source === "hybrid") return ` · hybrid · ${embeddings ?? "embeddings"}`;
  return ` · lexical · ${embeddings ?? "embeddings"} down`;
}

function hitRows(
  inputs: MemoryPaneInputs,
  hit: MemoryQueryHit,
  at: number,
  now: number,
): MemoryRow[] {
  const note = findNote(inputs.notes, hit.note, hit.layer);
  const layer = inputs.layers.find((candidate) => candidate.id === hit.layer);
  const title = note === undefined ? vanishedHitRow(hit, at) : hitTitleRow(note, layer, at, now);
  return [title, whyRow(hit, layer, at)];
}

function hitTitleRow(
  note: MemoryNoteView,
  layer: MemoryLayerView | undefined,
  at: number,
  now: number,
): MemoryRow {
  const row = noteRow(note, `hit:${at}:${note.name}`, 0, now);
  if (layer?.arc === undefined) return { ...row, kind: "hit" };
  const tag = ` ${arcTag(layer.arc)}`;
  const lead = row.spans?.[0] ?? { text: "", ink: "text" };
  const titleSpan = row.spans?.[1] ?? { text: note.title, ink: "text" };
  const tail = row.spans?.[2] ?? { text: "", ink: "dim" };
  return {
    ...row,
    kind: "hit",
    text: `${lead.text}${titleSpan.text}${tag}${tail.text}`,
    arc: layer.arc,
    spans: [lead, titleSpan, { text: tag, ink: "arc" }, tail],
  };
}

function vanishedHitRow(hit: MemoryQueryHit, at: number): MemoryRow {
  return {
    id: `hit:${at}:${hit.note}`,
    kind: "hit",
    text: `░ ${hit.note}`,
    tone: "dim",
    selectable: false,
  };
}

function whyRow(hit: MemoryQueryHit, layer: MemoryLayerView | undefined, at: number): MemoryRow {
  const legs = (["lexical", "semantic", "graph"] as const).flatMap((leg) => {
    const rank = hit.ranks[leg];
    return rank === undefined ? [] : [`${leg} #${rank}`];
  });
  const boost =
    hit.boost === undefined || hit.boost === 1
      ? []
      : [`${layer?.arc === undefined ? "layer" : arcTag(layer.arc)} ×${hit.boost}`];
  const floor = hit.superseded ? ["superseded"] : [];
  const why = [...legs, ...boost, ...floor].join(" · ");
  return {
    id: `why:${at}:${hit.note}`,
    kind: "why",
    text: `${whyIndent}${why}`,
    tone: "dim",
    selectable: false,
  };
}

function ledgerRow(event: LedgerEventView, at: number, now: number): MemoryRow {
  const age = ageOf(now, event.at);
  const verb = ` · ${event.verb} · `;
  return {
    id: `ledger:${at}:${event.at}:${event.verb}`,
    kind: "ledger",
    text: `${age}${verb}${event.subject}`,
    tone: "normal",
    selectable: true,
    ...(event.id !== undefined && { ledgerId: event.id }),
    ...(event.notes[0] !== undefined && { note: event.notes[0] }),
    spans: [
      { text: age, ink: "dim" },
      { text: verb, ink: "mid" },
      { text: event.subject, ink: "text" },
    ],
  };
}

function header(text: string): MemoryRow {
  return { id: `header:${text}`, kind: "header", text, tone: "heading", selectable: false };
}

function sectionRow(id: string, text: string): MemoryRow {
  return { id: `section:${id}`, kind: "section", text, tone: "dim", selectable: false };
}

function emptyRow(id: string, text: string): MemoryRow {
  return { id, kind: "empty", text, tone: "dim", selectable: false };
}

function blankRow(id: string): MemoryRow {
  return { id: `blank:${id}`, kind: "empty", text: "", tone: "dim", selectable: false };
}

function ageOf(now: number, iso: string): string {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? "?" : relativeAge(now, then);
}

function matchesNote(note: MemoryNoteView, reference: string): boolean {
  const key = reference.trim().toLowerCase();
  if (key === "") return false;
  return (
    note.name.toLowerCase() === key ||
    note.title.toLowerCase() === key ||
    note.aliases.some((alias) => alias.toLowerCase() === key)
  );
}
