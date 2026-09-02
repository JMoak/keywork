import { strict as assert } from "node:assert";
import { textTurn } from "../../../packages/engine/src/index.ts";
import { paneTitleCount, rowOf } from "../frame-queries.ts";
import type { Scenario } from "../scenario.ts";
import { listTool } from "./fixtures.ts";

const pageProse =
  "The width tier decides the measure, so a paragraph this long has to fold at the tier's prose width instead of running the whole pane.";
const pageFenceLine =
  "export const page = resolvePage(width, thresholds); // fences hold full bleed while prose keeps the measure";
const pageMarkdown = [
  "## the page",
  "",
  pageProse,
  "",
  "- prose keeps the tier measure",
  "- machine output runs full bleed",
  "",
  "```ts",
  pageFenceLine,
  "```",
].join("\n");

export const pageTiers: Scenario = {
  name: "page-tiers",
  description:
    "C59 fixtures: one turn zoomed through broadsheet, column, clipping, and masthead widths",
  size: { width: 132, height: 36 },
  tools: () => [listTool],
  turns: [
    [
      { type: "text", text: pageMarkdown },
      {
        type: "tool-call",
        call: { type: "tool-call", callId: "call-page-list", name: "list", arguments: {} },
      },
      { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
    ],
    textTurn("Tier sweep ready: the same turn at four widths."),
  ],
  run: async (stage) => {
    assert.ok(pageProse.length > 100, "the prose fixture must overrun the broadsheet measure");
    assert.ok(
      pageFenceLine.length > 100 && pageFenceLine.length < 124,
      "the fence fixture must overrun the measure yet fit the broadsheet bleed",
    );

    await stage.settle();
    await stage.type("lay out the page grammar");
    await stage.press("enter");
    await stage.until("· done");
    await stage.until("Tier sweep ready");
    await stage.press("ctrl+k", "z", "escape");
    await stage.settle();

    const broadsheet = await stage.capture("broadsheet-132");
    assert.equal(paneTitleCount(broadsheet), 1, "zoom leaves the one pane holding the turn");
    assert.ok(
      broadsheet.includes(pageFenceLine),
      "the fence line runs full bleed past the prose measure",
    );
    assert.ok(!broadsheet.includes(pageProse), "prose folds at the broadsheet measure");
    assert.ok(broadsheet.includes("░ list"), "the tool row rides the rail with its voice stamp");
    assert.ok(!broadsheet.includes("drwxr-xr-x"), "tool detail starts folded");

    await stage.click(4, rowOf(broadsheet, "░ list"));
    const disclosed = await stage.until("drwxr-xr-x");
    await stage.capture("tool-row-open");

    await stage.press("tab");
    await stage.settle();
    const refolded = await stage.capture("tool-row-refolded");
    assert.ok(!refolded.includes("drwxr-xr-x"), "tab folds the disclosed row back down");
    assert.ok(disclosed.includes("░ list"), "the collapsed row survives disclosure");

    await stage.press("shift+tab");
    const cursored = await stage.until("disclose · tab toggles");
    assert.ok(!cursored.includes("drwxr-xr-x"), "shift+tab only places the fold cursor");
    await stage.press("tab");
    await stage.until("drwxr-xr-x");
    await stage.capture("tool-row-keyboard-open");
    await stage.press("escape", "tab");
    await stage.settle();
    const keyboardRefolded = await stage.capture("tool-row-keyboard-refolded");
    assert.ok(!keyboardRefolded.includes("drwxr-xr-x"), "tab closes the row after esc");
    assert.ok(!keyboardRefolded.includes("disclose ·"), "esc leaves disclosure");

    await stage.resize(84, 36);
    const column = await stage.capture("column-84");
    assert.ok(
      !column.includes(pageFenceLine),
      "at column width the bleed narrows, so the fence folds with it",
    );

    await stage.resize(56, 36);
    await stage.capture("clipping-56");

    await stage.resize(38, 36);
    const narrowFocused = await stage.capture("focused-38");
    assert.ok(
      narrowFocused.includes("The width tier"),
      "the focused pane keeps the working page below the masthead threshold",
    );
    assert.ok(!/[▀▄]/.test(narrowFocused), "no ceremony while the pane holds focus");

    await stage.press("ctrl+k", "z", "escape");
    await stage.resize(76, 20);
    await stage.press("ctrl+k", "s", "escape");
    await stage.settle();
    const tiled = await stage.capture("masthead-unfocused");
    assert.ok(/[▀▄]/.test(tiled), "the unfocused idle pane wears the masthead tile");

    await stage.press("ctrl+k", "h", "escape");
    const refocused = await stage.until("widths.");
    assert.ok(refocused.includes("widths."), "focusing the pane returns the working page");
    await stage.capture("masthead-follows-focus");

    await stage.quit();
  },
};
