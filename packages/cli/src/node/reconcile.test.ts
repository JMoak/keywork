import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filePairStore, meshPairingFile } from "../../../engine/src/mesh/pairing/store.ts";
import { RoutineHarness, routineInput } from "../../../engine/src/routines/testing.ts";
import { fileClaimDesk } from "./compose.ts";
import { type ClaimDesk, groupedClaimCode, reconcileLines, reconcileOnStart } from "./reconcile.ts";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "keywork-node-reconcile-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("reconcile on start: routines", () => {
  let harness: RoutineHarness;

  afterEach(async () => {
    await harness.close();
  });

  it("replays the scheduler's catch-up contract: the interrupted run settles, one missed slot is paced in", async () => {
    harness = await RoutineHarness.create({ start: Date.parse("2026-11-05T08:00:00Z") });
    await harness.writeRoutine(
      routineInput({ trigger: { kind: "cron", expr: "0 * * * *", tz: "UTC" } }),
    );
    await harness.service.start();
    await harness.advanceTo(Date.parse("2026-11-05T09:01:00Z"));
    expect(harness.runner.started).toHaveLength(1);
    harness.service.stop();
    await harness.clock.advanceTo(Date.parse("2026-11-05T13:10:00Z"), async () => {});

    const report = await reconcileOnStart({
      routines: { start: () => harness.restart() },
      headless: false,
    });

    expect(report.routines).toEqual({ kind: "started" });
    const runs = harness.store.runs("wren", "triage", 50);
    expect(runs.find((run) => run.firedAt === "2026-11-05T09:00:00.000Z")).toMatchObject({
      process: "failed",
      reason: "the node stopped during the run",
    });
    expect(harness.runner.started).toHaveLength(1);
    await harness.advance(30_000);
    expect(harness.runner.started).toHaveLength(2);
    expect(harness.runner.last().request.prompt).toContain(
      "a catch-up for a run missed while the node was down",
    );
    expect(runs.filter((run) => run.status === "skipped").map((run) => run.firedAt)).toEqual([
      "2026-11-05T12:00:00.000Z",
      "2026-11-05T11:00:00.000Z",
      "2026-11-05T10:00:00.000Z",
    ]);
  });
});

describe("reconcile on start: workshops", () => {
  it("restarts the workshops that were running and names the ones that would not", async () => {
    const restarted = await reconcileOnStart({
      workshops: {
        restartRunning: async () => [{ refused: "unavailable", error: "sbx is not installed" }],
      },
      headless: false,
    });
    expect(restarted.workshops).toEqual({
      kind: "restarted",
      refused: [{ refused: "unavailable", error: "sbx is not installed" }],
    });
    expect(reconcileLines(restarted)[0]).toBe(
      "reconcile: 1 workshop(s) did not restart: unavailable (sbx is not installed)",
    );
  });

  it("keeps going when the workshop registry throws", async () => {
    const report = await reconcileOnStart({
      workshops: {
        restartRunning: async () => {
          throw new Error("workshop record is corrupt");
        },
      },
      routines: { start: async () => {} },
      headless: false,
    });
    expect(report.workshops).toEqual({ kind: "failed", error: "workshop record is corrupt" });
    expect(report.routines).toEqual({ kind: "started" });
  });

  it("says plainly when nothing is composed", async () => {
    expect(reconcileLines(await reconcileOnStart({ headless: false }))).toEqual([
      "reconcile: workshops are not composed in this node",
      "reconcile: no routine scheduler is composed in this node",
    ]);
  });
});

describe("reconcile on start: the claim code", () => {
  it("issues a claim code for an unclaimed headless node and prints it", async () => {
    const report = await reconcileOnStart({ claim: fileClaimDesk(stateDir), headless: true });
    expect(report.claim.kind).toBe("issued");
    const [line] = reconcileLines(report).slice(2);
    expect(line).toMatch(
      /^pairing: this headless node is unclaimed; claim it from your console with code [A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4} \(valid until /,
    );
  });

  it("reuses a live code instead of replacing the one the keeper already has", async () => {
    const desk = fileClaimDesk(stateDir);
    const first = await reconcileOnStart({ claim: desk, headless: true });
    const second = await reconcileOnStart({ claim: desk, headless: true });
    expect(second.claim.kind).toBe("live");
    const codeOf = (step: typeof first.claim) =>
      step.kind === "issued" || step.kind === "live" ? groupedClaimCode(step.claim.code) : "";
    expect(codeOf(second.claim)).toBe(codeOf(first.claim));
  });

  it("prints nothing for a claimed node or one with a console of its own", async () => {
    expect(
      (await reconcileOnStart({ claim: fileClaimDesk(stateDir), headless: false })).claim,
    ).toEqual({
      kind: "not-headless",
    });
    const pairs = filePairStore(meshPairingFile(stateDir));
    pairs.write({
      ...pairs.read(),
      owner: { tailnetId: "tail0123", userId: "u-keeper", claimedAt: "2026-11-05T09:00:00.000Z" },
    });
    const claimed = await reconcileOnStart({ claim: fileClaimDesk(stateDir), headless: true });
    expect(claimed.claim).toEqual({ kind: "claimed" });
    expect(reconcileLines(claimed)).toHaveLength(2);
  });

  it("reports a key store it cannot use without stopping the node", async () => {
    const broken: ClaimDesk = {
      claimState: async () => "unclaimed",
      live: async () => {
        throw new Error("keys.json is not valid JSON");
      },
      issue: async () => ({ code: "", expiresAt: "" }),
    };
    const report = await reconcileOnStart({ claim: broken, headless: true });
    expect(reconcileLines(report).at(-1)).toBe(
      "pairing: could not read or issue a claim code: keys.json is not valid JSON",
    );
  });
});
