import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface EditorCommand {
  readonly program: string;
  readonly args: readonly string[];
}

export type EditorResult =
  | { kind: "edited"; text: string }
  | { kind: "unchanged" }
  | { kind: "failed"; reason: string };

export type ExternalEditor = (draft: string) => Promise<EditorResult>;

export interface RendererHold {
  suspend(): void;
  resume(): void;
}

export interface ExternalEditorDeps {
  readonly hold: RendererHold;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly tempDir?: string;
  readonly run?: (command: EditorCommand, file: string) => Promise<number>;
}

export const windowsFallbackEditor = "notepad";
export const posixFallbackEditor = "vi";

export function editorCommandFor(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): EditorCommand {
  const chosen = [env.VISUAL, env.EDITOR].find(
    (value) => value !== undefined && value.trim() !== "",
  );
  const words = chosen === undefined ? [] : shellWords(chosen);
  const [program, ...args] = words;
  if (program !== undefined) return { program, args };
  return { program: platform === "win32" ? windowsFallbackEditor : posixFallbackEditor, args: [] };
}

export function externalEditorFor(deps: ExternalEditorDeps): ExternalEditor {
  return (draft) => editDraftExternally(draft, deps);
}

export async function editDraftExternally(
  draft: string,
  deps: ExternalEditorDeps,
): Promise<EditorResult> {
  const command = editorCommandFor(deps.env ?? process.env, deps.platform ?? process.platform);
  const file = draftFile(deps.tempDir ?? tmpdir());
  try {
    writeFileSync(file, draft, "utf8");
  } catch (cause) {
    return failed(`could not write the draft file · ${messageOf(cause)}`);
  }
  deps.hold.suspend();
  let code: number;
  try {
    code = await (deps.run ?? runEditor)(command, file);
  } catch (cause) {
    deps.hold.resume();
    discard(file);
    return failed(`${command.program} did not start · ${messageOf(cause)}`);
  }
  deps.hold.resume();
  const edited = readBack(file);
  discard(file);
  if (code !== 0) return failed(`${command.program} exited with code ${code}`);
  if (edited === undefined) return failed("the draft file vanished while the editor ran");
  return edited === withoutFinalNewline(draft)
    ? { kind: "unchanged" }
    : { kind: "edited", text: edited };
}

export function shellWords(command: string): string[] {
  const words: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return words;
}

function runEditor(command: EditorCommand, file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.program, [...command.args, file], {
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

let draftSequence = 0;

function draftFile(dir: string): string {
  draftSequence += 1;
  return join(dir, `keywork-draft-${process.pid}-${draftSequence}.md`);
}

function readBack(file: string): string | undefined {
  try {
    return withoutFinalNewline(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
  } catch {
    return undefined;
  }
}

function withoutFinalNewline(text: string): string {
  return text.replace(/\n$/, "");
}

function discard(file: string): void {
  try {
    unlinkSync(file);
  } catch {}
}

function failed(reason: string): EditorResult {
  return { kind: "failed", reason };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
