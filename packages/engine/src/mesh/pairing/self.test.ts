import { describe, expect, it } from "vitest";
import { parseStatus } from "../transport/status.ts";
import { recordedText } from "../transport/testing/recorded.ts";
import { SelfUnknownError, selfIdentityOf } from "./self.ts";

const status = parseStatus(recordedText("status-running"));

describe("selfIdentityOf", () => {
  it("reads this node's StableID, its tailnet and its human from tailscale status", () => {
    const self = status.self;
    if (self === null || status.tailnet === null) throw new Error("the fixture has no Self");
    expect(selfIdentityOf(status)).toEqual({
      stableId: self.stableId,
      tailnetId: status.tailnet.stableId,
      userId: self.userId,
      source: "stable-id",
    });
  });

  it("falls back to the MagicDNS suffix when the control plane sends no tailnet StableID, and says so", () => {
    if (status.tailnet === null) throw new Error("the fixture has no tailnet");
    const headscale = { ...status, tailnet: { ...status.tailnet, stableId: "" } };
    expect(selfIdentityOf(headscale)).toMatchObject({
      tailnetId: status.tailnet.magicDNSSuffix,
      source: "magicdns",
    });
    const nameless = { ...headscale, tailnet: { ...headscale.tailnet, magicDNSSuffix: "" } };
    expect(() => selfIdentityOf(nameless)).toThrow(SelfUnknownError);
  });

  it("names a tailnet for every recorded status, so a pair store can keep the owner", () => {
    for (const name of ["status-running", "status-direct"] as const) {
      const identity = selfIdentityOf(parseStatus(recordedText(name)));
      expect(identity.tailnetId.length, name).toBeGreaterThan(0);
    }
  });

  it("carries no human for a tagged node", () => {
    const self = status.self;
    if (self === null) throw new Error("the fixture has no Self");
    const tagged = { ...status, self: { ...self, tags: ["tag:stead-host"] } };
    expect(selfIdentityOf(tagged).userId).toBeNull();
  });

  it("refuses a status without Self or tailnet instead of guessing", () => {
    expect(() => selfIdentityOf({ ...status, self: null })).toThrow(SelfUnknownError);
    expect(() => selfIdentityOf({ ...status, tailnet: null })).toThrow(SelfUnknownError);
  });
});
