import { describe, expect, it } from "vitest";
import { formatKeeperReport, nothingEnforced } from "./format.ts";
import { loadRatchet } from "./ratchet.ts";
import { type AnsweredAsk, type KeeperDecisionsOptions, recordKeeperVerdict } from "./record.ts";
import { readKeeperReport } from "./report.ts";
import {
  answeredAsk,
  bashAsk,
  denied,
  granted,
  scratchNode,
  scriptedDecider,
  yesWith,
} from "./testing.ts";

const ratchet = await loadRatchet();

async function answer(
  options: KeeperDecisionsOptions,
  commands: readonly string[],
  verdict: "granted" | "denied",
  session = "session-1",
): Promise<void> {
  for (const command of commands) {
    const ask = bashAsk(command);
    const decision = verdict === "granted" ? granted(ask) : denied(ask, "unsafe");
    const answered: AnsweredAsk = answeredAsk(ask, decision, { session });
    await recordKeeperVerdict(answered, options);
  }
}

const times = (count: number, command: string) => Array.from({ length: count }, () => command);

describe("readKeeperReport", () => {
  it("reports agreement, Brier, acts and the evidence grade per rule class", async () => {
    const options = { nodeState: await scratchNode(), ratchet };
    await answer(options, times(3, "npm test"), "granted");
    await answer(options, times(2, "npm publish"), "denied");
    await answer(options, ["npm publish"], "granted");
    await answer(options, ["rm -rf dist"], "granted");
    const report = await readKeeperReport(options);
    expect(report).toMatchObject({ mode: "shadow", enforced: false, rows: 7, earlierRows: 0 });
    const [publish, tests, door] = report.classes;
    expect(tests).toMatchObject({
      ruleClass: "bash npm test *",
      rows: 3,
      labelled: 3,
      answered: 3,
      agreement: 1,
      wouldAct: 3,
      wrongActs: 0,
      oneWayDoor: false,
      gradeWord: "none",
    });
    expect(tests?.brier).toBeCloseTo((1 - 0.96) ** 2, 10);
    expect(publish).toMatchObject({ ruleClass: "bash npm publish *", rows: 3, wouldAct: 0 });
    expect(publish?.agreement).toBeCloseTo(2 / 3, 10);
    expect(door).toMatchObject({
      ruleClass: "one-way door",
      rows: 1,
      answered: 0,
      oneWayDoor: true,
    });
    expect(report.gate).toMatchObject({ ruleClass: "all classes", rows: 7, answered: 6 });
  });

  it("grades a class estimated once thirty labelled shadow rows stand behind it", async () => {
    const options = { nodeState: await scratchNode(), ratchet };
    await answer(options, times(30, "cargo test"), "granted");
    const [cargo] = (await readKeeperReport(options)).classes;
    expect(cargo?.gradeWord).toBe("estimated");
    expect(cargo?.gradeText).toMatch(/^estimated as of 2026-11-05: 100\.0% right on 30 labelled/);
  });

  it("grades a class measured only on a planned sample of 149 distinct approved acts", async () => {
    const options = { nodeState: await scratchNode(), ratchet };
    for (let session = 0; session < 15; session += 1) {
      const calls = Array.from(
        { length: 10 },
        (_, call) => `make build JOBS=${session * 10 + call}`,
      );
      await answer(options, calls, "granted", `session-${session}`);
    }
    const [make] = (await readKeeperReport(options)).classes;
    expect(make?.wouldAct).toBe(150);
    expect(make?.gradeWord).toBe("measured");
    expect(make?.gradeText).toContain("planned sample of 149 acts, 0 wrong");
  }, 60_000);

  it("counts only the newest evidence version and says how many rows it set aside", async () => {
    const nodeState = await scratchNode();
    await answer(
      { nodeState, ratchet, decider: scriptedDecider(yesWith(0.7)) },
      ["npm test"],
      "granted",
    );
    await answer({ nodeState, ratchet }, times(2, "npm test"), "granted");
    const report = await readKeeperReport({ nodeState, ratchet });
    expect(report).toMatchObject({
      evidenceVersion: "keeper-would-approve/1 keeper-rules",
      rows: 2,
      earlierRows: 1,
    });
  });
});

describe("formatKeeperReport", () => {
  it("opens by saying plainly that nothing is enforced", async () => {
    const options = { nodeState: await scratchNode(), ratchet };
    await answer(options, times(2, "npm test"), "granted");
    await answer(options, ["git push --force"], "denied");
    const lines = formatKeeperReport(await readKeeperReport(options)).split("\n");
    expect(lines[0]).toBe(nothingEnforced);
    expect(lines).toContain("rule class       rows  labelled  agreement  brier  would act  grade");
    expect(lines).toContain("bash npm test *     2         2       100%  0.002          2  none");
    expect(lines).toContain(
      "one-way door        1         1          -      -          0  one-way door",
    );
    expect(lines).toContain("all classes         3         3       100%  0.002          2  none");
    expect(lines.at(-1)).toBe(
      "  one-way door: destructive forms in keywork's K9 sense stay ask-only, and no evidence promotes them",
    );
  });

  it("says how the ledger fills when no ask has been answered", async () => {
    const nodeState = await scratchNode();
    const text = formatKeeperReport(await readKeeperReport({ nodeState, ratchet }));
    expect(text).toContain(nothingEnforced);
    expect(text).toContain("No answered asks yet.");
  });
});
