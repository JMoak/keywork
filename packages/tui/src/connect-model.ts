import { isLoopbackEndpoint } from "@keywork/engine";
import { connectionProtocols, toError } from "@keywork/shared";
import type {
  ConnectionDraft,
  ConnectionsPort,
  ConnectionTarget,
  CredentialChoice,
  RemovalReceipt,
  SavedConnection,
} from "./inference-port.ts";
import { InputBuffer } from "./input-buffer.ts";
import type { Chord } from "./keys.ts";
import { isEnter } from "./overlays/overlay.ts";
import { isPrintable } from "./picker-keys.ts";
import { pluralize } from "./pluralize.ts";
import { padEnd, width } from "./width.ts";

export type ListStage = { kind: "connections"; index: number } | { kind: "targets"; index: number };

export type ConnectStage =
  | ListStage
  | EditorStage
  | { kind: "verifying"; editor: EditorStage; draft: ConnectionDraft }
  | { kind: "failed"; editor: EditorStage; draft: ConnectionDraft; reason: string; at: string }
  | { kind: "receipt"; draft: ConnectionDraft; models: readonly string[]; at: string }
  | { kind: "remove-confirm"; editor: EditorStage; name: string; credential: string }
  | { kind: "removed"; receipt: RemovalReceipt };

export interface EditorStage {
  kind: "editor";
  draft: ConnectionDraft;
  field: number;
  fixed: FixedFields;
  existing: boolean;
  origin: ConnectionTarget | SavedConnection;
  back: ListStage;
  buffers: Readonly<Record<TextFieldId, InputBuffer>>;
}

export interface FixedFields {
  name: boolean;
  endpoint: boolean;
}

export type TextFieldId = "name" | "endpoint" | "apiKey" | "envVariable";
export type ToggleFieldId = "protocol" | "credential" | "insecureTransport";

export type EditorField =
  | { id: TextFieldId; label: string; value: string; kind: "text" | "secret"; cursor: number }
  | { id: ToggleFieldId; label: string; value: string; kind: "toggle" }
  | { id: "verify"; label: string; value: string; kind: "action" }
  | { id: "remove"; label: string; value: string; kind: "danger" };

export interface TargetRow {
  label: string;
  detail: string;
  pick: ConnectionTarget;
}

export interface ConnectionRow {
  connection: SavedConnection;
  host: string;
  facts: readonly string[];
}

export type ConnectTone = "text" | "dim" | "accent" | "danger";

export interface ConnectSpan {
  text: string;
  tone: ConnectTone;
}

export interface ConnectRow {
  spans: readonly ConnectSpan[];
  selected: boolean;
}

export interface ConnectHooks {
  notify(): void;
  chooseModel(): void;
  notice(text: string): void;
  currentProvider?(): string | undefined;
}

export type ConnectKeyOutcome = "stay" | "close";

export const addProviderRow = "+ add a provider";

export class ConnectModel {
  stage: ConnectStage = { kind: "connections", index: 0 };

  constructor(
    private readonly port: ConnectionsPort,
    private readonly hooks: ConnectHooks,
  ) {}

  open(argument: string | undefined): void {
    const trimmed = argument?.trim() ?? "";
    if (trimmed === "") {
      this.stage = this.rootStage();
      return;
    }
    const saved = this.port.saved().find((row) => row.name === trimmed);
    if (saved !== undefined) {
      this.editSaved(saved);
      return;
    }
    const target = this.port.targets().find((candidate) => candidate.id === trimmed);
    if (target !== undefined) {
      this.editTarget(target);
      return;
    }
    if (/^https?:\/\//.test(trimmed)) {
      const custom = this.port.targets().find((candidate) => candidate.kind === "custom");
      if (custom !== undefined) {
        this.editTarget({ ...custom, endpoint: trimmed.replace(/\/+$/, "") });
        return;
      }
    }
    this.hooks.notice(`/connect: "${trimmed}" is not a saved connection, a target, or a URL`);
    this.stage = this.rootStage();
  }

