import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

export type SpawnLike = (
  file: string,
  args: readonly string[],
  options: { cwd: string },
) => ChildProcess;

export function resolveOnPath(
  command: string,
  searchPath: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (namesAPath(command) || searchPath === undefined) return undefined;
  const candidates = platform === "win32" ? windowsCandidates(command) : [command];
  for (const dir of searchPath.split(delimiter).filter((entry) => entry !== "")) {
    for (const candidate of candidates) {
      const file = join(dir, candidate);
      if (isExecutableFile(file, platform)) return file;
    }
  }
  return undefined;
}

export const spawnResolved: SpawnLike = (file, args, options) => {
  if (process.platform === "win32" && needsCommandInterpreter(file)) {
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", quoteForCmd(file, args)], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(file, [...args], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
};

function namesAPath(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function windowsCandidates(command: string): string[] {
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension !== "");
  const alreadyQualified = extensions.some(
    (extension) => extname(command).toLowerCase() === extension.toLowerCase(),
  );
  if (alreadyQualified) return [command];
  return [...extensions.map((extension) => `${command}${extension}`), command];
}

function isExecutableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function needsCommandInterpreter(file: string): boolean {
  const extension = extname(file).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

function quoteForCmd(file: string, args: readonly string[]): string {
  return `"${[file, ...args].map((part) => `"${part}"`).join(" ")}"`;
}
