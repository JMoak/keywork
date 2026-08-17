import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyMasks, defaultMasks, diffFrames } from "./mask.ts";

export function goldenPath(goldenRoot: string, scenarioName: string, stepBase: string): string {
  return join(goldenRoot, scenarioName, `${stepBase}.txt`);
}

export function writeGolden(path: string, frame: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, maskedFrame(frame));
}

export function verifyGolden(path: string, frame: string): void {
  if (!existsSync(path)) {
    throw new Error(`golden missing: ${path} — rerun with --update-goldens to record it`);
  }
  const expected = maskedFrame(readFileSync(path, "utf8"));
  const mismatch = diffFrames(expected, maskedFrame(frame));
  if (mismatch !== undefined) throw new Error(`golden mismatch: ${path}\n${mismatch}`);
}

function maskedFrame(text: string): string {
  return applyMasks(text.replaceAll("\r\n", "\n"), defaultMasks);
}