  connectionRows(): ConnectionRow[] {
    const current = this.hooks.currentProvider?.();
    return this.port.saved().map((connection) => ({
      connection,
      host: hostOf(connection.endpoint),
      facts: connectionFacts(connection, connection.name === current),
    }));
  }

  targetRows(): TargetRow[] {
    return this.port.targets().map((target) => ({
      label: target.label,
      detail: targetDetail(target),
      pick: target,
    }));
  }

  fields(): EditorField[] {
    return this.stage.kind === "editor" ? editorFields(this.stage) : [];
  }

  rows(): ConnectRow[] {
    const { stage } = this;
    switch (stage.kind) {
      case "connections":
        return connectionListRows(this.connectionRows(), stage.index);
      case "targets":
        return this.targetRows().map((row, index) => ({
          selected: index === stage.index,
          spans: [lead(index === stage.index), span(row.label), dim(` · ${row.detail}`)],
        }));
      case "editor":
        return editorRows(stage);
      case "verifying":
        return [plain(` verifying ${stage.draft.endpoint}/models …`)];
      case "failed":
        return [
          row([span(` not saved · ${stage.reason}`, "accent")]),
          row([dim(` observed ${stage.at} · any key returns to the editor`)]),
        ];
      case "receipt":
        return [
          plain(` saved ${stage.draft.name} · ${stage.draft.endpoint}`),
          row([dim(` verified ${stage.at} · ${modelsFact(stage.models)}`)]),
          row([span(" enter picks a model · esc back to connections", "accent")]),
        ];
      case "remove-confirm":
        return [
          plain(` remove connection ${stage.name} and its ${stage.credential}?`),
          row([span(" y remove · n keep", "accent")]),
        ];
      case "removed":
        return [
          plain(` removed ${stage.receipt.removed.join(", ") || "nothing"}`),
          ...stage.receipt.retained.map((fact) => row([dim(` kept ${fact}`)])),
          row([span(" any key continues", "accent")]),
        ];
    }
  }

  rowCount(): number {
    return this.rows().length;
  }

  clickRow(index: number): ConnectKeyOutcome {
    const { stage } = this;
    switch (stage.kind) {
      case "connections":
        return this.pickConnection(index);
      case "targets": {
        const picked = this.targetRows()[index];
        if (picked !== undefined) this.editTarget(picked.pick, { kind: "targets", index });
        return "stay";
      }
      case "editor": {
        const field = index - editorHeaderRows(stage);
        if (field >= 0 && field < editorFields(stage).length) this.stage = { ...stage, field };
        return "stay";
      }
      case "failed":
        this.stage = stage.editor;
        return "stay";
      case "removed":
        return this.afterRemoval();
      default:
        return "stay";
    }
  }

  paste(text: string): void {
    if (this.stage.kind !== "editor") return;
    const field = editorFields(this.stage)[this.stage.field];
    if (field === undefined || (field.kind !== "text" && field.kind !== "secret")) return;
    this.stage.buffers[field.id].insert(text);
    this.syncText(this.stage, field.id);
  }

  handleKey(chord: Chord, sequence: string | undefined): ConnectKeyOutcome {
    const { stage } = this;
    switch (stage.kind) {
      case "connections":
        return this.handleConnectionsKey(stage.index, chord);
      case "targets":
        return this.handleTargetsKey(stage.index, chord);
      case "editor":
        return this.handleEditorKey(stage, chord, sequence);
      case "verifying":
        if (chord.name === "escape") {
          this.stage = stage.editor;
          this.hooks.notice("verify cancelled · nothing saved");
        }
        return "stay";
      case "failed":
        this.stage = stage.editor;
        return "stay";
      case "receipt":
        if (isEnter(chord)) {
          this.hooks.chooseModel();
          return "close";
        }
        if (chord.name === "escape") this.stage = this.rootStage();
        return "stay";
      case "remove-confirm":
        return this.handleRemoveConfirmKey(stage, chord);
      case "removed":
        return this.afterRemoval();
    }
  }

