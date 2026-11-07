import { execFile } from "node:child_process";
import { type PingResult, parsePingOutput, pingFailure } from "./ping.ts";
import { parseServeConfig } from "./serve-config.ts";
import { parseStatus } from "./status.ts";
import { isIPAddress } from "./tailnet-address.ts";
import {
  defaultPingTimeoutMs,
  defaultRequestTimeoutMs,
  type PingOptions,
  TailscaleError,
  type TailscaleTransport,
  TransportRefusedError,
} from "./transport.ts";
import { parseWhoIs } from "./whois.ts";

export interface CliOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CliRunner = (argv: readonly string[], timeoutMs: number) => Promise<CliOutput>;

export interface CliOptions {
  command?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
  run?: CliRunner | undefined;
}

export const defaultCliCommand: readonly string[] = ["tailscale"];

export function cliTransport(options: CliOptions = {}): TailscaleTransport {
  const timeoutMs = options.timeoutMs ?? defaultRequestTimeoutMs;
  const run = options.run ?? spawnCli(options.command ?? defaultCliCommand);
  const json = async (argv: readonly string[]): Promise<string> =>
    succeeded(argv, await run(argv, timeoutMs)).stdout;
  return {
    name: "cli",
    status: async () => parseStatus(await json(["status", "--json"])),
    whois: async (host) => {
      const argv = ["whois", "--json", ipArgument(host)];
      const output = await run(argv, timeoutMs);
      if (output.exitCode !== 0 && peerNotFound(output)) return null;
      return parseWhoIs(succeeded(argv, output).stdout);
    },
    ping: (host, pingOptions) => ping(run, ipArgument(host), pingOptions),
    serve: async () => parseServeConfig(await json(["serve", "status", "--json"])),
  };
}

export function spawnCli(command: readonly string[]): CliRunner {
  const [file, ...prefix] = command;
  if (file === undefined) throw new TailscaleError("the tailscale CLI command is empty");
  return (argv, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        [...prefix, ...argv],
        { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error !== null && typeof error.code !== "number") {
            reject(spawnFailure(file, error));
            return;
          }
          resolve({ exitCode: error === null ? 0 : Number(error.code), stdout, stderr });
        },
      );
    });
}

async function ping(run: CliRunner, host: string, options?: PingOptions): Promise<PingResult> {
  const timeoutMs = options?.timeoutMs ?? defaultPingTimeoutMs;
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const argv = ["ping", "--c=1", "--until-direct=false", `--timeout=${seconds}s`, host];
  const output = await run(argv, timeoutMs + defaultRequestTimeoutMs);
  const result = parsePingOutput(output.stdout);
  if (result.ok || output.exitCode === 0) return result;
  return pingFailure(`${output.stderr}${output.stdout}`.trim() || `exit ${output.exitCode}`);
}

function ipArgument(host: string): string {
  if (!isIPAddress(host)) throw new TailscaleError(`not an IP address: ${JSON.stringify(host)}`);
  return host;
}

function succeeded(argv: readonly string[], output: CliOutput): CliOutput {
  if (output.exitCode === 0) return output;
  const detail = `${output.stderr}${output.stdout}`.trim();
  throw new TailscaleError(`tailscale ${argv.join(" ")} exited ${output.exitCode}: ${detail}`);
}

function peerNotFound(output: CliOutput): boolean {
  return /peer not found|no match/i.test(`${output.stderr}${output.stdout}`);
}

function spawnFailure(file: string, error: Error & { code?: unknown; killed?: boolean }): Error {
  if (error.code === "ENOENT" || error.code === "EACCES") {
    return new TransportRefusedError(`the tailscale CLI is not runnable at ${file}`, {
      cause: error,
    });
  }
  if (error.killed === true) return new TailscaleError(`tailscale timed out`, { cause: error });
  return new TailscaleError(`tailscale failed: ${error.message}`, { cause: error });
}
