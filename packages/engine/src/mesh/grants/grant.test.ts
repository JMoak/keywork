import { describe, expect, it } from "vitest";
import { type DeviceKey, loadDeviceKey, memoryKeyStore } from "../pairing/keys.ts";
import type { PairRecord } from "../pairing/store.ts";
import {
  hostNode,
  houseNode,
  keeperId,
  strangerId,
  taggedNode,
  tailnetId,
} from "../pairing/testing/identities.ts";
import { type ChainContext, type GrantDraft, signGrant, verifyGrantChain } from "./grant.ts";
import { signRevocation, verifyRevocation } from "./revocation.ts";

const t0 = Date.parse("2026-11-05T12:00:00Z");
const hour = 60 * 60_000;

const draft: GrantDraft = {
  subject: { creature: "pip", node: houseNode.stableId },
  target: hostNode.stableId,
  caps: [{ kind: "exec", commands: ["echo"] }],
  expiresAt: new Date(t0 + hour).toISOString(),
};

function consolePair(key: DeviceKey, overrides: Partial<PairRecord> = {}): PairRecord {
  return {
    id: "pair-console",
    peerStableId: houseNode.stableId,
    peerUserId: keeperId,
    peerTags: [],
    peerDeviceKey: key.publicKey,
    role: "console",
    caps: [],
    endpoint: null,
    createdAt: new Date(t0).toISOString(),
    confirmedBy: "on-device",
    ...overrides,
  };
}

async function chain(overrides: Partial<PairRecord> = {}, context: Partial<ChainContext> = {}) {
  const key = await loadDeviceKey(memoryKeyStore());
  const base: ChainContext = {
    self: hostNode.stableId,
    owner: { tailnetId, userId: keeperId, claimedAt: "" },
    pairs: [consolePair(key, overrides)],
    now: t0,
    revoked: () => false,
    ...context,
  };
  return { key, context: base };
}

describe("the grant signature chain", () => {
  it("verifies a grant signed by a paired console of the owner", async () => {
    const { key, context } = await chain();
    const grant = signGrant(draft, houseNode.stableId, key, t0);
    expect(verifyGrantChain(grant, context)).toEqual({ valid: grant, issuer: context.pairs[0] });
  });

  it("refuses a grant whose body changed after signing", async () => {
    const { key, context } = await chain();
    const grant = signGrant(draft, houseNode.stableId, key, t0);
    const widened = { ...grant, caps: [{ kind: "exec", commands: ["echo", "rm"] }] };
    expect(verifyGrantChain(widened, context)).toEqual({ failure: "bad-signature" });
    const moved = { ...grant, subject: { creature: "other", node: houseNode.stableId } };
    expect(verifyGrantChain(moved, context)).toEqual({ failure: "bad-signature" });
  });

  it("refuses a grant signed by any key but the paired console's", async () => {
    const { context } = await chain();
    const stranger = await loadDeviceKey(memoryKeyStore());
    expect(verifyGrantChain(signGrant(draft, houseNode.stableId, stranger, t0), context)).toEqual({
      failure: "bad-signature",
    });
  });

  it.each([
    ["an unpaired issuer", { peerStableId: taggedNode.stableId }, {}, "unknown-issuer"],
    [
      "a paired node that is not a console",
      { role: "node" as const },
      {},
      "issuer-not-owner-console",
    ],
    ["a console of a second human", { peerUserId: strangerId }, {}, "issuer-not-owner-console"],
    ["an unclaimed target", {}, { owner: null }, "issuer-not-owner-console"],
    ["another target", {}, { self: taggedNode.stableId }, "wrong-target"],
    ["an expired grant", {}, { now: t0 + hour }, "expired"],
    ["a grant from the future", {}, { now: t0 - 2 * 60_000 }, "not-yet-valid"],
    ["a revoked grant", {}, { revoked: () => true }, "revoked"],
  ] as const)("refuses %s", async (_name, pair, context, failure) => {
    const signed = await chain(pair, context);
    const grant = signGrant(draft, houseNode.stableId, signed.key, t0);
    expect(verifyGrantChain(grant, signed.context)).toEqual({ failure });
  });

  it("refuses malformed caps and long screen control", async () => {
    const { key, context } = await chain();
    const globbed = signGrant(
      { ...draft, caps: [{ kind: "exec", commands: ["echo *"] }] },
      houseNode.stableId,
      key,
      t0,
    );
    expect(verifyGrantChain(globbed, context)).toEqual({ failure: "malformed" });
    const chained = signGrant(
      { ...draft, caps: [{ kind: "exec", commands: ["echo; rm"] }] },
      houseNode.stableId,
      key,
      t0,
    );
    expect(verifyGrantChain(chained, context)).toEqual({ failure: "malformed" });
    const screen = signGrant(
      {
        ...draft,
        caps: [{ kind: "screen:control" }],
        expiresAt: new Date(t0 + 2 * hour).toISOString(),
      },
      houseNode.stableId,
      key,
      t0,
    );
    expect(verifyGrantChain(screen, context)).toEqual({ failure: "screen-control-too-long" });
  });

  it("verifies revocations through the same chain", async () => {
    const { key, context } = await chain();
    const revocation = signRevocation(
      { kind: "grant", id: "grant-1", target: hostNode.stableId },
      houseNode.stableId,
      key,
      t0,
    );
    expect(verifyRevocation(revocation, context)).toMatchObject({ valid: revocation });
    expect(verifyRevocation({ ...revocation, id: "grant-2" }, context)).toEqual({
      failure: "bad-signature",
    });
    expect(verifyRevocation({ ...revocation, extra: 1 }, context)).toEqual({
      failure: "malformed",
    });
  });
});
