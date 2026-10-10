import { textMessage } from "../messages.ts";
import type { Provider } from "../provider.ts";
import { canonicalEntityPath, titleKey } from "./naming.ts";
import { type DriftVerdict, isDriftVerdict, isEntityPath, type Note, noteName } from "./notes.ts";
import type { ReviewProposal, StagedReview } from "./staging.ts";
import type { MemoryStore } from "./store.ts";

export interface DiffChanges {
  against: string;
  files: readonly string[];
  patch: string;
}

export interface DriftEvidence {
  note: Note;
  reasons: string[];
  lines: string[];
}

export interface DriftAssessment {
  verdict: DriftVerdict;
  reason: string;
}

export interface DriftJudgmentPort {
  readonly id: string;
  assess(note: Note, evidence: readonly string[]): Promise<DriftAssessment>;
}

export interface DriftFinding extends DriftAssessment {
  note: string;
  evidence: string[];
}

export interface DriftReport {
  against: string;
  findings: DriftFinding[];
  untouched: number;
  proposed: string[];
}

export interface DriftCheckOptions {
  store: MemoryStore;
  judgment: DriftJudgmentPort;
  changes: DiffChanges;
  inbox?: Pick<MemoryStore, "propose">;
  now?: () => Date;
}

export async function checkDrift(options: DriftCheckOptions): Promise<DriftReport> {
  const { store, judgment, changes } = options;
  const now = options.now ?? (() => new Date());
  const notes = await store.listNotes();
  const touched = touchedNotes(notes, changes);
  const findings: DriftFinding[] = [];
  for (const evidence of touched) {
    const lines = [...evidence.reasons, ...evidence.lines];
    const assessment = await judgment.assess(evidence.note, lines);
    const finding = { note: evidence.note.name, evidence: lines, ...assessment };
    await stampVerdict(store, finding, changes.against, now().toISOString());
    findings.push(finding);
  }
  const proposed = await proposeStale(options.inbox ?? store, findings, changes.against);
  return {
    against: changes.against,
    findings,
    untouched: notes.length - touched.length,
    proposed: proposed.map((review) => review.key),
  };
}

export function touchedNotes(notes: readonly Note[], changes: DiffChanges): DriftEvidence[] {
  const hunks = parsePatch(changes.patch);
  const files = [...new Set([...changes.files, ...hunks.keys()])];
  const symbols = changedSymbols(hunks);
  const evidence: DriftEvidence[] = [];
  for (const note of notes) {
    const reasons = touchReasons(note, files, symbols);
    if (reasons.length === 0) continue;
    evidence.push({
      note,
      reasons: reasons.map((reason) => reason.text),
      lines: evidenceLines(hunks, reasons),
    });
  }
  return evidence;
}

export function driftJudgment(provider: Provider): DriftJudgmentPort {
  return {
    id: `drift:${provider.name}`,
    assess: async (note, evidence) => {
      try {
        const reply = await complete(provider, driftInstruction, describeCase(note, evidence));
        return parseAssessment(reply);
      } catch (cause) {
        return { verdict: "unsure", reason: reasonOf(cause) };
      }
    },
  };
}

export function driftAuditEvent(finding: DriftFinding, against: string): string {
  const evidence = finding.evidence.map(oneLine).join(" | ");
  return `drift [[${finding.note}]]: ${finding.verdict} against ${against} · ${oneLine(finding.reason)} · ${evidence}`;
}

interface Hunk {
  header: string;
  lines: string[];
}

interface TouchReason {
  kind: "entity" | "link" | "path" | "symbol";
  file?: string;
  symbol?: string;
  text: string;
}

const driftInstruction =
  "You audit one memory note against a code diff. Decide whether the note still holds. " +
  'Reply with only a JSON object shaped {"verdict": "hold" | "stale" | "unsure", ' +
  '"reason": string}. "stale" means the diff contradicts or retires what the note claims; ' +
  '"hold" means the note is still true; "unsure" when the evidence does not settle it.';

const evidenceLineCap = 12;
const evidenceCharCap = 6000;
const minimumSymbolLength = 4;
const declarationPattern =
  /\b(?:function|class|interface|type|enum|const|let|var|def|fn|func|struct|impl|trait)\s+([A-Za-z_$][\w$]*)/g;
