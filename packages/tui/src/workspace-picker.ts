import { isSlug } from "@keywork/shared";
import { fuzzyScore } from "./commands.ts";
import type { Chord } from "./keys.ts";
import { type PickerKeyOutcome, pickerIntentOf } from "./picker-keys.ts";

export interface WorkspaceChoice {
  slug: string | undefined;
  name: string;
  declared: boolean;
  current: boolean;
  notes: number;
}

export interface WorkspacesPort {
  list(): Promise<WorkspaceChoice[]>;
  create(slug: string): Promise<void>;
  use(slug: string | undefined): Promise<void>;
}

type WorkspacePickerSeed =
  | { kind: "workspace"; choice: WorkspaceChoice }
  | { kind: "create"; slug: string };

export type WorkspacePickerRow = WorkspacePickerSeed & { selected: boolean };

export type WorkspacePickerChoice =
  | { kind: "use"; slug: string | undefined }
  | { kind: "create"; slug: string };

export class WorkspacePicker {
  query = "";
  private index: number;

  constructor(private readonly choices: readonly WorkspaceChoice[]) {
    const at = this.seeds().findIndex((row) => row.kind === "workspace" && row.choice.current);
    this.index = Math.max(0, at);
  }

  rows(): WorkspacePickerRow[] {
    const seeds = this.seeds();
    const selectedAt = Math.min(this.index, Math.max(0, seeds.length - 1));
    return seeds.map((row, at) => ({ ...row, selected: at === selectedAt }));
  }

  selected(): WorkspacePickerChoice | undefined {
    const row = this.rows().find((candidate) => candidate.selected);
    if (row === undefined) return undefined;
    return row.kind === "create"
      ? { kind: "create", slug: row.slug }
      : { kind: "use", slug: row.choice.slug };
  }

  handleKey(chord: Chord, sequence: string | undefined): PickerKeyOutcome {
    const intent = pickerIntentOf(chord, sequence);
    switch (intent.kind) {
      case "close":
        return "close";
      case "choose":
        return "choose";
      case "move":
        this.move(intent.step);
        return "stay";
      case "erase":
        this.retype(this.query.slice(0, -1));
        return "stay";
      case "type":
        this.retype(this.query + intent.text);
        return "stay";
      case "ignore":
        return "stay";
    }
  }

  private seeds(): WorkspacePickerSeed[] {
    const needle = this.query.trim().toLowerCase();
    const matching =
      needle === ""
        ? [...this.choices]
        : this.choices
            .map((choice) => ({ choice, score: fuzzyScore(needle, labelOf(choice)) }))
            .filter(
              (entry): entry is { choice: WorkspaceChoice; score: number } =>
                entry.score !== undefined,
            )
            .sort((left, right) => right.score - left.score)
            .map((entry) => entry.choice);
    return [
      ...matching.map((choice): WorkspacePickerSeed => ({ kind: "workspace", choice })),
      ...this.createRow(needle),
    ];
  }

  private createRow(needle: string): WorkspacePickerSeed[] {
    if (needle === "" || !isSlug(needle) || needle === "default") return [];
    if (this.choices.some((choice) => choice.slug === needle)) return [];
    return [{ kind: "create", slug: needle }];
  }

  private move(step: number): void {
    const count = Math.max(1, this.seeds().length);
    this.index = (this.index + step + count) % count;
  }

  private retype(query: string): void {
    this.query = query;
    this.index = 0;
  }
}

export function describeWorkspaceRow(row: WorkspacePickerRow): string {
  if (row.kind === "create") return `new workspace ${row.slug}`;
  const { choice } = row;
  const facts = [
    labelOf(choice),
    ...(choice.slug !== undefined && choice.name !== choice.slug ? [choice.name] : []),
    choice.declared ? notesFact(choice.notes) : "not set up yet",
    ...(choice.current ? ["current"] : []),
  ];
  return facts.join(" · ");
}

function labelOf(choice: WorkspaceChoice): string {
  return choice.slug ?? "default";
}

function notesFact(count: number): string {
  if (count === 0) return "empty vault";
  return count === 1 ? "1 memory file" : `${count} memory files`;
}
