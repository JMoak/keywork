import { describe, expect, it } from "vitest";
import {
  loadRatchet,
  nothingEnforced,
  RatchetUnreachableError,
  recordKeeperVerdict,
} from "../../../engine/src/creatures/decisions/index.ts";
import {
  answeredAsk,
  bashAsk,
  denied,
  granted,
  promotableClass,
  promotableNode,
  scratchNode,
} from "../../../engine/src/creatures/decisions/testing.ts";
import { exitCodes } from "../dispatch.ts";
import { creaturesCommand, creaturesUsage } from "./command.ts";

async function nodeWithAnswers(): Promise<string> {
  const nodeState = await scratchNode();
  for (const command of ["npm test", "npm test --silent"]) {
    const ask = bashAsk(command);
    await recordKeeperVerdict(answeredAsk(ask, granted(ask)), { nodeState });
  }
  const door = bashAsk("rm -rf dist");
  await recordKeeperVerdict(answeredAsk(door, denied(door, "unsafe")), { nodeState });
  return nodeState;
}

async function run(args: readonly string[], nodeState: string, json = false) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await creaturesCommand(
    args,
    { nodeState },
    { print: (line) => out.push(line), printError: (line) => err.push(line) },
    { json },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("keywork creatures report", () => {
  it("prints agreement per rule class with the evidence grade, after saying nothing is enforced", async () => {
    const { code, out } = await run(["report"], await nodeWithAnswers());
    expect(code).toBe(exitCodes.completed);
    const lines = out.split("\n");
    expect(lines[0]).toBe(nothingEnforced);
    expect(lines).toContain("bash npm test *     2         2       100%  0.002          2  none");
    expect(lines).toContain(
      "one-way door        1         1          -      -          0  one-way door",
    );
  });

  it("prints the same report as JSON", async () => {
    const { code, out } = await run(["report"], await nodeWithAnswers(), true);
    expect(code).toBe(exitCodes.completed);
    expect(JSON.parse(out)).toMatchObject({
      gateId: "keeper.would-approve",
      mode: "shadow",
      enforced: false,
      rows: 3,
      classes: [{ ruleClass: "bash npm test *", rows: 2, agreement: 1 }, { oneWayDoor: true }],
    });
  });

  it("says how the ledger fills on a node with no answered asks", async () => {
    const { code, out } = await run(["report"], await scratchNode());
    expect(code).toBe(exitCodes.completed);
    expect(out).toContain("No answered asks yet.");
  });
});

describe("keywork creatures promote", () => {
  it("refuses before the planned sample and says what evidence it would need", async () => {
    const { code, out, err } = await run(["promote", "bash npm test *"], await nodeWithAnswers());
    expect(code).toBe(exitCodes.denied);
    expect(out).toBe("");
    expect(err).toMatch(/^Promoting "bash npm test \*" needs a planned sample/);
    expect(err).toContain("the first 149 distinct calls after them");
    expect(err).toMatch(/Today, for keeper-rules: fitting, 2 of the 50 answers/);
  });

  it("refuses a one-way door on principle", async () => {
    const { code, err } = await run(["promote", "one-way", "door"], await nodeWithAnswers());
    expect(code).toBe(exitCodes.denied);
    expect(err).toBe(
      `"one-way door" is a one-way door: destructive forms in keywork's K9 ` +
        "sense stay ask-only, and no evidence promotes them.",
    );
  });

  it("says when a class has no answered asks yet", async () => {
    const { err } = await run(["promote", "bash cargo test *"], await scratchNode());
    expect(err).toBe('No answered asks in "bash cargo test *" yet.');
  });

  it("promotes one class on the planned sample, and demote hands it back", async () => {
    const nodeState = await promotableNode(await loadRatchet());
    const promoted = await run(["promote", ...promotableClass.split(" ")], nodeState);
    expect(promoted.code).toBe(exitCodes.completed);
    expect(promoted.out).toMatch(/^"bash make build \*" now decides for you on keeper-rules/);
    const reported = await run(["report"], nodeState);
    expect(reported.out.split("\n")[0]).toMatch(/decides for you in "bash make build \*"/);
    const demoted = await run(["demote", ...promotableClass.split(" ")], nodeState);
    expect(demoted.code).toBe(exitCodes.completed);
    expect(demoted.out).toMatch(/is back with the keeper/);
    expect((await run(["report"], nodeState)).out.split("\n")[0]).toBe(nothingEnforced);
  }, 120_000);
});

describe("keywork creatures review", () => {
  it("lists drawn calls without the guess, then reveals it after the answer", async () => {
    const nodeState = await scratchNode();
    const ask = bashAsk("npm test");
    const recorded = await recordKeeperVerdict(answeredAsk(ask, granted(ask)), {
      nodeState,
      draw: () => 0,
    });
    if (!recorded.recorded) throw new Error("expected a row");
    const listed = await run(["review"], nodeState);
    expect(listed.out).toMatch(/^1 call waits for a blind review/);
    expect(listed.out).toContain(`--- ${recorded.recordId}`);
    expect(listed.out).not.toContain("0.96");
    const answered = await run(["review", recorded.recordId, "deny"], nodeState);
    expect(answered).toMatchObject({ code: exitCodes.completed });
    expect(answered.out).toBe(
      "Recorded: deny. The gate leaned approve (0.96), disagreeing with you; in the moment you " +
        "approved, a different answer.",
    );
    expect((await run(["review"], nodeState)).out).toBe("No calls wait for a blind review.");
    expect((await run(["review", recorded.recordId, "approve"], nodeState)).code).toBe(
      exitCodes.denied,
    );
  });
});

describe("keywork creatures overturn", () => {
  it("refuses to overturn a call the keeper answered", async () => {
    const nodeState = await scratchNode();
    const ask = bashAsk("npm test");
    const recorded = await recordKeeperVerdict(answeredAsk(ask, granted(ask)), {
      nodeState,
      draw: () => 1,
    });
    if (!recorded.recorded) throw new Error("expected a row");
    const { code, err } = await run(["overturn", recorded.recordId], nodeState);
    expect(code).toBe(exitCodes.denied);
    expect(err).toBe("That call was not decided for you, so there is nothing to overturn.");
  });
});

describe("keywork creatures", () => {
  it("prints usage for anything else", async () => {
    for (const args of [
      [],
      ["promote"],
      ["demote"],
      ["report", "extra"],
      ["enforce", "x"],
      ["review", "id"],
      ["review", "id", "maybe"],
      ["overturn"],
    ]) {
      const { code, err } = await run(args, await scratchNode());
      expect(code, args.join(" ")).toBe(exitCodes.usage);
      expect(err).toBe(creaturesUsage);
    }
  });

  it("names the package when Ratchet cannot be loaded", async () => {
    const err: string[] = [];
    const code = await creaturesCommand(
      ["report"],
      {
        nodeState: await scratchNode(),
        loadRatchet: () => Promise.reject(new RatchetUnreachableError(new Error("gone"))),
      },
      { print: () => undefined, printError: (line) => err.push(line) },
    );
    expect(code).toBe(exitCodes.unresolved);
    expect(err[0]).toBe(
      "keywork creatures: The @jmoak/ratchet dependency could not be loaded: gone",
    );
    await expect(loadRatchet()).resolves.toBeDefined();
  });
});
