import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filePairStore, meshPairingFile } from "../../../engine/src/mesh/pairing/store.ts";
import { fileClaimDesk } from "./compose.ts";
import { type ClaimDesk, groupedClaimCode, reconcileLines, reconcileOnStart } from "./reconcile.ts";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "keywork-node-reconcile-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
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