const signaturePattern =
  /^(?:[+-]|@@.*@@)?\s*(?:(?:export|default|public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*[(<]/;
const reservedWords = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "await",
  "function",
  "constructor",
  "super",
  "this",
  "new",
  "typeof",
  "else",
]);

async function stampVerdict(
  store: MemoryStore,
  finding: DriftFinding,
  against: string,
  at: string,
): Promise<void> {
  await store.annotateNote(finding.note, { drift: { verdict: finding.verdict, at, against } });
  await store.recordAudit(driftAuditEvent(finding, against));
}

async function proposeStale(
  inbox: Pick<MemoryStore, "propose">,
  findings: readonly DriftFinding[],
  against: string,
): Promise<StagedReview[]> {
  const proposals: ReviewProposal[] = findings
    .filter((finding) => finding.verdict === "stale")
    .map((finding) => ({
      kind: "drift-review",
      note: finding.note,
      against,
      reason: finding.reason,
      evidence: finding.evidence,
    }));
  return proposals.length === 0 ? [] : inbox.propose(proposals);
}

function touchReasons(
  note: Note,
  files: readonly string[],
  symbols: ReadonlyMap<string, string>,
): TouchReason[] {
  const reasons: TouchReason[] = [];
  const linkKeys = new Set(note.links.map(linkKey));
  for (const file of files) {
    const key = entityKey(file);
    if (isEntityPath(note.path) && titleKey(noteName(note.path)) === key)
      reasons.push({ kind: "entity", file, text: `is the entity note for ${file}` });
    else if (linkKeys.has(key)) reasons.push({ kind: "link", file, text: `links to ${file}` });
    else if (mentionsPath(note.body, file))
      reasons.push({ kind: "path", file, text: `cites ${file}` });
  }
  for (const [symbol, file] of symbols) {
    if (wordPattern(symbol).test(note.body))
      reasons.push({ kind: "symbol", file, symbol, text: `mentions ${symbol} (${file})` });
  }
  return reasons;
}

function evidenceLines(
  hunks: ReadonlyMap<string, Hunk[]>,
  reasons: readonly TouchReason[],
): string[] {
  const lines: string[] = [];
  for (const reason of reasons) {
    const fileHunks = reason.file === undefined ? [] : (hunks.get(reason.file) ?? []);
    for (const hunk of fileHunks) {
      const relevant =
        reason.symbol === undefined
          ? hunk.lines
          : hunk.lines.filter((line) => wordPattern(reason.symbol ?? "").test(line));
      for (const line of [hunk.header, ...relevant]) {
        if (lines.length >= evidenceLineCap) return lines;
        if (!lines.includes(line)) lines.push(line);
      }
    }
  }
  return lines;
}

function parsePatch(patch: string): Map<string, Hunk[]> {
  const byFile = new Map<string, Hunk[]>();
  let file: string | undefined;
  let hunk: Hunk | undefined;
  for (const line of patch.split("\n")) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header !== null) {
      file = header[2];
      hunk = undefined;
      continue;
    }
    if (file === undefined) continue;
    if (line.startsWith("@@")) {
      hunk = { header: `${file}: ${line}`, lines: [] };
      byFile.set(file, [...(byFile.get(file) ?? []), hunk]);
      continue;
    }
    if (hunk !== undefined && /^[+-](?![+-]{2})/.test(line)) hunk.lines.push(line);
  }
  return byFile;
}

function changedSymbols(hunks: ReadonlyMap<string, Hunk[]>): Map<string, string> {
  const symbols = new Map<string, string>();
  for (const [file, fileHunks] of hunks) {
    for (const hunk of fileHunks) {
      for (const text of [hunk.header, ...hunk.lines]) {
        for (const symbol of declaredSymbols(text)) {
          if (symbol.length >= minimumSymbolLength && !symbols.has(symbol))
            symbols.set(symbol, file);
        }
      }
    }
  }
  return symbols;
}

function declaredSymbols(text: string): string[] {
  const declared = [...text.matchAll(declarationPattern)].map((match) => match[1] ?? "");
  const signature = text.match(signaturePattern)?.[1];
  return [...declared, ...(signature === undefined ? [] : [signature])].filter(
    (symbol) => symbol !== "" && !reservedWords.has(symbol),
  );
}

function mentionsPath(body: string, file: string): boolean {
  if (body.includes(file)) return true;
  const base = file.slice(file.lastIndexOf("/") + 1);
  return base.includes(".") && base.length >= minimumSymbolLength && wordPattern(base).test(body);
}

function entityKey(file: string): string {
  return titleKey(`entities/${canonicalEntityPath(file)}`);
}

function linkKey(link: string): string {
  return titleKey(link.startsWith("entities/") ? entityKeyName(link) : link);
}

function entityKeyName(link: string): string {
  return `entities/${canonicalEntityPath(link.slice("entities/".length))}`;
}

function wordPattern(word: string): RegExp {
  return new RegExp(`(?<![\\w$])${escapeRegExp(word)}(?![\\w$])`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describeCase(note: Note, evidence: readonly string[]): string {
  const diff = evidence.join("\n").slice(0, evidenceCharCap);
  return [`note: ${note.title}`, note.body.trimEnd(), "", "diff evidence:", diff].join("\n");
}

async function complete(provider: Provider, instruction: string, input: string): Promise<string> {
  let text = "";
  const request = { systemPrompt: instruction, messages: [textMessage("user", input)], tools: [] };
  for await (const delta of provider.stream(request)) {
    if (delta.type === "text") text += delta.text;
  }
  return text;
}

function parseAssessment(reply: string): DriftAssessment {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return { verdict: "unsure", reason: "unparseable reply" };
  try {
    const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    const { verdict, reason } = parsed as Record<string, unknown>;
    if (!isDriftVerdict(verdict)) return { verdict: "unsure", reason: "no verdict in reply" };
    return { verdict, reason: typeof reason === "string" ? reason : "" };
  } catch {
    return { verdict: "unsure", reason: "unparseable reply" };
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