  private rootStage(): ListStage {
    return this.port.saved().length === 0
      ? { kind: "targets", index: 0 }
      : { kind: "connections", index: 0 };
  }

  private handleConnectionsKey(index: number, chord: Chord): ConnectKeyOutcome {
    if (chord.name === "escape") return "close";
    const count = this.port.saved().length + 1;
    if (chord.name === "up" || chord.name === "down") {
      const step = chord.name === "down" ? 1 : -1;
      this.stage = { kind: "connections", index: (index + step + count) % count };
      return "stay";
    }
    if (isEnter(chord)) return this.pickConnection(index);
    return "stay";
  }

  private pickConnection(index: number): ConnectKeyOutcome {
    const saved = this.port.saved();
    const picked = saved[index];
    if (picked !== undefined) this.editSaved(picked, { kind: "connections", index });
    else if (index === saved.length) this.stage = { kind: "targets", index: 0 };
    return "stay";
  }

  private handleTargetsKey(index: number, chord: Chord): ConnectKeyOutcome {
    if (chord.name === "escape") {
      if (this.port.saved().length === 0) return "close";
      this.stage = { kind: "connections", index: this.port.saved().length };
      return "stay";
    }
    const rows = this.targetRows();
    if (chord.name === "up" || chord.name === "down") {
      const count = Math.max(1, rows.length);
      const step = chord.name === "down" ? 1 : -1;
      this.stage = { kind: "targets", index: (index + step + count) % count };
      return "stay";
    }
    if (isEnter(chord)) {
      const row = rows[index];
      if (row !== undefined) this.editTarget(row.pick, { kind: "targets", index });
    }
    return "stay";
  }

  private handleEditorKey(
    stage: EditorStage,
    chord: Chord,
    sequence: string | undefined,
  ): ConnectKeyOutcome {
    if (chord.name === "escape") {
      this.stage = stage.back;
      return "stay";
    }
    const fields = editorFields(stage);
    const count = Math.max(1, fields.length);
    if (chord.name === "up" || chord.name === "down") {
      const step = chord.name === "down" ? 1 : -1;
      this.stage = { ...stage, field: (stage.field + step + count) % count };
      return "stay";
    }
    if (chord.name === "tab") {
      this.stage = { ...stage, field: (stage.field + 1) % count };
      return "stay";
    }
    const field = fields[stage.field];
    if (field === undefined) return "stay";
    if (isEnter(chord)) {
      if (field.kind === "danger") this.confirmRemoval(stage);
      else if (field.kind === "toggle") this.cycle(stage, field.id, 1);
      else void this.verifyAndSave(stage);
      return "stay";
    }
    if (field.kind === "toggle") {
      if (chord.name === "left" || chord.name === "right" || sequence === " ") {
        this.cycle(stage, field.id, chord.name === "left" ? -1 : 1);
      }
      return "stay";
    }
    if (field.kind === "text" || field.kind === "secret")
      this.editText(stage, field.id, chord, sequence);
    return "stay";
  }

  private handleRemoveConfirmKey(
    stage: Extract<ConnectStage, { kind: "remove-confirm" }>,
    chord: Chord,
  ): ConnectKeyOutcome {
    if (chord.name === "y" || isEnter(chord)) {
      void this.port
        .remove(stage.name)
        .then((receipt) => {
          this.stage = { kind: "removed", receipt };
          this.hooks.notice(`removed ${receipt.removed.join(" and ")}`);
        })
        .catch((cause: unknown) => this.hooks.notice(toError(cause).message))
        .finally(() => this.hooks.notify());
      return "stay";
    }
    if (chord.name === "n" || chord.name === "escape") this.stage = stage.editor;
    return "stay";
  }

