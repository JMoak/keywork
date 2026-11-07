import type { MeshCaller } from "../../listener/admission.ts";
import { recordedHost, recordedHouse, recordedKeeper } from "../../transport/testing/recorded.ts";
import type { WhoIs } from "../../transport/whois.ts";
import type { PairingCaller, SelfIdentity } from "../machine.ts";

export const tailnetId = "TSteadE5f6CNTRL";
export const keeperId = recordedKeeper.userId;
export const strangerId = "7000000000000002";

export interface TestNode {
  stableId: string;
  name: string;
  address: string;
  tags: readonly string[];
  userId: string | null;
}

export const houseNode: TestNode = {
  stableId: recordedHouse.stableId,
  name: "house",
  address: recordedHouse.ipv4,
  tags: [],
  userId: keeperId,
};

export const hostNode: TestNode = {
  stableId: recordedHost.stableId,
  name: "host",
  address: recordedHost.ipv4,
  tags: [],
  userId: keeperId,
};

export const taggedNode: TestNode = {
  stableId: "nTaggedE7f8CNTRL",
  name: "spare",
  address: "100.77.66.55",
  tags: ["tag:stead-host"],
  userId: null,
};

export function selfOf(node: TestNode): SelfIdentity {
  return { stableId: node.stableId, tailnetId, userId: node.userId, source: "stable-id" };
}

export function callerOf(node: TestNode, userId: string | null = node.userId): MeshCaller {
  return {
    address: node.address,
    node: { stableId: node.stableId, name: node.name, os: "linux", tags: [...node.tags] },
    human:
      userId === null
        ? null
        : { userId, loginName: `${userId}@example.com`, displayName: "Someone" },
    capMap: {},
  };
}

export function pairingCaller(node: TestNode, userId: string | null = node.userId): PairingCaller {
  return { stableId: node.stableId, userId, tags: node.tags };
}

export function whoisOf(node: TestNode): WhoIs {
  return {
    node: {
      stableId: node.stableId,
      name: `${node.name}.tail5e7d00.ts.net.`,
      computedName: node.name,
      os: "linux",
      userId: node.userId ?? "7000000000000099",
      sharerId: null,
      addresses: [node.address],
      tags: [...node.tags],
      online: true,
      expired: false,
      keyExpiry: null,
    },
    user: {
      id: node.userId ?? "7000000000000099",
      loginName: node.userId === null ? "tagged-devices" : "keeper@example.com",
      displayName: node.userId === null ? "Tagged Devices" : "Keeper",
    },
    capMap: {},
  };
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<Item>(random: () => number, items: readonly Item[]): Item {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new RangeError("pick from an empty list");
  return item;
}
