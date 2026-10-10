import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { failed, invoke } from "./backend.ts";
import type { CommandRunner } from "./command.ts";
import type { SecretVault } from "./vault.ts";

const backend = "windows dpapi";

export function dpapiVault(dir: string, run: CommandRunner): SecretVault {
  const fileFor = (name: string) => join(dir, `${name}.dpapi`);
  const transform = async (script: string, base64: string): Promise<string> => {
    const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand(script)];
    const result = await invoke(backend, run, "powershell", args, base64);
    if (result.code !== 0) throw failed(backend, result);
    return lastLine(result.stdout);
  };
  return {
    backend,
    store: async (name, value) => {
      const sealed = await transform(sealScript, toBase64(value));
      await mkdir(dir, { recursive: true });
      await writeFile(fileFor(name), `${sealed}\n`, { encoding: "utf8", mode: 0o600 });
    },
    lookup: async (name) => {
      const sealed = await readIfPresent(fileFor(name));
      if (sealed === undefined) return undefined;
      return fromBase64(await transform(unsealScript, sealed.trim()));
    },
    forget: (name) => rm(fileFor(name), { force: true }),
  };
}

const sealScript = protectionScript("Protect");
const unsealScript = protectionScript("Unprotect");

function protectionScript(direction: "Protect" | "Unprotect"): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "try {",
    "  Add-Type -AssemblyName System.Security",
    "  $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
    `  $out = [Security.Cryptography.ProtectedData]::${direction}($bytes, $null, 'CurrentUser')`,
    "  [Console]::Out.WriteLine([Convert]::ToBase64String($out))",
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\n");
}

function encodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function toBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function fromBase64(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf8");
}

function lastLine(output: string): string {
  return output.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}