  private afterRemoval(): ConnectKeyOutcome {
    if (this.port.saved().length === 0) return "close";
    this.stage = { kind: "connections", index: 0 };
    return "stay";
  }

  private editSaved(saved: SavedConnection, back?: ListStage): void {
    const draft = this.port.draftFor(saved);
    const stage = back ?? this.backTo(saved);
    this.stage = editorStage(draft, this.fixedFor(draft), true, saved, stage);
  }

  private editTarget(target: ConnectionTarget, back?: ListStage): void {
    const draft = this.port.draftFor(target);
    const fixed = { name: !target.nameEditable, endpoint: !target.endpointEditable };
    this.stage = editorStage(draft, fixed, false, target, back ?? this.backTo(target));
  }

  private backTo(pick: ConnectionTarget | SavedConnection): ListStage {
    if ("kind" in pick) {
      const index = this.port.targets().findIndex((target) => target.id === pick.id);
      return { kind: "targets", index: Math.max(0, index) };
    }
    const index = this.port.saved().findIndex((row) => row.name === pick.name);
    return { kind: "connections", index: Math.max(0, index) };
  }

  private fixedFor(draft: ConnectionDraft): FixedFields {
    const builtIn = this.port
      .targets()
      .some((candidate) => candidate.kind === "built-in" && candidate.name === draft.name);
    return { name: builtIn, endpoint: builtIn };
  }

  private confirmRemoval(stage: EditorStage): void {
    const saved = this.port.saved().find((row) => row.name === stage.draft.name);
    this.stage = {
      kind: "remove-confirm",
      editor: stage,
      name: stage.draft.name,
      credential: saved?.credential ?? "no credential",
    };
  }

  private cycle(stage: EditorStage, id: ToggleFieldId, step: number): void {
    const { draft } = stage;
    switch (id) {
      case "protocol":
        this.stage = {
          ...stage,
          draft: { ...draft, protocol: cycled(connectionProtocols, draft.protocol, step) },
        };
        return;
      case "credential": {
        const order: readonly CredentialChoice[] = [
          "none",
          "api-key",
          `env:${stage.buffers.envVariable.value}`,
        ];
        const at = order.findIndex(
          (choice) => credentialKind(choice) === credentialKind(draft.credential),
        );
        const next = order[(at + step + order.length) % order.length] ?? draft.credential;
        this.stage = { ...stage, draft: { ...draft, credential: next } };
        return;
      }
      case "insecureTransport":
        this.stage = {
          ...stage,
          draft: { ...draft, insecureTransport: !draft.insecureTransport },
        };
        return;
    }
  }

  private editText(
    stage: EditorStage,
    id: TextFieldId,
    chord: Chord,
    sequence: string | undefined,
  ): void {
    const buffer = stage.buffers[id];
    if (chord.name === "left") buffer.left();
    else if (chord.name === "right") buffer.right();
    else if (chord.name === "home") buffer.home();
    else if (chord.name === "end") buffer.end();
    else if (chord.name === "backspace") this.edited(stage, id, () => buffer.backspace());
    else if (isPrintable(chord, sequence)) this.edited(stage, id, () => buffer.insert(sequence));
  }

  private edited(stage: EditorStage, id: TextFieldId, change: () => void): void {
    change();
    this.syncText(stage, id);
  }

  private syncText(stage: EditorStage, id: TextFieldId): void {
    const value = stage.buffers[id].value;
    const draft: ConnectionDraft =
      id === "envVariable"
        ? { ...stage.draft, credential: `env:${value}` }
        : { ...stage.draft, [id]: value };
    this.stage = { ...stage, draft };
  }

