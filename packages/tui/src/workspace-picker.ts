import { isSlug } from "@keywork/shared";
import { FilterPicker } from "./filter-picker.ts";
import { rankByFuzzy } from "./picker-keys.ts";
import { pluralize } from "./pluralize.ts";

export interface WorkspaceChoice {
  slug: string | undefined;
  name: string;
  declared: boolean;
  current: boolean;
  notes: number;
  focusDirs: readonly string[];
  sessions: number;
  lastUsed: number | undefined;
}

export interface WorkspacesPort {
  list(): Promise<WorkspaceChoice[]>;
  create(slug: string): Promise<void>;
  use(slug: string | undefined): Promise<void>;
  linkFocusDir(slug: string | undefined, dir: string): Promise<string>;
  unlinkFocusDir(slug: string | undefined, dir: string): Promise<void>;
}

export type WorkspacePickerRow =
  | { kind: "workspace"; choice: WorkspaceChoice }
  | { kind: "create"; slug: string };

export type WorkspacePickerChoice =
  | { kind: "use"; slug: string | undefined }
  | { kind: "create"; slug: string };

export type WorkspacePicker = FilterPicker<WorkspacePickerRow>;

export function workspacePickerOver(choices: readonly WorkspaceChoice[]): WorkspacePicker {
  return new FilterPicker(
    (needle) => workspaceRows(choices, needle),
    (row) => row.kind === "workspace" && row.choice.current,
  );
}

export function workspaceChoiceOf(row: WorkspacePickerRow): WorkspacePickerChoice {
  return row.kind === "create"
    ? { kind: "create", slug: row.slug }
    : { kind: "use", slug: row.choice.slug };
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

function workspaceRows(choices: readonly WorkspaceChoice[], needle: string): WorkspacePickerRow[] {
  return [
    ...rankByFuzzy(choices, needle, labelOf).map(
      (choice): WorkspacePickerRow => ({ kind: "workspace", choice }),
    ),
    ...createRow(choices, needle),
  ];
}

function createRow(choices: readonly WorkspaceChoice[], needle: string): WorkspacePickerRow[] {
  if (needle === "" || !isSlug(needle) || needle === "default") return [];
  if (choices.some((choice) => choice.slug === needle)) return [];
  return [{ kind: "create", slug: needle }];
}

function labelOf(choice: WorkspaceChoice): string {
  return choice.slug ?? "default";
}

function notesFact(count: number): string {
  return count === 0 ? "empty vault" : pluralize(count, "memory file");
}
