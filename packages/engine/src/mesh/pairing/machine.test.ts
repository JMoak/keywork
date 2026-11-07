import { describe, expect, it } from "vitest";
import { randomToken } from "./canonical.ts";
import {
  acceptHelloReply,
  beginAttempt,
  type ConsoleAttempt,
  confirmationOf,
} from "./initiator.ts";
import { newExchangeKey } from "./keys.ts";
import {
  advance,
  type Confirmation,
  identify,
  openAttempt,
  type PairingStep,
  type TargetAttempt,
} from "./machine.ts";
import { pairRoles } from "./sas.ts";
import {
  hostNode,
  houseNode,
  keeperId,
  pairingCaller,
  pick,
  seededRandom,
  selfOf,
  strangerId,
  taggedNode,
  tailnetId,
} from "./testing/identities.ts";

const consoleKey = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const targetKey = "Gb9ECWmEzf6FQbrBZ9w7lshQhqowtoyN7Fn7uiP8vWc";
const claimCode = "ABCD-EFGH-JKLM";
const t0 = 1_800_000_000_000;

interface Rig {
  target: TargetAttempt;
  consoleSide: ConsoleAttempt;
  steps: { reveal: PairingStep; consoleConfirm: PairingStep; targetConfirm: PairingStep };
}

function rig(confirmation: Confirmation): Rig {
  const caller = pairingCaller(houseNode);
  const { attempt, hello } = beginAttempt({
    role: "console",
    caps: ["exec"],
    selfStableId: houseNode.stableId,
    targetStableId: hostNode.stableId,
    deviceKey: consoleKey,
  });
  const target = openAttempt({
    id: randomToken(),
    caller,
    role: hello.role,
    caps: hello.caps,
    confirmation,
    console: {
      deviceKey: hello.deviceKey,
      exchangeKey: hello.exchangeKey,
      commitment: hello.commitment,
    },
    target: {
      stableId: hostNode.stableId,
      deviceKey: targetKey,
      exchange: newExchangeKey(),
      nonce: randomToken(),
    },
    expiresAt: t0 + 60_000,
  });
  const consoleSide = acceptHelloReply(attempt, {
    pairingId: target.id,
    stableId: target.target.stableId,
    deviceKey: target.target.deviceKey,
    exchangeKey: target.target.exchange.publicKey,
    nonce: target.target.nonce,
    confirmation,
    expiresAt: new Date(target.expiresAt).toISOString(),
  });
  const confirmed = confirmationOf(
    consoleSide,
    confirmation === "claim-code" ? claimCode : undefined,
  );
  if (confirmed === undefined || consoleSide.sas === null)
    throw new Error("the console could not confirm");
  return {
    target,
    consoleSide,
    steps: {
      reveal: { kind: "reveal", from: caller, nonce: attempt.nonce },
      consoleConfirm: { kind: "console-confirm", from: caller, ...confirmed },
      targetConfirm: {
        kind: "target-confirm",
        by: confirmation === "endorsement" ? "endorsement" : "on-device",
        sas: consoleSide.sas,
      },
    },
  };
}

function run(attempt: TargetAttempt, steps: readonly PairingStep[], now = t0): TargetAttempt {
  return steps.reduce((held, step) => advance(held, step, { now, claimCode }), attempt);
}

type StepName = keyof Rig["steps"];

function referencePhase(trace: readonly StepName[]): "stored" | "aborted" | "open" {
  let revealed = false;
  const confirmed = new Set<StepName>();
  for (const step of trace) {
    if (step === "reveal") {
      if (revealed) return "aborted";
      revealed = true;
      continue;
    }
    if (!revealed || confirmed.has(step)) return "aborted";
    confirmed.add(step);
    if (confirmed.size === 2) return "stored";
  }
  return "open";
}