  private async verifyAndSave(stage: EditorStage): Promise<void> {
    const problem = draftProblem(stage.draft);
    if (problem !== undefined) {
      this.hooks.notice(problem);
      return;
    }
    const draft = trimmedDraft(stage.draft);
    const verifying: ConnectStage = { kind: "verifying", editor: stage, draft };
    const abandoned = (): boolean => this.stage !== verifying;
    this.stage = verifying;
    this.hooks.notify();
    try {
      const verification = await this.port.verify(draft);
      if (abandoned()) return;
      if (!verification.ok) {
        this.stage = {
          kind: "failed",
          editor: stage,
          draft,
          reason: verification.reason,
          at: verification.at,
        };
        return;
      }
      await this.port.save(draft, verification);
      if (abandoned()) {
        this.hooks.notice(`saved ${draft.name} before the cancel landed`);
        return;
      }
      this.stage = { kind: "receipt", draft, models: verification.models, at: verification.at };
    } catch (cause) {
      if (!abandoned()) this.stage = stage;
      this.hooks.notice(toError(cause).message);
    } finally {
      this.hooks.notify();
    }
  }
}

function editorStage(
  draft: ConnectionDraft,
  fixed: FixedFields,
  existing: boolean,
  origin: ConnectionTarget | SavedConnection,
  back: ListStage,
): EditorStage {
  return {
    kind: "editor",
    draft,
    field: 0,
    fixed,
    existing,
    origin,
    back,
    buffers: buffersFor(draft),
  };
}

function buffersFor(draft: ConnectionDraft): Record<TextFieldId, InputBuffer> {
  return {
    name: loaded(draft.name),
    endpoint: loaded(draft.endpoint),
    apiKey: loaded(draft.apiKey),
    envVariable: loaded(envVariableOf(draft.credential)),
  };
}

function loaded(text: string): InputBuffer {
  const buffer = new InputBuffer();
  buffer.load(text);
  return buffer;
}

function editorFields(stage: EditorStage): EditorField[] {
  const { draft, fixed, existing, buffers } = stage;
  const text = (id: TextFieldId, label: string, kind: "text" | "secret"): EditorField => ({
    id,
    label,
    value: buffers[id].value,
    kind,
    cursor: buffers[id].cursorAt().column,
  });
  return [
    ...(fixed.name ? [] : [text("name", "name", "text")]),
    ...(fixed.endpoint ? [] : [text("endpoint", "endpoint", "text")]),
    { id: "protocol", label: "protocol", value: draft.protocol, kind: "toggle" },
    {
      id: "credential",
      label: "credential",
      value: credentialLabel(draft.credential),
      kind: "toggle",
    },
    ...(draft.credential === "api-key" ? [text("apiKey", "api key", "secret")] : []),
    ...(draft.credential.startsWith("env:") ? [text("envVariable", "env variable", "text")] : []),
    ...(needsInsecureChoice(draft.endpoint)
      ? [
          {
            id: "insecureTransport" as const,
            label: "plain http",
            value: draft.insecureTransport
              ? "allowed off loopback (credentials and prompts travel unencrypted)"
              : "refused off loopback",
            kind: "toggle" as const,
          },
        ]
      : []),
    { id: "verify", label: "verify", value: verifyActionText(draft), kind: "action" },
    ...(existing
      ? [
          {
            id: "remove" as const,
            label: "remove",
            value: `forget ${draft.name} and its saved key`,
            kind: "danger" as const,
          },
        ]
      : []),
  ];
}

export const editorHint = "↑↓ move · ←→ toggle · enter verifies and saves · esc back";

function editorRows(stage: EditorStage): ConnectRow[] {
  const fields = editorFields(stage);
  return [
    ...editorHeader(stage),
    ...fields.map((field, index) => editorFieldRow(field, index === stage.field)),
    row([dim(` ${editorHint}`)]),
  ];
}

export function editorHeaderRows(stage: EditorStage): number {
  return editorHeader(stage).length;
}

