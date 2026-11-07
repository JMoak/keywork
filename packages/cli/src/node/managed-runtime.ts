import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ManagedRuntime, RuntimeVersion } from "@keywork/engine";
import type { SelfLaunch } from "./launch.ts";
import type { CommandRunner } from "./runner.ts";

export interface ManagedRuntimeInput extends RuntimeVersion {
  root: string;
  launch: SelfLaunch;
  platform: NodeJS.Platform;
  arch: string;
  verify: CommandRunner;
}

export async function stageManagedRuntime(input: ManagedRuntimeInput): Promise<ManagedRuntime> {
  if (input.launch.args.length !== 0) {
    throw new Error(
      "A packaged consumer needs a compiled keywork artifact; a Bun source launcher cannot become the managed engine.",
    );
  }
  const inspected = await input.verify(input.launch.program, ["--version"]);
  const expected = `keywork ${input.version} · contract ${input.contract}`;
  if (inspected.code !== 0 || inspected.stdout.trim() !== expected) {
    throw new Error(`The engine artifact must report "${expected}" before it can be installed.`);
  }
  const sha256 = digest(input.launch.program);
  const directory = join(
    input.root,
    `${segment(input.version)}-${segment(input.contract)}`,
    `${segment(input.platform)}-${segment(input.arch)}`,
    sha256,
  );
  const binary = join(directory, input.platform === "win32" ? "keywork.exe" : "keywork");
  mkdirSync(directory, { recursive: true });
  if (!existsSync(binary)) copyVerified(input.launch.program, binary, sha256);
  if (digest(binary) !== sha256) {
    throw new Error(
      "The immutable managed engine has changed; restore its verified artifact before using it.",
    );
  }
  const runtime: ManagedRuntime = {
    version: input.version,
    contract: input.contract,
    binary,
    sha256,
    platform: input.platform,
    arch: input.arch,
  };
  const metadata = join(directory, "artifact.json");
  if (!existsSync(metadata))
    writeFileSync(metadata, `${JSON.stringify(runtime, null, 2)}\n`, { flag: "wx" });
  return runtime;
}

export function verifyManagedRuntime(runtime: ManagedRuntime): void {
  if (!existsSync(runtime.binary) || digest(runtime.binary) !== runtime.sha256) {
    throw new Error(
      "The shared engine artifact is missing or changed; reinstall its owning product before attaching.",
    );
  }
}

function copyVerified(source: string, destination: string, expected: string): void {
  try {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return;
    throw cause;
  }
  if (digest(destination) !== expected) {
    rmSync(destination);
    throw new Error(
      "The engine artifact changed while it was being staged; retry with an immutable build.",
    );
  }
  chmodSync(destination, 0o755);
}

function digest(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function segment(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value))
    throw new Error("Invalid managed runtime identity.");
  return value;
}
