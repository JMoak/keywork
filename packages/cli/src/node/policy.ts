import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import {
  checkMeshPolicy,
  createTailnet,
  defaultTransport,
  filePairStore,
  isPolicyOpen,
  meshPairingFile,
  PolicyTextError,
  policyReportLines,
  type TailnetStatus,
} from "@keywork/engine";
import { type CommandIo, resolveCommandIo } from "../command-io.ts";
import { exitCodes } from "../dispatch.ts";
import { readNodeConfig } from "./config.ts";
import { nodePaths } from "./paths.ts";

export const nodePolicyUsage =
  "usage: keywork node policy check [--file <policy.hujson>]   (without --file, paste the policy on stdin)";

export interface NodePolicyDeps {
  userRoot: string;
  status(): Promise<TailnetStatus>;
  pairedStableIds(stateDir: string): string[];
  readFile(path: string): string;
  readStdin(): Promise<string>;
}

export async function nodePolicyCommand(
  args: readonly string[],
  overrides: Partial<NodePolicyDeps> = {},
  io: CommandIo = {},
): Promise<number> {
  const out = resolveCommandIo(io);
  const parsed = parsePolicyArgs(args);
  if (typeof parsed === "string") {
    out.printError(`keywork node policy: ${parsed}\n\n${nodePolicyUsage}`);
    return exitCodes.usage;
  }
  const deps = { ...systemPolicyDeps(), ...overrides };
  const paths = nodePaths(deps.userRoot);
  const text = await policyText(deps, parsed.file, out.printError);
  if (text === undefined) return exitCodes.usage;
  const status = await tailnetStatus(deps, out.printError);
  if (status === undefined) return exitCodes.unresolved;
  const { mesh } = readNodeConfig(paths.config);
  try {
    const report = checkMeshPolicy({
      text,
      status,
      ports: { tcp: mesh.port, udp: mesh.screenUdp },
      paired: deps.pairedStableIds(paths.state),
    });
    for (const line of policyReportLines(report)) out.print(line);
    return isPolicyOpen(report) ? exitCodes.completed : exitCodes.failed;
  } catch (cause) {
    if (!(cause instanceof PolicyTextError)) throw cause;
    out.printError(`keywork node policy check: ${cause.message}`);
    return exitCodes.usage;
  }
}

export function systemPolicyDeps(): NodePolicyDeps {
  return {
    userRoot: homedir(),
    status: () => createTailnet(defaultTransport()).status(),
    pairedStableIds,
    readFile: (path) => readFileSync(path, "utf8"),
    readStdin: () => new Response(Bun.stdin.stream()).text(),
  };
}

function pairedStableIds(stateDir: string): string[] {
  try {
    return filePairStore(meshPairingFile(stateDir))
      .read()
      .pairs.map(({ peerStableId }) => peerStableId);
  } catch {
    return [];
  }
}

async function policyText(
  deps: NodePolicyDeps,
  file: string | undefined,
  printError: (line: string) => void,
): Promise<string | undefined> {
  try {
    const text = file === undefined ? await deps.readStdin() : deps.readFile(file);
    if (text.trim() !== "") return text;
    printError("keywork node policy check: the policy is empty; paste it on stdin or pass --file");
  } catch (cause) {
    printError(
      `keywork node policy check: cannot read ${file ?? "stdin"}: ${(cause as Error).message}`,
    );
  }
  return undefined;
}

async function tailnetStatus(
  deps: NodePolicyDeps,
  printError: (line: string) => void,
): Promise<TailnetStatus | undefined> {
  try {
    return await deps.status();
  } catch (cause) {
    printError(
      `keywork node policy check: tailscale status failed (${(cause as Error).message}); start Tailscale and try again`,
    );
    return undefined;
  }
}

function parsePolicyArgs(args: readonly string[]): { file: string | undefined } | string {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { file: { type: "string" } },
    });
    const [verb, ...extra] = positionals;
    if (verb !== "check") return verb === undefined ? "name what to do" : `unknown verb "${verb}"`;
    if (extra.length > 0) return `unexpected ${extra.join(" ")}`;
    return { file: values.file };
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}
