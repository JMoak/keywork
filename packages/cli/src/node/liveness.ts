import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { generation } from "./logs.ts";
import type { NodeFile, UnitState, UnitView } from "./node-file.ts";

export type UnitVerdict = "running" | "stale" | "as-recorded";

export interface UnitCheck {
  recorded: UnitState;
  pidAlive: boolean | null;
  portAnswers: boolean | null;
  verdict: UnitVerdict;
}

export interface Endpoint {
  host: string;
  port: number;
}

export type Answers = (host: string, port: number) => Promise<boolean>;

export interface LivenessProbe {
  isAlive: (pid: number) => boolean;
  answers?: Answers | undefined;
}

export type UnitChecker = (
  unit: Pick<UnitView, "state" | "pid">,
  endpoints: readonly Endpoint[],
) => Promise<UnitCheck>;

export function unitChecker({ isAlive, answers = tcpAnswers }: LivenessProbe): UnitChecker {
  return async (unit, endpoints) => {
    if (unit.state !== "running") {
      return { recorded: unit.state, pidAlive: null, portAnswers: null, verdict: "as-recorded" };
    }
    const pidAlive = unit.pid === null ? null : isAlive(unit.pid);
    const portAnswers =
      pidAlive === false || endpoints.length === 0 ? null : await anyAnswers(endpoints, answers);
    const verdict = pidAlive === false || portAnswers === false ? "stale" : "running";
    return { recorded: unit.state, pidAlive, portAnswers, verdict };
  };
}

export async function recordedNodeRunning(
  node: NodeFile,
  nodeLog: string,
  probe: LivenessProbe,
): Promise<boolean> {
  const answering = node.core.state === "running" ? coreEndpoints(node, nodeLog) : [];
  return (await unitChecker(probe)(node, answering)).verdict === "running";
}

export function coreEndpoints(node: NodeFile, nodeLog: string): Endpoint[] {
  return meshEndpoints(node, boundAddresses(nodeLog, coreStart(node)));
}

async function anyAnswers(endpoints: readonly Endpoint[], answers: Answers): Promise<boolean> {
  const replies = await Promise.all(endpoints.map(({ host, port }) => answers(host, port)));
  return replies.includes(true);
}

export function meshEndpoints(node: NodeFile, addresses: readonly string[]): Endpoint[] {
  const port = node.ports.mesh;
  return port === null ? [] : addresses.map((host) => ({ host, port }));
}

export function tcpAnswers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const settle = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(probeTimeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

const probeTimeoutMs = 750;

export function coreStart(node: NodeFile): string {
  return node.core.since ?? node.startedAt;
}

export function boundAddresses(nodeLog: string, since: string): string[] {
  const bound = new Set<string>();
  for (const event of listenerEventsSince(nodeLog, since)) {
    if (event.type === "mesh.listener.bound") bound.add(event.address);
    else bound.delete(event.address);
  }
  return [...bound];
}

interface ListenerEvent {
  type: "mesh.listener.bound" | "mesh.listener.unbound";
  address: string;
}

function listenerEventsSince(nodeLog: string, since: string): ListenerEvent[] {
  return [generation(nodeLog, 1), nodeLog]
    .flatMap(logLinesOf)
    .flatMap((line) => listenerEventOf(line, since) ?? []);
}

function logLinesOf(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
}

function listenerEventOf(line: string, since: string): ListenerEvent | undefined {
  const record = parsed(line);
  if (typeof record?.at !== "string" || record.at < since) return undefined;
  if (typeof record.line !== "string" || !record.line.startsWith(meshPrefix)) return undefined;
  const event = parsed(record.line.slice(meshPrefix.length));
  if (typeof event?.address !== "string") return undefined;
  if (event.type !== "mesh.listener.bound" && event.type !== "mesh.listener.unbound") {
    return undefined;
  }
  return { type: event.type, address: event.address };
}

const meshPrefix = "mesh: ";

function parsed(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
