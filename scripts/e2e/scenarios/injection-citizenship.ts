import { strict as assert } from "node:assert";
import { textTurn } from "../../../packages/engine/src/index.ts";
import type { Scenario, Stage } from "../scenario.ts";

const burstWords = ["dictated", "words", "arrive", "as", "one", "long", "keystroke", "burst"];
const graphemeHeavy = "héllo 日本語のテキスト über façade 한국어";
const promptMarker = /│ session-1 +│/;

function burst(events: number): string {
  let text = "";
  while (text.length < events) text += `${burstWords[text.length % burstWords.length]} `;
  return text.slice(0, events).trimEnd();
}

export const injectionCitizenship: Scenario = {
  name: "injection-citizenship",
  description:
    "C34: dictation-class input lands as text: a 300-event burst, a burst on an armed leader, grapheme-heavy typing, none of it submitting",
  size: { width: 100, height: 24 },
  turns: [textTurn("landed")],
  goldens: ["burst", "leader-burst", "graphemes"],
  run: async (stage) => {
    await stage.settle();
    await stage.until(promptMarker);

    const text = burst(300);
    await stage.type(text);
    const afterBurst = await stage.until(text.slice(-24));
    assert.ok(!afterBurst.includes("landed"), "a keystroke burst never submits");
    await stage.capture("burst");
    await clearPrompt(stage, text.length);

    await stage.press("ctrl+k");
    await stage.type("quick brown fox jumps over the lazy dog");
    const afterLeader = await stage.until("uick brown fox jumps over the lazy dog");
    assert.ok(!afterLeader.includes("landed"), "a burst on an armed leader never submits");
    assert.equal(
      afterLeader.match(/│ session-\d+ +│/g)?.length ?? 0,
      1,
      "the burst opened no pane and fired no leader verb beyond the cancel key",
    );
    await stage.capture("leader-burst");
    await clearPrompt(stage, "uick brown fox jumps over the lazy dog".length);

    await stage.type(graphemeHeavy);
    await stage.until(graphemeHeavy);
    await stage.capture("graphemes");
    await stage.press("enter");
    const landed = await stage.until("landed");
    assert.ok(landed.includes(graphemeHeavy), "enter submits the graphemes intact");

    await stage.quit();
  },
};

async function clearPrompt(stage: Stage, length: number): Promise<void> {
  for (let step = 0; step < length; step += 1) await stage.press("backspace");
  await stage.settle();
}
