import {
  type WorkspacePicker,
  type WorkspacePickerChoice,
  type WorkspacesPort,
  workspacePickerOver,
} from "./workspace-picker.ts";

export interface WorkspaceCommandSeams {
  workspaces: WorkspacesPort;
  notice(text: string): void;
  showPicker(picker: WorkspacePicker): void;
  shutdown(): void;
}

export async function runWorkspaceCommand(
  seams: WorkspaceCommandSeams,
  argument: string,
): Promise<void> {
  const [verb = "", operand] = argument.split(/\s+/).filter((word) => word !== "");
  switch (verb) {
    case "":
      seams.showPicker(workspacePickerOver(await seams.workspaces.list()));
      return;
    case "new":
      return createWorkspace(seams, operand);
    case "default":
      return switchWorkspace(seams, undefined);
    default:
      return switchWorkspace(seams, verb);
  }
}

export function applyWorkspaceChoice(
  seams: WorkspaceCommandSeams,
  choice: WorkspacePickerChoice,
): Promise<void> {
  return choice.kind === "create"
    ? createWorkspace(seams, choice.slug)
    : switchWorkspace(seams, choice.slug);
}

async function createWorkspace(
  seams: WorkspaceCommandSeams,
  slug: string | undefined,
): Promise<void> {
  if (slug === undefined) {
    seams.notice("new needs a name · /workspace new <slug>");
    return;
  }
  await seams.workspaces.create(slug);
  await switchWorkspace(seams, slug);
}

export async function switchWorkspace(
  seams: Pick<WorkspaceCommandSeams, "workspaces" | "notice" | "shutdown">,
  slug: string | undefined,
): Promise<void> {
  await seams.workspaces.use(slug);
  seams.notice(`workspace → ${slug ?? "default"} · reopening`);
  seams.shutdown();
}
