import { describe, expect, it } from "vitest";
import { memoryAuditLog, verifyAuditChain } from "./log.ts";
import { type ScreenAuditRecord, screenAuditEntry, screenAuditRecordSchema } from "./screen.ts";

const keeper = {
  stableId: "nSparkStable1",
  name: "spark-ad4d",
  userId: "u-keeper",
  loginName: "jordan@example.com",
  tags: [],
};

const session: ScreenAuditRecord = {
  kind: "session",
  sessionId: "session-1",
  grantId: "grant-view",
  controlGrantId: "grant-control",
  peer: keeper,
  controller: "human",
  scopes: ["view", "control"],
  displays: ["2528732444"],
  path: "direct",
  startedAt: "2026-11-06T09:00:00.000Z",
  endedAt: "2026-11-06T09:12:00.000Z",
  reason: "kill-switch",
  inputs: { pointer: 120, keys: 14 },
};

describe("screen audit records", () => {
  it("chain a finished control session as a screen:control row naming grant, scopes and input counts", async () => {
    const audit = memoryAuditLog();
    const row = await audit.append(screenAuditEntry(session, "nMoakMain"));
    expect(row).toMatchObject({
      actorStableID: "nSparkStable1",
      actorUserID: "u-keeper",
      targetStableID: "nMoakMain",
      capability: "screen:control",
      decision: "allow",
    });
    expect(row.reason).toBe(
      "view and control by jordan@example.com on spark-ad4d · grant grant-view, control grant-control · displays 2528732444 · direct · 2026-11-06T09:00:00.000Z to 2026-11-06T09:12:00.000Z · ended: kill-switch · 120 pointer, 14 keys",
    );
    expect(verifyAuditChain(await audit.rows())).toMatchObject({ intact: true, rows: 1 });
  });

  it("keep a view-only session a screen:view row", () => {
    const viewOnly: ScreenAuditRecord = {
      ...session,
      controlGrantId: undefined,
      scopes: ["view"],
      inputs: { pointer: 0, keys: 0 },
    };
    expect(screenAuditEntry(viewOnly, "nMoakMain").capability).toBe("screen:view");
  });

  it("record a refused agent control request as a deny row in words", () => {
    const refused = screenAuditEntry(
      {
        kind: "control",
        sessionId: "session-2",
        grantId: "grant-view",
        peer: { stableId: "nWorkshop", name: "otter-shop", userId: null, tags: ["tag:workshop"] },
        controller: "agent",
        decision: "deny",
        reason: "a creature may control only its own workshop's display, never a keeper's desktop",
      },
      "nMoakMain",
    );
    expect(refused).toMatchObject({ capability: "screen:control", decision: "deny" });
    expect(refused.reason).toContain(
      "control refused to an agent as a tagged device on otter-shop",
    );
    expect(refused.reason).toContain("never a keeper's desktop");
  });

  it("refuse a record that is not one", () => {
    expect(screenAuditRecordSchema.safeParse({ ...session, scopes: [] }).success).toBe(false);
    expect(screenAuditRecordSchema.safeParse({ ...session, extra: 1 }).success).toBe(false);
    expect(
      screenAuditRecordSchema.safeParse({ ...session, inputs: { pointer: -1, keys: 0 } }).success,
    ).toBe(false);
  });
});
