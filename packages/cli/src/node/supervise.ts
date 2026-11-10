import { acquireRuntimeOwnership, type Clock } from "@keywork/engine";
import { contractVersion } from "@keywork/server";
import type { NodeConfig } from "./config.ts";
import {
  deskLogTailLines,
  nodeStoppedItem,
  readStoppedItem,
  resetCommand,
  writeStoppedItem,
} from "./desk.ts";
import { type Answers, recordedNodeRunning } from "./liveness.ts";
import { lifecycleLogRotation, nodeLogRotation, RotatingLog, tailLines } from "./logs.ts";
import type { Machine } from "./machine.ts";
import {
  type NodeFile,
  type NodeFileStore,
  type NodeState,
  type NodeStop,
  nodeFileSchema,
  nodeFileStore,
  type UnitView,
} from "./node-file.ts";
import type { NodePaths } from "./paths.ts";
import { type ParkingPolicy, type ServedSource, Serving } from "./serving.ts";
import {
  type ProcessSpawner,
  type SupervisionPolicy,
  Supervisor,
  type SupervisorEvent,
  type SupervisorOutcome,
  type UnitSpec,
  type UnitStatus,
} from "./supervisor.ts";
import type { WorkspaceUnit } from "./units.ts";

export interface SuperviseOptions {
  paths: NodePaths;
  config: NodeConfig;
  core: UnitSpec;
  workspaces: readonly WorkspaceUnit[];
  machine: Machine;
  version: string;
  contract?: string;
  pid: number;
  clock: Clock;
  spawn: ProcessSpawner;
  isAlive: (pid: number) => boolean;
  answers?: Answers | undefined;
  signal: AbortSignal;
  say: (line: string) => void;
  policy?: Partial<SupervisionPolicy> | undefined;
  served?: ServedSource | undefined;
  parking?: Partial<ParkingPolicy> | undefined;
  admit?: () => Promise<boolean>;
}

export const superviseExit = { ran: 0, alreadyRunning: 1, admissionRefused: 3 } as const;

export async function superviseNode(options: SuperviseOptions): Promise<number> {
  const ownership = await acquireRuntimeOwnership(options.paths.ownership);
  if (ownership === undefined) {
    const pid = nodeFileStore(options.paths.nodeFile).read()?.pid;
    options.say(
      pid === undefined || pid === null
        ? "a node is already starting here; keywork node status shows it"
        : `a node is already running here as pid ${pid}; keywork node status shows it`,
    );
    return superviseExit.alreadyRunning;
  }
  try {
    if (options.admit !== undefined && !(await options.admit()))
      return superviseExit.admissionRefused;
    return await runOwnedNode(options);
  } finally {
    ownership.release();
  }
}

async function runOwnedNode(options: SuperviseOptions): Promise<number> {
  const journal = openJournal(options);
  if (heldAfterCrashLoop(options, journal)) return superviseExit.ran;
  if (await anotherSupervisorAlive(options, journal)) return superviseExit.alreadyRunning;
  const startedAt = options.clock.now();
  let serving: Serving | undefined;
  const publish = (
    units: ReadonlyMap<string, UnitStatus>,
    state: NodeState,
    stopped: NodeStop | null,
  ) =>
    journal.nodeFile.write(
      nodeFileOf({
        ...options,
        workspaces: serving?.workspaces() ?? options.workspaces,
        startedAt,
        now: options.clock.now(),
        units,
        state,
        stopped,
      }),
    );
  const supervisor = new Supervisor({
    units: [options.core, ...options.workspaces.map((unit) => unit.spec)],
    spawn: options.spawn,
    clock: options.clock,
    policy: options.policy,
    onLine: (unit, stream, line) => journal.line({ unit, stream, line }),
    onEvent: (event) => {
      journal.note({ ...event });
      options.say(eventLine(event));
    },
    onChange: (units) => publish(units, "running", null),
  });
  journal.note({
    event: "supervisor.started",
    pid: options.pid,
    version: options.version,
    units: [...supervisor.status().keys()],
  });
  serving = servingOf(options, supervisor);
  publish(supervisor.status(), "running", null);
  const running = supervisor.run(options.signal);
  const stopServing = serving?.start();
  const outcome = await running;
  stopServing?.();
  const stopped =
    outcome.ended === "crash-loop"
      ? leaveDeskItem(options, journal, outcome)
      : { at: isoAt(options.clock), reason: "asked to stop", item: null };
  publish(supervisor.status(), "stopped", stopped);
  return superviseExit.ran;
}

