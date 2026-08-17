import type { FrameSize } from "./scenario.ts";

export interface CaptureArgs {
  readonly scenarios: readonly string[];
  readonly out: string;
  readonly size: FrameSize;
  readonly list: boolean;
  readonly updateGoldens: boolean;
  readonly cwd?: string;
  readonly live: boolean;
}

export type ParsedCaptureArgs = { ok: true; args: CaptureArgs } | { ok: false; error: string };

export const defaultSize: FrameSize = { width: 120, height: 32 };
export const defaultOut = "artifacts/e2e";

export function parseCaptureArgs(argv: readonly string[]): ParsedCaptureArgs {
  const scenarios: string[] = [];
  let out = defaultOut;
  let size = defaultSize;
  let list = false;
  let updateGoldens = false;
  let cwd: string | undefined;
  let live = false;
  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at] as string;
    if (argument === "--list") {
      list = true;
    } else if (argument === "--update-goldens") {
      updateGoldens = true;
    } else if (argument === "--live") {
      live = true;
    } else if (argument === "--size" || argument === "--out" || argument === "--cwd") {
      at += 1;
      const value = argv[at];
      if (value === undefined) return { ok: false, error: `${argument} requires a value` };
      if (argument === "--out") {
        out = value;
      } else if (argument === "--cwd") {
        cwd = value;
      } else {
        const parsed = parseSize(value);
        if (parsed === undefined) {
          return { ok: false, error: `--size expects <cols>x<rows>, got "${value}"` };
        }
        size = parsed;
      }
    } else if (argument.startsWith("-")) {
      return { ok: false, error: `unknown flag: ${argument}` };
    } else {
      scenarios.push(argument);
    }
  }
  return {
    ok: true,
    args: { scenarios, out, size, list, updateGoldens, ...(cwd !== undefined && { cwd }), live },
  };
}

export function liveModeRefusal(args: CaptureArgs): string | undefined {
  if (args.cwd !== undefined && !args.live) {
    return "--cwd points the harness at real state; add --live to consent, or drop --cwd for the temp-root run";
  }
  if (args.live && args.cwd === undefined) {
    return "--live requires --cwd <dir> naming the target directory";
  }
  if (args.live && args.scenarios.length === 0) {
    return "--live never expands to the full pack; name the scenario(s) to run explicitly";
  }
  return undefined;
}

function parseSize(value: string): FrameSize | undefined {
  const match = value.match(/^(\d+)x(\d+)$/);
  if (match === null) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 20 || height < 10) return undefined;
  return { width, height };
}