function editorHeader(stage: EditorStage): ConnectRow[] {
  const { title, note } = editorHeading(stage);
  return [
    row([span(` ${title.name}`), dim(` · ${title.detail}`)]),
    ...(note === undefined ? [] : [row([dim(` ${note}`)])]),
  ];
}

export interface EditorHeading {
  title: { name: string; detail: string };
  note: string | undefined;
}

export function editorHeading(stage: EditorStage): EditorHeading {
  const { origin } = stage;
  if (!("kind" in origin)) {
    return {
      title: { name: origin.name, detail: origin.endpoint },
      note: observationLine(origin),
    };
  }
  switch (origin.kind) {
    case "built-in":
      return {
        title: { name: origin.label, detail: origin.endpoint },
        note: origin.keyUrl === undefined ? undefined : `get a key: ${origin.keyUrl}`,
      };
    case "local":
      return { title: { name: origin.label, detail: "runs on this machine" }, note: undefined };
    case "custom":
      return {
        title: { name: "new connection", detail: "any OpenAI-compatible endpoint" },
        note: "keywork verifies it with GET /models before anything is saved",
      };
  }
}

function editorFieldRow(field: EditorField, selected: boolean): ConnectRow {
  const tone: ConnectTone = field.kind === "danger" ? "danger" : "text";
  return {
    selected,
    spans: [
      lead(selected),
      span(padEnd(field.label, 12), tone),
      span(` ${editorFieldText(field, selected)}`, tone),
    ],
  };
}

export function editorFieldText(field: EditorField, selected: boolean): string {
  switch (field.kind) {
    case "toggle":
      return `‹ ${field.value} ›`;
    case "action":
    case "danger":
      return field.value;
    case "secret":
      if (field.value === "") return `(saved or none)${selected ? "▌" : ""}`;
      return withCaret("•".repeat(field.value.length), field.cursor, selected);
    case "text":
      return withCaret(field.value, field.cursor, selected);
  }
}

function withCaret(text: string, cursor: number, selected: boolean): string {
  return selected ? `${text.slice(0, cursor)}▌${text.slice(cursor)}` : text;
}

export const connectionColumnCaps = { name: 16, host: 30 } as const;

export interface ConnectionColumns {
  name: number;
  host: number;
}

export function connectionColumns(rows: readonly ConnectionRow[]): ConnectionColumns {
  const widest = (pick: (row: ConnectionRow) => string, cap: number): number =>
    Math.min(cap, Math.max(0, ...rows.map((row) => width(pick(row)))));
  return {
    name: widest((row) => row.connection.name, connectionColumnCaps.name),
    host: widest((row) => row.host, connectionColumnCaps.host),
  };
}

export function connectionLine(row: ConnectionRow, columns: ConnectionColumns): string {
  return connectionSpans(row, columns)
    .map((part) => part.text)
    .join("");
}

function connectionListRows(rows: readonly ConnectionRow[], index: number): ConnectRow[] {
  const columns = connectionColumns(rows);
  return [
    ...rows.map((entry, at) => ({
      selected: at === index,
      spans: [lead(at === index), ...connectionSpans(entry, columns)],
    })),
    { selected: index === rows.length, spans: [lead(index === rows.length), span(addProviderRow)] },
  ];
}

function connectionSpans(row: ConnectionRow, columns: ConnectionColumns): ConnectSpan[] {
  const tone: ConnectTone = row.connection.enabled ? "text" : "dim";
  return [
    span(padEnd(row.connection.name, columns.name), tone),
    span(` ${padEnd(row.host, columns.host)}`, "dim"),
    span(` ${row.facts.join(" · ")}`, row.connection.lastFailure === undefined ? "dim" : "danger"),
  ];
}