export function eventLine(event: SupervisorEvent): string {
  switch (event.event) {
    case "unit.started":
      return `${event.unit}: started${event.pid === null ? "" : ` as pid ${event.pid}`}`;
    case "unit.adopted":
      return `${event.unit}: already served by another keywork; checking again in ${event.recheckMs / 1000} s`;
    case "unit.spawn-failed":
      return `${event.unit}: could not start: ${event.error}`;
    case "unit.exited":
      return `${event.unit}: exited ${event.signal ?? event.code ?? "without a code"}`;
    case "unit.backoff":
      return `${event.unit}: restarting in ${event.delayMs / 1000} s (attempt ${event.attempt})`;
    case "unit.added":
      return `${event.unit}: now served`;
    case "unit.removed":
      return `${event.unit}: no longer served; its server stopped`;
    case "unit.parked":
      return `${event.unit}: parked after an hour with no console, creature or chore; the next open starts it again`;
    case "unit.woken":
      return `${event.unit}: opened again; starting`;
    case "supervisor.crash-loop":
      return `supervisor: ${event.reason}; stopping every unit`;
    case "supervisor.stopping":
      return event.because === "asked"
        ? "supervisor: stopping"
        : "supervisor: stopping after a crash loop";
    case "supervisor.stopped":
      return "supervisor: stopped";
  }
}

function servingOf(options: SuperviseOptions, supervisor: Supervisor): Serving | undefined {
  if (options.served === undefined) return undefined;
  return new Serving({
    supervisor,
    source: options.served,
    workspaces: options.workspaces,
    clock: options.clock,
    isAlive: options.isAlive,
    say: options.say,
    policy: options.parking,
  });
}

interface Journal {
  nodeFile: NodeFileStore;
  note(record: Record<string, unknown>): void;
  line(fields: Record<string, unknown>): void;
}

function openJournal(options: SuperviseOptions): Journal {
  const lifecycle = new RotatingLog(options.paths.lifecycleLog, lifecycleLogRotation);
  const nodeLog = new RotatingLog(options.paths.nodeLog, nodeLogRotation);
  return {
    nodeFile: nodeFileStore(options.paths.nodeFile),
    note: (record) => lifecycle.append({ at: isoAt(options.clock), ...record }),
    line: (fields) => nodeLog.append({ at: isoAt(options.clock), ...fields }),
  };
}

function heldAfterCrashLoop(options: SuperviseOptions, journal: Journal): boolean {
  const held = readStoppedItem(options.paths.stoppedItem);
  if (held === undefined) return false;
  journal.note({ event: "supervisor.held", reason: held.reason, since: held.at });
  options.say(`${held.title} at ${held.at} (${held.reason}); ${resetCommand} starts it again`);
  return true;
}

async function anotherSupervisorAlive(
  options: SuperviseOptions,
  journal: Journal,
): Promise<boolean> {
  const recorded = journal.nodeFile.read();
  if (recorded === undefined || recorded.pid === null || recorded.pid === options.pid) return false;
  if (!(await recordedNodeRunning(recorded, options.paths.nodeLog, options))) return false;
  options.say(
    `a node is already running here as pid ${recorded.pid}; keywork node status shows it`,
  );
  return true;
}

function leaveDeskItem(
  options: SuperviseOptions,
  journal: Journal,
  outcome: Extract<SupervisorOutcome, { ended: "crash-loop" }>,
): NodeStop {
  const item = nodeStoppedItem({
    machine: options.machine,
    at: options.clock.now(),
    reason: outcome.reason,
    crashes: outcome.crashes,
    logTail: tailLines(options.paths.nodeLog, deskLogTailLines),
  });
  writeStoppedItem(options.paths.stoppedItem, item);
  journal.note({
    event: "supervisor.desk-item",
    item: options.paths.stoppedItem,
    title: item.title,
  });
  options.say(`${item.title}: ${item.reason}; ${item.next}`);
  return { at: item.at, reason: outcome.reason, item: options.paths.stoppedItem };
}

function isoAt(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}

interface NodeFileFacts extends SuperviseOptions {
  startedAt: number;
  now: number;
  units: ReadonlyMap<string, UnitStatus>;
  state: NodeState;
  stopped: NodeStop | null;
}

function nodeFileOf(facts: NodeFileFacts): NodeFile {
  const viewOf = (name: string): UnitView => unitView(facts.units.get(name));
  return {
    schema: nodeFileSchema,
    state: facts.state,
    version: facts.version,
    contract: facts.contract ?? contractVersion,
    machine: facts.machine,
    pid: facts.state === "running" ? facts.pid : null,
    startedAt: new Date(facts.startedAt).toISOString(),
    updatedAt: new Date(facts.now).toISOString(),
    ports: facts.config.mesh.enabled
      ? { mesh: facts.config.mesh.port, screenUdp: facts.config.mesh.screenUdp }
      : { mesh: null, screenUdp: null },
    workspaces: facts.workspaces.map((unit) => ({
      cwd: unit.workspace.cwd,
      slug: unit.workspace.slug,
      identity: unit.identity,
      ticket: unit.ticket,
      url: facts.units.get(unit.spec.name)?.url ?? null,
      ...viewOf(unit.spec.name),
    })),
    core: viewOf(facts.core.name),
    logs: { node: facts.paths.nodeLog, lifecycle: facts.paths.lifecycleLog },
    stopped: facts.stopped,
  };
}

function unitView(status: UnitStatus | undefined): UnitView {
  if (status === undefined) return { state: "stopped", pid: null, restarts: 0, since: null };
  return {
    state: status.state,
    pid: status.pid,
    restarts: status.restarts,
    since: status.since === null ? null : new Date(status.since).toISOString(),
  };
}
