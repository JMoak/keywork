import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryAuditLog } from "../audit/log.ts";
import { admit, type MeshCaller } from "../listener/admission.ts";
import { screenUdpPorts } from "../listener/ports.ts";
import { acceptHelloReply, beginAttempt, confirmationOf } from "../pairing/initiator.ts";
import { loadDeviceKey, memoryKeyStore } from "../pairing/keys.ts";
import { selfIdentityOf } from "../pairing/self.ts";
import { isRefusal, pairingService } from "../pairing/service.ts";
import { filePairStore, memoryPairStore, type PairStore } from "../pairing/store.ts";
import { parseStatus } from "../transport/status.ts";
import { parseWhoIs, type WhoIs } from "../transport/whois.ts";
import { checkMeshPolicy } from "./check.ts";
import { policyReportLines } from "./words.ts";

// Recorded from the documented formats, not from a live Headscale: a Tailscale 1.104.1 client
// on a Headscale 0.29 control plane (users created with `headscale users create`, no OIDC).
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");

const status = parseStatus(fixture("headscale-status"));
const laptop = parseWhoIs(fixture("headscale-whois-laptop"));
const host = parseWhoIs(fixture("headscale-whois-host"));
const ports = { tcp: 47800, udp: screenUdpPorts };

const headscalePolicy = `{
  // Headscale names users with a trailing @ and has no autogroup:admin
  "tagOwners": { "tag:stead-host": ["keeper@"] },
  "grants": [
    { "src": ["keeper@"], "dst": ["keeper@", "tag:stead-host"], "ip": ["tcp:47800", "udp:47810-47829"] },
    { "src": ["tag:stead-host"], "dst": ["keeper@"], "ip": ["tcp:47800", "udp:47810-47829"] },
  ],
}`;

describe("a recorded Headscale control plane", () => {
  it("keys identity on decimal StableIDs and small user ids, not on login names", () => {
    expect(status.self?.stableId).toBe("1");
    expect(status.users["1"]).toEqual({ id: "1", loginName: "keeper", displayName: "keeper" });
    expect(status.peers.find(({ hostName }) => hostName === "host")?.tags).toEqual([
      "tag:stead-host",
    ]);
    expect(selfIdentityOf(status)).toEqual({
      stableId: "1",
      tailnetId: "stead.example",
      userId: "1",
      source: "magicdns",
    });
  });

  it("admits the tagged host without a human and the keeper's laptop with one", () => {
    expect(admit("100.64.0.2", host)).toMatchObject({
      admitted: true,
      caller: { human: null, node: { stableId: "2", tags: ["tag:stead-host"] } },
    });
    expect(host.user).toEqual({
      id: "2147455555",
      loginName: "tagged-devices",
      displayName: "Tagged Devices",
    });
    expect(admit("100.64.0.3", laptop)).toMatchObject({
      admitted: true,
      caller: { human: { userId: "1", loginName: "keeper" } },
    });
    expect(laptop.node.keyExpiry).toBe("0001-01-01T00:00:00Z");
    expect(laptop.capMap).toEqual({});
  });

  it("pairs the keeper's laptop as console with the login name blanked out", async () => {
    const reply = await pairOver(memoryPairStore(), withoutLoginName(laptop));
    expect(reply.state).toBe("paired");
    expect(reply.owner).toMatchObject({ tailnetId: "stead.example", userId: "1" });
    expect(selfIdentityOf(status)).toMatchObject({
      tailnetId: "stead.example",
      source: "magicdns",
    });
  });

  it("refuses the tagged host as a console because it carries no human", async () => {
    const service = await houseTarget(memoryPairStore());
    const { hello } = await consoleHello(callerOf(host));
    expect(await service.hello(callerOf(host), hello)).toMatchObject({ error: "needs-a-human" });
  });

  it("persists the owner although Headscale sends no tailnet StableID: the MagicDNS suffix stands in", async () => {
    const directory = mkdtempSync(join(tmpdir(), "keywork-headscale-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "pairing.json");
    const reply = await pairOver(filePairStore(file), laptop);
    expect(reply.state).toBe("paired");
    expect(filePairStore(file).read().owner).toMatchObject({ tailnetId: "stead.example" });
  });

  it("checks the stead ports with Headscale user selectors and flags what Headscale lacks", () => {
    const report = checkMeshPolicy({ text: headscalePolicy, status, ports });
    expect(report.controlPlane).toBe("headscale");
    expect(report.snippet).toBeNull();
    expect(policyReportLines(report)[0]).toBe(
      "policy: stead ports tcp 47800 and udp 47810-47829 on a Headscale (self-hosted) control plane, the house and 2 parcels",
    );
    const tailscaleStyle = checkMeshPolicy({
      text: `{ "tagOwners": { "tag:stead-host": ["autogroup:admin"] }, "postures": {},
        "grants": [{ "src": ["keeper@example.com"], "dst": ["*"], "ip": ["*"], "srcPosture": ["posture:min"] }] }`,
      status,
      ports,
    });
    expect(tailscaleStyle.cautions).toEqual([
      "grants[0] sets srcPosture, which Headscale does not support",
      "the policy defines postures, which Headscale does not support",
      "tagOwners for tag:stead-host names autogroup:admin, which Headscale does not know; name the keeper as user@ or a group instead",
    ]);
    expect(tailscaleStyle.snippet?.grants).toContainEqual({
      src: ["keeper@"],
      dst: ["keeper@"],
      ip: ["tcp:47800", "udp:47810-47829"],
    });
  });
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function houseTarget(store: PairStore) {
  const keys = memoryKeyStore();
  return pairingService({
    deviceKey: await loadDeviceKey(keys),
    keys,
    store,
    audit: memoryAuditLog(),
    self: async () => selfIdentityOf(status),
  });
}

async function consoleHello(caller: MeshCaller) {
  const consoleKey = await loadDeviceKey(memoryKeyStore());
  return beginAttempt({
    role: "console",
    caps: ["exec"],
    selfStableId: caller.node.stableId,
    targetStableId: "1",
    deviceKey: consoleKey.publicKey,
  });
}

async function pairOver(store: PairStore, whois: WhoIs) {
  const service = await houseTarget(store);
  const caller = callerOf(whois);
  const { attempt, hello } = await consoleHello(caller);
  const greeted = await service.hello(caller, hello);
  if (isRefusal(greeted)) throw new Error(greeted.error);
  const consoleSide = acceptHelloReply(attempt, greeted);
  await service.reveal(caller, greeted.pairingId, { nonce: attempt.nonce });
  await service.confirmOnDevice(greeted.pairingId, consoleSide.sas ?? "");
  const reply = await service.confirm(caller, greeted.pairingId, confirmationOf(consoleSide));
  if (isRefusal(reply)) throw new Error(reply.error);
  return { state: reply.state, owner: service.owner() };
}

function callerOf(whois: WhoIs): MeshCaller {
  const admission = admit(whois.node.addresses[0] ?? "", whois);
  if (!admission.admitted) throw new Error(admission.detail);
  return admission.caller;
}

function withoutLoginName(whois: WhoIs): WhoIs {
  return { ...whois, user: { ...whois.user, loginName: "" } };
}