export function connectionFacts(connection: SavedConnection, inUse: boolean): string[] {
  return [
    ...(inUse ? ["in use"] : []),
    ...(connection.enabled ? [] : ["disabled"]),
    connection.credential,
    ...(connection.protocol === "chat-completions" ? [] : [connection.protocol]),
    ...(connection.modelCount === undefined ? [] : [pluralize(connection.modelCount, "model")]),
    ...(connection.lastFailure === undefined
      ? connection.verifiedAt === undefined
        ? ["never verified"]
        : [`verified ${clock(connection.verifiedAt)}`]
      : [`failed ${clock(connection.lastFailure.at)} · ${connection.lastFailure.reason}`]),
  ];
}

function cycled<T>(order: readonly T[], current: T, step: number): T {
  const at = order.indexOf(current);
  return order[(at + step + order.length) % order.length] ?? current;
}

function observationLine(connection: SavedConnection): string {
  const facts = connectionFacts(connection, false).filter((fact) => fact !== connection.credential);
  return facts.length === 0 ? "never verified" : facts.join(" · ");
}

export function hostOf(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function clock(at: string): string {
  return at.slice(5, 16).replace("T", " ");
}

function targetDetail(target: ConnectionTarget): string {
  switch (target.kind) {
    case "built-in":
      return `api key · ${hostOf(target.endpoint)}`;
    case "local":
      return `local · ${target.endpoint}`;
    case "custom":
      return "any OpenAI-compatible URL";
  }
}

function trimmedDraft(draft: ConnectionDraft): ConnectionDraft {
  return { ...draft, name: draft.name.trim(), endpoint: draft.endpoint.trim().replace(/\/+$/, "") };
}

function credentialLabel(choice: CredentialChoice): string {
  if (choice === "none") return "none";
  if (choice === "api-key") return "api key (saved under this name)";
  return "environment variable";
}

function credentialKind(choice: CredentialChoice): string {
  return choice.startsWith("env:") ? "env" : choice;
}

function envVariableOf(choice: CredentialChoice): string {
  return choice.startsWith("env:") ? choice.slice("env:".length) : "";
}

function needsInsecureChoice(endpoint: string): boolean {
  return endpoint.startsWith("http://") && !isLoopbackEndpoint(endpoint);
}

export function verifyActionText(draft: ConnectionDraft): string {
  const endpoint = draft.endpoint.trim().replace(/\/+$/, "") || "<endpoint>";
  const name = draft.name.trim() || "<name>";
  return `GET ${endpoint}/models with ${credentialSummary(draft)}, then save as "${name}"`;
}

function credentialSummary(draft: ConnectionDraft): string {
  if (draft.credential === "none") return "no credential";
  if (draft.credential === "api-key")
    return draft.apiKey === "" ? "the saved key" : "the typed key";
  return `$${draft.credential.slice("env:".length) || "<variable>"}`;
}

function draftProblem(draft: ConnectionDraft): string | undefined {
  if (draft.name.trim() === "") return "a connection needs a name";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(draft.name.trim()))
    return "names are lowercase letters, digits, . _ -";
  if (!/^https?:\/\/\S+$/.test(draft.endpoint.trim())) return "endpoint must be an http(s) URL";
  if (draft.credential === "env:") return "name the environment variable";
  if (needsInsecureChoice(draft.endpoint) && !draft.insecureTransport)
    return "plain http off loopback is refused until you allow it";
  return undefined;
}

function modelsFact(models: readonly string[]): string {
  if (models.length === 0) return "no models reported";
  return models.length === 1
    ? `1 model reported: ${models[0]}`
    : `${models.length} models reported`;
}

function lead(selected: boolean): ConnectSpan {
  return span(selected ? "▸ " : "  ", "accent");
}

function span(text: string, tone: ConnectTone = "text"): ConnectSpan {
  return { text, tone };
}

function dim(text: string): ConnectSpan {
  return span(text, "dim");
}

function plain(text: string): ConnectRow {
  return row([span(text)]);
}

function row(spans: readonly ConnectSpan[]): ConnectRow {
  return { spans, selected: false };
}
