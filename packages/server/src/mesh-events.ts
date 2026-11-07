import type {
  GrantEvent,
  MeshCensus,
  MeshListenerEvent,
  MeshPath,
  PairingEvent,
} from "@keywork/engine";
import type { EventLog } from "./events.ts";

type Change<Event extends { type: string }, Prefix extends string> = Event extends {
  type: `${Prefix}${infer Name}`;
}
  ? Omit<Event, "type"> & { change: Name }
  : never;

export type MeshListenerChange = Change<MeshListenerEvent, "mesh.listener.">;
export type MeshPairingChange = Change<PairingEvent, "mesh.pairing.">;
export type MeshPairChange = Change<PairingEvent, "mesh.pair.">;
export type MeshGrantChange = Change<GrantEvent, "mesh.grant.">;
export type MeshRevocationChange = Change<GrantEvent, "mesh.revocation.">;
export type MeshWalk = Omit<Extract<GrantEvent, { type: "mesh.tool.call" }>, "type">;

export interface MeshLane {
  stableId: string;
  path: MeshPath;
}

export interface MeshPeersChange {
  change: "lanes";
  peers: MeshLane[];
}

export interface LaneReading extends MeshLane {
  active?: boolean | undefined;
}

export interface LaneWatch {
  read(): Promise<readonly LaneReading[]>;
  changed(change: MeshPeersChange): void;
  everyMs?: number | undefined;
}

export const laneWatchEveryMs = 15_000;

export interface MeshEventSinks {
  listener(event: MeshListenerEvent): void;
  pairing(event: PairingEvent): void;
  grants(event: GrantEvent): void;
  lanes(change: MeshPeersChange): void;
}

export function meshEventsInto(log: Pick<EventLog, "record">): MeshEventSinks {
  return {
    listener: (event) => {
      const change = changeOf(event, "mesh.listener.");
      if (change !== undefined) log.record("", "mesh.listener", change as MeshListenerChange);
    },
    pairing: (event) => {
      const pairing = changeOf(event, "mesh.pairing.");
      if (pairing !== undefined) log.record("", "mesh.pairing", pairing as MeshPairingChange);
      const pair = changeOf(event, "mesh.pair.");
      if (pair !== undefined) log.record("", "mesh.pair", pair as MeshPairChange);
    },
    grants: (event) => {
      if (event.type === "mesh.tool.call") {
        const { type: _type, ...walk } = event;
        log.record("", "mesh.walked", walk);
        return;
      }
      const grant = changeOf(event, "mesh.grant.");
      if (grant !== undefined) log.record("", "mesh.grant", grant as MeshGrantChange);
      const revocation = changeOf(event, "mesh.revocation.");
      if (revocation !== undefined) {
        log.record("", "mesh.revocation", revocation as MeshRevocationChange);
      }
    },
    lanes: (change) => log.record("", "mesh.peers", change),
  };
}

export function lanesChanged(before: readonly MeshLane[], after: readonly MeshLane[]): MeshLane[] {
  const held = new Map(before.map((lane) => [lane.stableId, laneKey(lane.path)]));
  return after.filter((lane) => {
    const was = held.get(lane.stableId);
    return was !== undefined && was !== laneKey(lane.path);
  });
}

export function lanesHeldThroughIdle(
  held: readonly MeshLane[],
  read: readonly LaneReading[],
): MeshLane[] {
  const before = new Map(held.map((lane) => [lane.stableId, lane.path]));
  return read.map(({ stableId, path, active }) => {
    const kept = before.get(stableId);
    const idle = active === false && relayedKinds.has(path.kind) && kept !== undefined;
    return { stableId, path: idle ? kept : path };
  });
}

export function watchLanes(watch: LaneWatch): () => void {
  let held: readonly MeshLane[] | undefined;
  let reading = false;
  const look = async (): Promise<void> => {
    if (reading) return;
    reading = true;
    try {
      const now = lanesHeldThroughIdle(held ?? [], await watch.read());
      const moved = held === undefined ? [] : lanesChanged(held, now);
      held = now;
      if (moved.length > 0) watch.changed({ change: "lanes", peers: moved });
    } catch {
      return;
    } finally {
      reading = false;
    }
  };
  void look();
  const timer = setInterval(() => void look(), watch.everyMs ?? laneWatchEveryMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function settledCensus(take: () => Promise<MeshCensus>): Promise<MeshCensus> {
  const first = await take();
  return first.peers.some(isIdleOnRelay) ? take() : first;
}

// Tailscale drops a peer's CurAddr once it has carried no traffic for about 45 s, so an idle
// peer reads as relayed through its home region until a packet wakes the tunnel. A census
// probes every candidate peer, so the census taken after it reads the lane traffic takes.
export function isIdleOnRelay(peer: MeshCensus["peers"][number]): boolean {
  return peer.online && peer.candidate && !peer.active && relayedKinds.has(peer.path.kind);
}

const relayedKinds: ReadonlySet<MeshPath["kind"]> = new Set(["derp", "peer-relay"]);

function laneKey(path: MeshPath): string {
  switch (path.kind) {
    case "peer-relay":
      return `peer-relay ${path.relay}`;
    case "derp":
      return `derp ${path.region}`;
    default:
      return path.kind;
  }
}

function changeOf<Event extends { type: string }>(
  event: Event,
  prefix: string,
): (Omit<Event, "type"> & { change: string }) | undefined {
  if (!event.type.startsWith(prefix)) return undefined;
  const { type, ...fields } = event;
  return { ...fields, change: type.slice(prefix.length) };
}
