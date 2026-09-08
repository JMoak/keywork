import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ConfigError, loadConfig } from "@keywork/shared";
import type { BindingSpec, KeybindingSource } from "@keywork/tui";

export interface KeybindingFiles {
  userDir: string;
  projectDir: string;
  projectTrusted: boolean;
  watchDirectory?: WatchDirectory;
}

export type WatchDirectory = (
  dir: string,
  onChange: (fileName: string | undefined) => void,
) => () => void;

export const configFileName = "keywork.json";

export function fileKeybindings(files: KeybindingFiles): KeybindingSource {
  const watchDirectory = files.watchDirectory ?? watchDirectoryFromDisk;
  return {
    read: () => readBindings(files),
    watch: (changed) => {
      const stops = watchedDirs(files).map((dir) =>
        watchDirectory(dir, (fileName) => {
          if (fileName === undefined || fileName === configFileName) changed();
        }),
      );
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}

export function jsonSyntaxPosition(raw: string): { line: number; column: number } | undefined {
  const offset = new JsonScanner(raw).firstFailure();
  if (offset === undefined) return undefined;
  const before = raw.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return { line, column };
}

async function readBindings(files: KeybindingFiles): Promise<Record<string, BindingSpec>> {
  try {
    const config = await loadConfig({
      userDir: files.userDir,
      projectDir: files.projectDir,
      projectTrusted: files.projectTrusted,
    });
    return config.keybindings ?? {};
  } catch (cause) {
    if (cause instanceof ConfigError) throw new Error(await describeConfigError(cause));
    throw cause;
  }
}

async function describeConfigError(error: ConfigError): Promise<string> {
  const name = basename(error.file);
  const detail = error.message.split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim();
  if (!detail.startsWith("not valid JSON")) return `${name}: ${detail}`;
  const position = jsonSyntaxPosition(await readFile(error.file, "utf8").catch(() => ""));
  return position === undefined
    ? `${name}: ${detail}`
    : `${name}:${position.line}:${position.column} is not valid JSON`;
}

function watchedDirs(files: KeybindingFiles): string[] {
  return files.projectTrusted ? [files.userDir, files.projectDir] : [files.userDir];
}

function watchDirectoryFromDisk(dir: string, onChange: (fileName: string | undefined) => void) {
  try {
    const watcher = watch(dir, (_event, fileName) => onChange(fileName ?? undefined));
    watcher.on("error", () => watcher.close());
    watcher.unref?.();
    return () => watcher.close();
  } catch {
    return () => {};
  }
}

class JsonScanner {
  private at = 0;

  constructor(private readonly text: string) {}

  firstFailure(): number | undefined {
    if (!this.value()) return this.at;
    this.skipSpace();
    return this.at === this.text.length ? undefined : this.at;
  }

  private value(): boolean {
    this.skipSpace();
    const head = this.text[this.at];
    if (head === "{") return this.object();
    if (head === "[") return this.array();
    if (head === '"') return this.string();
    if (head !== undefined && /[-\d]/.test(head)) return this.number();
    return this.literal("true") || this.literal("false") || this.literal("null");
  }

  private object(): boolean {
    this.at += 1;
    this.skipSpace();
    if (this.text[this.at] === "}") return this.advance();
    for (;;) {
      this.skipSpace();
      if (this.text[this.at] !== '"' || !this.string()) return false;
      this.skipSpace();
      if (this.text[this.at] !== ":") return false;
      this.at += 1;
      if (!this.value()) return false;
      this.skipSpace();
      if (this.text[this.at] === "}") return this.advance();
      if (this.text[this.at] !== ",") return false;
      this.at += 1;
    }
  }

  private array(): boolean {
    this.at += 1;
    this.skipSpace();
    if (this.text[this.at] === "]") return this.advance();
    for (;;) {
      if (!this.value()) return false;
      this.skipSpace();
      if (this.text[this.at] === "]") return this.advance();
      if (this.text[this.at] !== ",") return false;
      this.at += 1;
    }
  }

  private string(): boolean {
    this.at += 1;
    for (;;) {
      const character = this.text[this.at];
      if (character === undefined || character === "\n") return false;
      if (character === '"') return this.advance();
      this.at += character === "\\" ? 2 : 1;
    }
  }

  private number(): boolean {
    const match = this.text.slice(this.at).match(/^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/);
    if (match === null) return false;
    this.at += match[0].length;
    return true;
  }

  private literal(word: string): boolean {
    if (!this.text.startsWith(word, this.at)) return false;
    this.at += word.length;
    return true;
  }

  private advance(): boolean {
    this.at += 1;
    return true;
  }

  private skipSpace(): void {
    while (/\s/.test(this.text[this.at] ?? "")) this.at += 1;
  }
}
