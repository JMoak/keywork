import { acquireRuntimeOwnership, type RuntimeOwnership } from "@keywork/engine";
import { workspaceWriterFile } from "./paths.ts";

export interface WorkspaceWriterScope {
  cwd: string;
  workspaceSlug?: string | undefined;
  userRoot?: string | undefined;
}

export class WorkspaceInUseError extends Error {
  override readonly name = "WorkspaceInUseError";

  constructor() {
    super(
      "this workspace already has an active runtime; attach to it with `keywork attach`, or close it before starting another writer",
    );
  }
}

export async function ownWorkspace(scope: WorkspaceWriterScope): Promise<RuntimeOwnership> {
  const ownership = await acquireRuntimeOwnership(
    workspaceWriterFile(scope.cwd, scope.workspaceSlug, scope.userRoot),
  );
  if (ownership === undefined) throw new WorkspaceInUseError();
  return ownership;
}

export async function withWorkspaceWriter<T>(
  scope: WorkspaceWriterScope,
  run: () => Promise<T>,
): Promise<T> {
  const ownership = await ownWorkspace(scope);
  try {
    return await run();
  } finally {
    ownership.release();
  }
}
