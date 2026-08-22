import { isLoopbackEndpoint } from "@keywork/engine";
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
import { isPrintable } from "./picker-keys.ts";

export type ConnectStage =
  | { kind: "targets"; index: number }
  | EditorStage
  | { kind: "verifying"; draft: ConnectionDraft }
  | { kind: "failed"; draft: ConnectionDraft; reason: string; at: string }
  | { kind: "receipt"; draft: ConnectionDraft; models: readonly string[]; at: string }
  | { kind: "remove-confirm"; name: string; credential: string }
  | { kind: "removed"; receipt: RemovalReceipt };

export interface EditorStage {
  kind: "editor";
  draft: ConnectionDraft;
  field: number;
  fixed: FixedFields;
  existing: boolean;
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
  pick: ConnectionTarget | SavedConnection;
}

export interface ConnectHooks {
  notify(): void;
  chooseModel(): void;
  notice(text: string): void;
}

export type ConnectKeyOutcome = "stay" | "close";

export class ConnectModel {
  stage: ConnectStage = { kind: "targets", index: 0 };

  constructor(
    private readonly port: ConnectionsPort,
    private readonly hooks: ConnectHooks,
  ) {}

  open(argument: string | undefined): void {
    const trimmed = argument?.trim() ?? "";
    if (trimmed === "") {
      this.stage = { kind: "targets", index: 0 };
      return;
    }
    const pick = this.targetRows().find((row) => rowId(row.pick) === trimmed)?.pick;
    if (pick !== undefined) {
      this.edit(pick);
      return;
    }
    if (/^https?:\/\//.test(trimmed)) {
      const custom = this.port.targets().find((target) => target.kind === "custom");
      if (custom !== undefined) {
        this.edit({ ...custom, endpoint: trimmed.replace(/\/+$/, "") });
        return;
      }
    }
    this.hooks.notice(`/connect: "${trimmed}" is not a target, a saved connection, or a URL`);
    this.stage = { kind: "targets", index: 0 };
  }

  targetRows(): TargetRow[] {
    const saved = this.port.saved().map((row) => ({
      label: row.name,
      detail: [row.endpoint, row.credential, observationFact(row)]
        .filter((fact) => fact !== "")
        .join(" · "),
      pick: row,
    }));
    const targets = this.port.targets().map((target) => ({
      label: target.label,
      detail: target.kind === "custom" ? "any OpenAI-compatible URL" : target.endpoint,
      pick: target,
    }));
    return [...saved, ...targets];
  }

  fields(): EditorField[] {
    return this.stage.kind === "editor" ? editorFields(this.stage) : [];
  }

  rowCount(): number {
    const { stage } = this;
    switch (stage.kind) {
      case "targets":
        return this.targetRows().length;
      case "editor":
        return editorFields(stage).length + editorHintRows;
      case "verifying":
        return 1;
      case "failed":
      case "remove-confirm":
        return 2;
      case "receipt":
        return 3;
      case "removed":
        return 2 + stage.receipt.retained.length;
    }
  }

  clickRow(row: number): ConnectKeyOutcome {
    const { stage } = this;
    switch (stage.kind) {
      case "targets": {
        const picked = this.targetRows()[row];
        if (picked !== undefined) this.edit(picked.pick);
        return "stay";
      }
      case "editor":
        if (row < editorFields(stage).length) this.stage = { ...stage, field: row };
        return "stay";
      case "failed":
        this.returnToEditor(stage.draft);
        return "stay";
      case "removed":
        return "close";
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
      case "targets":
        return this.handleTargetsKey(stage.index, chord);
      case "editor":
        return this.handleEditorKey(stage, chord, sequence);
      case "verifying":
        if (chord.name === "escape") {
          this.returnToEditor(stage.draft);
          this.hooks.notice("verify cancelled · nothing saved");
        }
        return "stay";
      case "failed":
        this.returnToEditor(stage.draft);
        return "stay";
      case "receipt":
        if (chord.name === "return" || chord.name === "enter") {
          this.hooks.chooseModel();
          return "close";
        }
        return chord.name === "escape" ? "close" : "stay";
      case "remove-confirm":
        return this.handleRemoveConfirmKey(stage.name, chord);
      case "removed":
        return "close";
    }
  }

  private handleTargetsKey(index: number, chord: Chord): ConnectKeyOutcome {
    if (chord.name === "escape") return "close";
    const rows = this.targetRows();
    if (chord.name === "up" || chord.name === "down") {
      const count = Math.max(1, rows.length);
      this.stage = {
        kind: "targets",
        index: (index + (chord.name === "down" ? 1 : -1) + count) % count,
      };
      return "stay";
    }
    if (chord.name === "return" || chord.name === "enter") {
      const row = rows[index];
      if (row !== undefined) this.edit(row.pick);
    }
    return "stay";
  }