describe("the pairing state machine", () => {
  it("stores a pair when hello, reveal and both confirmations arrive in order", () => {
    for (const confirmation of ["on-device", "endorsement"] as const) {
      const { target, consoleSide, steps } = rig(confirmation);
      const stored = run(target, [steps.reveal, steps.consoleConfirm, steps.targetConfirm]);
      expect(stored.phase).toBe("stored");
      expect(stored.sas).toBe(consoleSide.sas);
      expect(stored.secret?.equals(consoleSide.secret ?? Buffer.alloc(0))).toBe(true);
    }
  });

  it("derives one six-digit SAS on both sides from the transcript", () => {
    const { target, consoleSide, steps } = rig("on-device");
    const revealed = run(target, [steps.reveal]);
    expect(revealed.phase).toBe("confirming");
    expect(revealed.sas).toMatch(/^\d{6}$/);
    expect(revealed.sas).toBe(consoleSide.sas);
  });

  it("never skips a step: any order other than reveal then both confirmations aborts (property)", () => {
    const random = seededRandom(0x5eed);
    const names: StepName[] = ["reveal", "consoleConfirm", "targetConfirm"];
    for (let round = 0; round < 300; round += 1) {
      const { target, steps } = rig(pick(random, ["on-device", "endorsement"] as const));
      const trace = Array.from({ length: 1 + Math.floor(random() * 5) }, () => pick(random, names));
      const final = run(
        target,
        trace.map((name) => steps[name]),
      );
      const expected = referencePhase(trace);
      expect(
        final.phase === "stored" ? "stored" : final.phase === "aborted" ? "aborted" : "open",
      ).toBe(expected);
      if (expected === "aborted") expect(final.abort).toBe("out-of-order");
      if (final.phase === "stored") expect(trace.indexOf("reveal")).toBe(0);
    }
  });

  it("aborts on any SAS mismatch and never stores (property)", () => {
    const random = seededRandom(0xbad5a5);
    for (let round = 0; round < 200; round += 1) {
      const { target, consoleSide, steps } = rig(
        pick(random, ["on-device", "endorsement"] as const),
      );
      const wrong = otherSas(consoleSide.sas ?? "", random);
      const tampered: PairingStep =
        random() < 0.5
          ? {
              ...(steps.consoleConfirm as Extract<PairingStep, { kind: "console-confirm" }>),
              sas: wrong,
            }
          : {
              ...(steps.targetConfirm as Extract<PairingStep, { kind: "target-confirm" }>),
              sas: wrong,
            };
      const final = run(target, [
        steps.reveal,
        tampered,
        steps.consoleConfirm,
        steps.targetConfirm,
      ]);
      expect(final.phase).toBe("aborted");
      expect(final.abort).toBe("sas-mismatch");
      expect(final.secret).toBeNull();
    }
  });

  it("denies every human other than the owner, claimed or not (property)", () => {
    const random = seededRandom(0x2d);
    const owner = { tailnetId, userId: keeperId, claimedAt: new Date(t0).toISOString() };
    for (let round = 0; round < 200; round += 1) {
      const human = String(7_000_000_000_000_002 + Math.floor(random() * 1_000_000));
      const caller = pairingCaller(houseNode, human);
      const role = pick(random, pairRoles);
      const claimed = identify(caller, role, { self: selfOf(hostNode), owner, headless: false });
      expect(claimed).toEqual({ refused: "not-the-owner" });
      if (role === "console") {
        const unclaimed = identify(caller, role, {
          self: selfOf(hostNode),
          owner: null,
          headless: false,
        });
        expect(unclaimed).toEqual({ refused: "not-the-owner" });
      }
    }
  });

  it("lets the owner pair, confirms by claim code on a headless host, and keeps tagged callers off the console role", () => {
    const self = selfOf(hostNode);
    const owner = { tailnetId, userId: keeperId, claimedAt: "" };
    const keeper = pairingCaller(houseNode);
    expect(identify(keeper, "console", { self, owner: null, headless: true })).toEqual({
      confirmation: "claim-code",
    });
    expect(identify(keeper, "console", { self, owner: null, headless: false })).toEqual({
      confirmation: "on-device",
    });
    expect(identify(keeper, "console", { self, owner, headless: false })).toEqual({
      confirmation: "endorsement",
    });
    const tagged = pairingCaller(taggedNode);
    expect(identify(tagged, "console", { self, owner, headless: false })).toEqual({
      refused: "needs-a-human",
    });
    expect(identify(tagged, "node", { self, owner, headless: false })).toEqual({
      confirmation: "endorsement",
    });
    expect(identify(tagged, "node", { self, owner: null, headless: false })).toEqual({
      refused: "unclaimed-needs-a-console",
    });
    const tsHost = { ...self, userId: null };
    expect(
      identify(pairingCaller(houseNode, strangerId), "console", {
        self: tsHost,
        owner: null,
        headless: true,
      }),
    ).toEqual({
      confirmation: "claim-code",
    });
    expect(
      identify(keeper, "console", {
        self: { ...self, tailnetId: "other" },
        owner,
        headless: false,
      }),
    ).toEqual({
      refused: "other-tailnet",
    });
  });

  it("accepts the right claim code and aborts on a wrong one", () => {
    const { target, steps } = rig("claim-code");
    expect(run(target, [steps.reveal, steps.consoleConfirm]).phase).toBe("stored");
    const wrong = advance(run(target, [steps.reveal]), steps.consoleConfirm, {
      now: t0,
      claimCode: "ZZZZ-ZZZZ-ZZZZ",
    });
    expect(wrong.abort).toBe("bad-claim-code");
    const lapsed = advance(run(target, [steps.reveal]), steps.consoleConfirm, {
      now: t0,
      claimCode: null,
    });
    expect(lapsed.abort).toBe("bad-claim-code");
    expect(run(target, [steps.reveal, steps.targetConfirm]).abort).toBe("wrong-confirmation");
  });

  it("aborts when the nonce does not match the hello's commitment", () => {
    const { target, steps } = rig("on-device");
    const reveal = {
      ...(steps.reveal as Extract<PairingStep, { kind: "reveal" }>),
      nonce: randomToken(),
    };
    expect(run(target, [reveal]).abort).toBe("commitment-mismatch");
  });

  it("aborts when another node or human continues the attempt", () => {
    const { target, steps } = rig("on-device");
    const reveal = {
      ...(steps.reveal as Extract<PairingStep, { kind: "reveal" }>),
      from: pairingCaller(hostNode),
    };
    expect(run(target, [reveal]).abort).toBe("caller-changed");
    const confirm = {
      ...(steps.consoleConfirm as Extract<PairingStep, { kind: "console-confirm" }>),
      from: pairingCaller(houseNode, strangerId),
    };
    expect(run(target, [steps.reveal, confirm]).abort).toBe("caller-changed");
  });

  it("aborts on a proof made with another pair key", () => {
    const { target, steps } = rig("on-device");
    const forged = {
      ...(steps.consoleConfirm as Extract<PairingStep, { kind: "console-confirm" }>),
      proof: randomToken(32),
    };
    expect(run(target, [steps.reveal, forged]).abort).toBe("bad-proof");
  });

  it("expires, and a settled attempt ignores later steps", () => {
    const { target, steps } = rig("on-device");
    expect(run(target, [steps.reveal], target.expiresAt).abort).toBe("expired");
    const stored = run(target, [steps.reveal, steps.targetConfirm, steps.consoleConfirm]);
    expect(stored.phase).toBe("stored");
    expect(run(stored, [{ kind: "cancel" }, steps.reveal])).toBe(stored);
    expect(run(target, [steps.reveal, { kind: "cancel" }]).abort).toBe("cancelled");
  });
});

function otherSas(sas: string, random: () => number): string {
  for (;;) {
    const candidate = String(Math.floor(random() * 1_000_000)).padStart(6, "0");
    if (candidate !== sas) return candidate;
  }
}
