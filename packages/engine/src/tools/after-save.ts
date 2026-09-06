import { toError } from "@keywork/shared";

export type AfterSave = (path: string, signal?: AbortSignal) => Promise<string | undefined>;

export interface ComposeAfterSaveOptions {
  onFailure?: ((error: Error, path: string) => void) | undefined;
}

export function composeAfterSave(
  observers: readonly (AfterSave | undefined)[],
  options: ComposeAfterSaveOptions = {},
): AfterSave | undefined {
  const live = observers.filter((observer): observer is AfterSave => observer !== undefined);
  if (live.length === 0) return undefined;
  return async (path, signal) => {
    const annotations: string[] = [];
    for (const observer of live) {
      const annotation = await observer(path, signal).catch((cause: unknown) => {
        options.onFailure?.(toError(cause), path);
        return undefined;
      });
      if (annotation !== undefined && annotation !== "") annotations.push(annotation);
    }
    return annotations.length === 0 ? undefined : annotations.join("\n\n");
  };
}

export async function annotatedResult(
  confirmation: string,
  afterSave: AfterSave | undefined,
  path: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (afterSave === undefined) return confirmation;
  const annotation = await afterSave(path, signal).catch(() => undefined);
  return annotation === undefined || annotation === ""
    ? confirmation
    : `${confirmation}\n\n${annotation}`;
}
