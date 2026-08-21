import { isLoopbackEndpoint } from "@keywork/engine";
import type {
  ConnectionDraft,
  ConnectionsPort,
  ConnectionTarget,
  CredentialChoice,
  RemovalReceipt,
  SavedConnection,
} from "./inference-port.ts";
import type { Chord } from "./keys.ts";

export type ConnectStage =
  | { kind: "targets"; index: number }
  | {
      kind: "editor";
      draft: ConnectionDraft;
      field: number;
      fixed: FixedFields;
      existing: boolean;
      envVariable: string;
    }
  | { kind: "verifying"; draft: ConnectionDraft }
  | { kind: "failed"; draft: ConnectionDraft; reason: string; at: string }
  | { kind: "receipt"; draft: ConnectionDraft; models: readonly string[]; at: string }
  | { kind: "remove-confirm"; name: string; credential: string }
  | { kind: "removed"; receipt: RemovalReceipt };

export interface FixedFields {
  name: boolean;
  endpoint: boolean;
}

export type FieldKind = "text" | "secret" | "toggle" | "action" | "danger";

export interface EditorField {
  id: string;
  label: string;
  value: string;
  kind: FieldKind;
}

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
    if (this.stage.kind !== "editor") return [];
    const { draft, fixed, existing, envVariable } = this.stage;
    const fields: EditorField[] = [];
    if (!fixed.name) fields.push({ id: "name", label: "name", value: draft.name, kind: "text" });
    if (!fixed.endpoint)
      fields.push({ id: "endpoint", label: "endpoint", value: draft.endpoint, kind: "text" });
    fields.push({ id: "protocol", label: "protocol", value: draft.protocol, kind: "toggle" });
    fields.push({
      id: "credential",
      label: "credential",
      value: credentialLabel(draft.credential),
      kind: "toggle",
    });
    if (draft.credential === "api-key") {
      fields.push({ id: "apiKey", label: "api key", value: draft.apiKey, kind: "secret" });
    }
    if (draft.credential.startsWith("env:")) {
      fields.push({ id: "envVariable", label: "env variable", value: envVariable, kind: "text" });
    }
    if (needsInsecureChoice(draft.endpoint)) {
      fields.push({
        id: "insecureTransport",
        label: "plain http off loopback",
        value: draft.insecureTransport
          ? "allowed (credentials and prompts travel unencrypted)"
          : "refused",
        kind: "toggle",
      });
    }
    fields.push({ id: "verify", label: "enter", value: verifyActionText(draft), kind: "action" });
    if (existing)
      fields.push({
        id: "remove",
        label: "remove",
        value: `forget ${draft.name} and its saved key`,
        kind: "danger",
      });
    return fields;
  }

  handleKey(chord: Chord, sequence: string | undefined): ConnectKeyOutcome {
    switch (this.stage.kind) {
      case "targets":
        return this.handleTargetsKey(chord);
      case "editor":
        return this.handleEditorKey(chord, sequence);
      case "verifying":
        return "stay";
      case "failed":
        this.stage = editorStage(
          this.stage.draft,
          this.fixedFor(this.stage.draft),
          this.isSaved(this.stage.draft.name),
        );
        return "stay";
      case "receipt":
        if (chord.name === "return" || chord.name === "enter") {
          this.hooks.chooseModel();
          return "close";
        }
        return chord.name === "escape" ? "close" : "stay";
      case "remove-confirm":
        return this.handleRemoveConfirmKey(chord);
      case "removed":
        return "close";
    }
  }

  private handleTargetsKey(chord: Chord): ConnectKeyOutcome {
    if (this.stage.kind !== "targets") return "stay";
    if (chord.name === "escape") return "close";
    const rows = this.targetRows();
    if (chord.name === "up" || chord.name === "down") {
      const count = Math.max(1, rows.length);
      this.stage = {
        kind: "targets",
        index: (this.stage.index + (chord.name === "down" ? 1 : -1) + count) % count,
      };
      return "stay";
    }
    if (chord.name === "return" || chord.name === "enter") {
      const row = rows[this.stage.index];
      if (row !== undefined) this.edit(row.pick);
    }
    return "stay";
  }

  private handleEditorKey(chord: Chord, sequence: string | undefined): ConnectKeyOutcome {
    if (this.stage.kind !== "editor") return "stay";
    if (chord.name === "escape") return "close";
    const fields = this.fields();
    const field = fields[this.stage.field];
    if (chord.name === "up" || chord.name === "down") {
      const count = Math.max(1, fields.length);
      this.stage = {
        ...this.stage,
        field: (this.stage.field + (chord.name === "down" ? 1 : -1) + count) % count,
      };
      return "stay";
    }
    if (chord.name === "tab") {
      this.stage = { ...this.stage, field: (this.stage.field + 1) % Math.max(1, fields.length) };
      return "stay";
    }
    if (field === undefined) return "stay";
    if (chord.name === "return" || chord.name === "enter") {
      if (field.kind === "danger") this.confirmRemoval();
      else if (field.kind === "toggle") this.cycle(field.id, 1);
      else void this.verifyAndSave();
      return "stay";
    }
    if (
      field.kind === "toggle" &&
      (chord.name === "left" || chord.name === "right" || sequence === " ")
    ) {
      this.cycle(field.id, chord.name === "left" ? -1 : 1);
      return "stay";
    }
    if (field.kind === "text" || field.kind === "secret") this.editText(field.id, chord, sequence);
    return "stay";
  }

  private handleRemoveConfirmKey(chord: Chord): ConnectKeyOutcome {
    if (this.stage.kind !== "remove-confirm") return "stay";
    const { name } = this.stage;
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

  private fixedFor(draft: ConnectionDraft): FixedFields {
    const target = this.port
      .targets()
      .find((candidate) => candidate.kind === "built-in" && candidate.name === draft.name);
    return target === undefined ? { name: false, endpoint: false } : { name: true, endpoint: true };
  }

  private isSaved(name: string): boolean {
    return this.port.saved().some((row) => row.name === name);
  }

  private confirmRemoval(): void {
    if (this.stage.kind !== "editor") return;
    const saved = this.port
      .saved()
      .find((row) => row.name === (this.stage as { draft: ConnectionDraft }).draft.name);
    this.stage = {
      kind: "remove-confirm",
      name: this.stage.draft.name,
      credential: saved?.credential ?? "no credential",
    };
  }

  private cycle(id: string, step: number): void {
    if (this.stage.kind !== "editor") return;
    const { draft } = this.stage;
    if (id === "protocol") {
      this.stage = {
        ...this.stage,
        draft: {
          ...draft,
          protocol: draft.protocol === "chat-completions" ? "responses" : "chat-completions",
        },
      };
    } else if (id === "credential") {
      const order: readonly CredentialChoice[] = [
        "none",
        "api-key",
        `env:${this.stage.envVariable}`,
      ];
      const at = order.findIndex(
        (choice) => credentialKind(choice) === credentialKind(draft.credential),
      );
      const next = order[(at + step + order.length) % order.length] as CredentialChoice;
      this.stage = { ...this.stage, draft: { ...draft, credential: next } };
    } else if (id === "insecureTransport") {
      this.stage = {
        ...this.stage,
        draft: { ...draft, insecureTransport: !draft.insecureTransport },
      };
    }
  }

  private editText(id: string, chord: Chord, sequence: string | undefined): void {
    if (this.stage.kind !== "editor") return;
    const current = this.textValue(id);
    const typed =
      sequence !== undefined &&
      sequence.length === 1 &&
      !chord.ctrl &&
      !chord.meta &&
      sequence >= " ";
    const next =
      chord.name === "backspace" ? current.slice(0, -1) : typed ? current + sequence : undefined;
    if (next === undefined) return;
    this.setText(id, next);
  }

  private textValue(id: string): string {
    if (this.stage.kind !== "editor") return "";
    if (id === "envVariable") return this.stage.envVariable;
    const value = this.stage.draft[id as "name" | "endpoint" | "apiKey"];
    return typeof value === "string" ? value : "";
  }

  private setText(id: string, value: string): void {
    if (this.stage.kind !== "editor") return;
    if (id === "envVariable") {
      this.stage = {
        ...this.stage,
        envVariable: value,
        draft: { ...this.stage.draft, credential: `env:${value}` },
      };
      return;
    }
    this.stage = { ...this.stage, draft: { ...this.stage.draft, [id]: value } };
  }

  private async verifyAndSave(): Promise<void> {
    if (this.stage.kind !== "editor") return;
    const { draft, fixed } = this.stage;
    const existing = this.stage.existing;
    const problem = draftProblem(draft);
    if (problem !== undefined) {
      this.hooks.notice(problem);
      return;
    }
    const trimmed = {
      ...draft,
      name: draft.name.trim(),
      endpoint: draft.endpoint.trim().replace(/\/+$/, ""),
    };
    this.stage = { kind: "verifying", draft: trimmed };
    this.hooks.notify();
    try {
      const verification = await this.port.verify(trimmed);
      if (!verification.ok) {
        this.stage = {
          kind: "failed",
          draft: trimmed,
          reason: verification.reason,
          at: verification.at,
        };
        return;
      }
      await this.port.save(trimmed, verification);
      this.stage = {
        kind: "receipt",
        draft: trimmed,
        models: verification.models,
        at: verification.at,
      };
    } catch (cause) {
      this.stage = editorStage(trimmed, fixed, existing);
      this.hooks.notice((cause as Error).message);
    } finally {
      this.hooks.notify();
    }
  }
}

function editorStage(draft: ConnectionDraft, fixed: FixedFields, existing: boolean): ConnectStage {
  return {
    kind: "editor",
    draft,
    field: 0,
    fixed,
    existing,
    envVariable: draft.credential.startsWith("env:") ? draft.credential.slice("env:".length) : "",
  };
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
