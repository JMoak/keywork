import { strict as assert } from "node:assert";
import {
  compactionDue,
  contextBudgetFor,
  estimateConversationTokens,
  type Message,
  readContext,
  type TurnDelta,
  textMessage,
  textTurn,
} from "../../../packages/engine/src/index.ts";
import { parseFlavor } from "../../../packages/shared/src/index.ts";
import { keyworkNightFlavor } from "../../../packages/tui/src/index.ts";
import { occurrences } from "../frame-queries.ts";
import type { Scenario } from "../scenario.ts";

const longSessionWindow = 2_000;
const firstFold = "## Goal\nKeep the budget honest across every turn.";
const secondFold = "## Goal\nSecond fold, focused on decisions.";

interface LongSessionScript {
  readonly turns: readonly TurnDelta[][];
  readonly compactingTurn: number;
}

const script = longSessionScript();
const cockpit = parseFlavor({ ...keyworkNightFlavor, name: "cockpit", instruments: "cockpit" });
const calmHeader = /│ session-1 +│/;

export const longSession: Scenario = {
  name: "long-session",
  description:
    "C55/IR-10 fixture: a 2k-token window filled turn by turn → gauge climbs the ramp → compaction fires and re-arms → /context readout → cockpit bar → manual /compact",
  size: { width: 120, height: 32 },
  script: "shared",
  contextWindow: longSessionWindow,
  turns: script.turns,
  flavors: [cockpit],
  run: async (stage) => {
    await stage.settle();
    const step = async (turn: number): Promise<string> => {
      await stage.type(`step ${turn}`);
      await stage.press("enter");
      await stage.until(`reply ${turn}:`);
      await stage.settle();
      return stage.capture(`turn-${String(turn).padStart(2, "0")}`);
    };

    let frame = await step(1);
    await stage.until(calmHeader);

    for (let turn = 2; turn < script.compactingTurn; turn += 1) frame = await step(turn);
    assert.match(frame, / session-1 · [▒▓] [\d.]+k? /, "the cell darkens as the flush mark nears");

    const compacted = await step(script.compactingTurn);
    assert.ok(compacted.includes("compacted "), "compaction posts its notice in the transcript");
    assert.ok(
      compacted.includes("into a summary · context now"),
      "the notice states the new reading",
    );
    await stage.until(calmHeader);

    await stage.type("/context");
    await stage.press("enter");
    const readout = await stage.until("memory flush at");
    assert.ok(readout.includes("window declared"), "the readout names the declared window");
    await stage.capture("context-readout");

    await step(script.compactingTurn + 1);
    await stage.type("/context");
    await stage.press("enter");
    await stage.settle();
    const before = usedFromReadout(await stage.capture("context-before-compact"));
    await stage.type("/compact focus on decisions");
    await stage.press("enter");
    await stage.settle();
    const folded = await stage.capture("manual-compact");
    assert.ok(
      usedFromNotice(folded) < before,
      "/compact folds again on request and the notice reports a smaller context",
    );
    assert.equal(
      occurrences(folded, "compacted "),
      2,
      "the manual fold posts its own notice in the transcript",
    );

    await stage.type("/flavor-cockpit");
    await stage.press("enter");
    await stage.until("flavor now cockpit");
    await stage.settle();
    const cockpitFrame = await stage.capture("gauge-cockpit-bar");
    assert.match(
      cockpitFrame,
      /[█░]+▒▓ [\d.]+k?\/2k/,
      "cockpit draws the bar with both marks as cells",
    );

    await stage.quit();
  },
};

function longSessionScript(): LongSessionScript {
  const budget = contextBudgetFor(longSessionWindow);
  const reply = (turn: number) =>
    `reply ${turn}: ${"the budget ticks up with every turn of the conversation and the gauge keeps the count honest. ".repeat(11)}`;
  const conversation: Message[] = [];
  const turns: TurnDelta[][] = [];
  for (let turn = 1; ; turn += 1) {
    conversation.push(textMessage("user", `step ${turn}`), textMessage("assistant", reply(turn)));
    turns.push(textTurn(reply(turn)));
    if (compactionDue(readContext(estimateConversationTokens(conversation), budget))) {
      return {
        turns: [...turns, textTurn(firstFold), textTurn(reply(turn + 1)), textTurn(secondFold)],
        compactingTurn: turn,
      };
    }
  }
}

function usedFromReadout(frame: string): number {
  const readings = [...frame.matchAll(/context (\d+) of \d+ tokens/g)];
  const last = readings.at(-1);
  assert.ok(last !== undefined, "the readout states the context in use");
  return Number(last[1]);
}

function usedFromNotice(frame: string): number {
  const notices = [...frame.matchAll(/context now ([\d.]+)(k?) of/g)];
  const last = notices.at(-1);
  assert.ok(last !== undefined, "the fold notice states the new reading");
  return Number(last[1]) * (last[2] === "k" ? 1000 : 1);
}
