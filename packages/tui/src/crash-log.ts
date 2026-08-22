import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { toError } from "@keywork/shared";
import type { CommandSpec } from "./commands.ts";
import type { FileOpenOptions } from "./pane.ts";

export const crashLogFile = join(homedir(), ".keywork", "tui-crash.log");

export interface DoctorDeps {
  logFile: string;
  exists(path: string): boolean;
  openFile(path: string, options?: FileOpenOptions): void;
  notice(text: string): void;
}

export function doctorCommand(deps: DoctorDeps): CommandSpec {
  return {
    name: "doctor",
    aliases: ["crashlog"],
    description: "open the crash log: /doctor",
    run: () => {
      if (deps.exists(deps.logFile)) deps.openFile(deps.logFile, { atEnd: true });
      else deps.notice("no crashes recorded · nothing to show");
    },
  };
}

export function recordCrash(scope: string, cause: unknown): void {
  const error = toError(cause);
  try {
    mkdirSync(dirname(crashLogFile), { recursive: true });
    appendFileSync(
      crashLogFile,
      `${new Date().toISOString()} [${scope}] ${error.stack ?? error.message}\n`,
    );
  } catch {}
}

const crashStormLimit = { count: 20, windowMs: 5000 };

export function crashStormGate(): (nowMs: number) => boolean {
  let recent: number[] = [];
  return (nowMs) => {
    recent = [...recent.filter((at) => nowMs - at < crashStormLimit.windowMs), nowMs];
    return recent.length >= crashStormLimit.count;
  };
}

export const recoveredNotice = `recovered from an internal error · details in ${crashLogFile}`;

export interface FatalGuardDeps {
  recover(): void;
  abandon(): void;
}

export function installFatalGuards(deps: FatalGuardDeps): () => void {
  const storm = crashStormGate();
  const onUncaught = (cause: unknown): void => {
    recordCrash("uncaught", cause);
    if (storm(performance.now())) {
      deps.abandon();
      return;
    }
    try {
      deps.recover();
    } catch {}
  };
  const onRejection = (cause: unknown): void => {
    recordCrash("rejection", cause);
  };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
  return () => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
  };
}
