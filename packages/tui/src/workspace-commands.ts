import { verbAndOperand } from "./commands.ts";
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

export type WorkspaceInvocation =
  | { verb: "pick"; slug?: string | undefined }
  | { verb: "new"; slug?: string | undefined }
  | { verb: "default" };

export async function runWorkspaceCommand(
  seams: WorkspaceCommandSeams,
  invocation: WorkspaceInvocation,
): Promise<void> {
  switch (invocation.verb) {
    case "pick":
      if (invocation.slug !== undefined) return switchWorkspace(seams, invocation.slug);
      seams.showPicker(workspacePickerOver(await seams.workspaces.list()));
      return;
    case "new":
      return createWorkspace(seams, invocation.slug);
    case "default":
      return switchWorkspace(seams, undefined);
  }
}

export function legacyWorkspaceInvocation(argument: string): WorkspaceInvocation {
  const [verb, operand] = verbAndOperand(argument);
  switch (verb) {
    case "":
      return { verb: "pick" };
    case "new":
      return { verb: "new", slug: operand };
    case "default":
      return { verb: "default" };
    default:
      return { verb: "pick", slug: verb };
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
    seams.notice("new needs a name · /workspace-new <slug>");
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