  private handleEditorKey(
    stage: EditorStage,
    chord: Chord,
    sequence: string | undefined,
  ): ConnectKeyOutcome {
    if (chord.name === "escape") return "close";
    const fields = editorFields(stage);
    const count = Math.max(1, fields.length);
    if (chord.name === "up" || chord.name === "down") {
      this.stage = {
        ...stage,
        field: (stage.field + (chord.name === "down" ? 1 : -1) + count) % count,
      };
      return "stay";
    }
    if (chord.name === "tab") {
      this.stage = { ...stage, field: (stage.field + 1) % count };
      return "stay";
    }
    const field = fields[stage.field];
    if (field === undefined) return "stay";
    if (chord.name === "return" || chord.name === "enter") {
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

  private handleRemoveConfirmKey(name: string, chord: Chord): ConnectKeyOutcome {
    if (chord.name === "y" || chord.name === "return" || chord.name === "enter") {
      void this.port
        .remove(name)
        .then((receipt) => {
          this.stage = { kind: "removed", receipt };
          this.hooks.notice(`removed ${receipt.removed.join(" and ")}`);
        })
        .catch((cause: unknown) => this.hooks.notice((cause as Error).message))
        .finally(() => this.hooks.notify());
      return "stay";
    }
    if (chord.name === "n" || chord.name === "escape") {
      const saved = this.port.saved().find((row) => row.name === name);
      if (saved !== undefined) this.edit(saved);
      else this.stage = { kind: "targets", index: 0 };
    }
    return "stay";
  }

  private edit(pick: ConnectionTarget | SavedConnection): void {
    const draft = this.port.draftFor(pick);
    const fixed =
      "kind" in pick
        ? { name: !pick.nameEditable, endpoint: !pick.endpointEditable }
        : this.fixedFor(draft);
    this.stage = editorStage(draft, fixed, !("kind" in pick));
  }

  private returnToEditor(draft: ConnectionDraft): void {
    this.stage = editorStage(draft, this.fixedFor(draft), this.isSaved(draft.name));
  }

  private fixedFor(draft: ConnectionDraft): FixedFields {
    const target = this.port
      .targets()
      .find((candidate) => candidate.kind === "built-in" && candidate.name === draft.name);
    return target === undefined ? { name: false, endpoint: false } : { name: true, endpoint: true };
  }

  private isSaved(name: string): boolean {
    return this.port.saved().some((row) => row.name === name);
  }

  private confirmRemoval(stage: EditorStage): void {
    const saved = this.port.saved().find((row) => row.name === stage.draft.name);
    this.stage = {
      kind: "remove-confirm",
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
          draft: {
            ...draft,
            protocol: draft.protocol === "chat-completions" ? "responses" : "chat-completions",
          },
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
    const verifying: ConnectStage = { kind: "verifying", draft };
    const abandoned = (): boolean => this.stage !== verifying;
    this.stage = verifying;
    this.hooks.notify();
    try {
      const verification = await this.port.verify(draft);
      if (abandoned()) return;
      if (!verification.ok) {
        this.stage = { kind: "failed", draft, reason: verification.reason, at: verification.at };
        return;
      }
      await this.port.save(draft, verification);
      if (abandoned()) {
        this.hooks.notice(`saved ${draft.name} before the cancel landed`);
        return;
      }
      this.stage = { kind: "receipt", draft, models: verification.models, at: verification.at };
    } catch (cause) {
      if (!abandoned()) this.stage = editorStage(draft, stage.fixed, stage.existing);
      this.hooks.notice((cause as Error).message);
    } finally {
      this.hooks.notify();
    }
  }
}

const editorHintRows = 1;

function editorStage(draft: ConnectionDraft, fixed: FixedFields, existing: boolean): EditorStage {
  return { kind: "editor", draft, field: 0, fixed, existing, buffers: buffersFor(draft) };
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
            label: "plain http off loopback",
            value: draft.insecureTransport
              ? "allowed (credentials and prompts travel unencrypted)"
              : "refused",
            kind: "toggle" as const,
          },
        ]
      : []),
    { id: "verify", label: "enter", value: verifyActionText(draft), kind: "action" },
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

function trimmedDraft(draft: ConnectionDraft): ConnectionDraft {
  return { ...draft, name: draft.name.trim(), endpoint: draft.endpoint.trim().replace(/\/+$/, "") };
}

function rowId(pick: ConnectionTarget | SavedConnection): string {
  return "kind" in pick ? pick.id : pick.name;
}

function observationFact(row: SavedConnection): string {
  if (row.lastFailure !== undefined)
    return `failed ${row.lastFailure.at.slice(0, 16)}: ${row.lastFailure.reason}`;
  if (row.verifiedAt !== undefined) return `verified ${row.verifiedAt.slice(0, 16)}`;
  return "";
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
  return `GET ${endpoint}/models over ${draft.protocol} with ${credentialSummary(draft)}, then save as "${name}"`;
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
