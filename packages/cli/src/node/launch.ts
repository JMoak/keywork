import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface SelfLaunch {
  program: string;
  args: readonly string[];
}

export function selfLaunch(
  execPath: string = process.execPath,
  script: string | undefined = process.argv[1],
  exists: (path: string) => boolean = existsSync,
): SelfLaunch {
  return script !== undefined && isScriptOnDisk(script, exists)
    ? { program: execPath, args: [script] }
    : { program: execPath, args: [] };
}

export function launchArgv(launch: SelfLaunch, args: readonly string[]): string[] {
  return [launch.program, ...launch.args, ...args];
}

export const supervisorArgs = ["node", "run", "--supervise"] as const;
export const coreArgs = ["node", "run"] as const;

export function workspaceServeArgs(slug: string | null, home = false): string[] {
  return [
    "serve",
    ...(home ? ["--home"] : []),
    "--port",
    "0",
    ...(slug === null ? [] : ["--workspace", slug]),
  ];
}

const scriptExtension = /\.[cm]?[jt]s$/;

function isScriptOnDisk(script: string, exists: (path: string) => boolean): boolean {
  return scriptExtension.test(script) && isAbsolute(script) && exists(script);
}
