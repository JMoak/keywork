import { strict as assert } from "node:assert";
import {
  type TurnDelta,
  textTurn,
  toolScope,
  writeTool,
} from "../../../packages/engine/src/index.ts";
import { parseFlavor } from "../../../packages/shared/src/index.ts";
import { dimStep, paneBorder } from "../../../packages/tui/src/chroma.ts";
import {
  type FocusOutline,
  keyworkNight,
  keyworkNightFlavor,
} from "../../../packages/tui/src/index.ts";
import type { CapturedFrame } from "../frame.ts";
import { occurrences, rowOf } from "../frame-queries.ts";
import type { Scenario, Stage } from "../scenario.ts";
import { notesAfter, notesBefore } from "./fixtures.ts";

const askRowMarker = "[y] allow  [a] always  [n] deny";
const boxed = parseFlavor({ ...keyworkNightFlavor, name: "boxed", chromeWeight: "regular" });
const bare = parseFlavor({ ...keyworkNightFlavor, name: "bare", chromeWeight: "borderless" });
const gapped = parseFlavor({ ...keyworkNightFlavor, name: "gapped", gap: 1 });

const askTurn: TurnDelta[] = [
  { type: "text", text: "Shouting the middle line of notes.txt now." },
  {
    type: "tool-call",
    call: {
      type: "tool-call",
      callId: "call-1",
      name: "write",
      arguments: { path: "notes.txt", content: notesAfter },
    },
  },
  { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
];

function chromeStates(name: string, description: string, tier: 0 | 2, goldens: string[]): Scenario {
  return {
    name,
    description,
    size: { width: 100, height: 24 },
    files: { "notes.txt": notesBefore },
    tools: (workspaceDir) => [writeTool(toolScope(workspaceDir))],
    turns: [askTurn, textTurn("Left it alone."), askTurn, textTurn("Left it alone."), askTurn],
    flavors: [boxed, bare, gapped],
    glyphs: { glyphTier: tier, nerdFont: false },
    goldens,
    run: async (stage) => {
      await stage.settle();
      await stage.capture("seams-idle");
      await askAndCapture(stage, "seams", tier);
      if (tier === 0) {
        await stage.quit();
        return;
      }

      await stage.type("/flavor-boxed");
      await stage.press("enter");
      await stage.settle();
      const boxedIdle = await stage.capture("boxed-idle");
      assert.ok(boxedIdle.includes("╭─ session-1 "), "the boxed weight draws its own title row");
      await askAndCapture(stage, "boxed", tier);

      await stage.type("/flavor-bare");
      await stage.press("enter");
      await stage.settle();
      const bareIdle = await stage.capture("bare-idle");
      assert.ok(!bareIdle.includes("│"), "the borderless weight draws no lines");
      assert.equal(occurrences(bareIdle, "▎"), 1, "focus reads from one density mark");
      await askAndCapture(stage, "bare", tier);

      await stage.type("/flavor-gapped");
      await stage.press("enter");
      await stage.settle();
      await stage.capture("gapped-idle");
      await stage.quit();
    },
  };
}

async function askAndCapture(stage: Stage, weight: string, tier: 0 | 2): Promise<void> {
  const stamp = tier === 0 ? "#" : "█";
  await stage.type("shout the middle line");
  await stage.press("enter");
  await stage.until(askRowMarker);
  await stage.until(`${stamp} session-1`);
  await stage.capture(`${weight}-needs-you-focused`);

  await stage.press("ctrl+k", "h", "escape");
  await stage.settle();
  await stage.until(`${stamp} session-1`);
  await stage.capture(`${weight}-needs-you-unfocused`);

  await stage.press("ctrl+k", "l", "escape");
  await stage.press("n");
  await stage.until("Left it alone.");
  await stage.settle();
  const answered = await stage.capture(`${weight}-answered`);
  assert.ok(!answered.includes(`${stamp} session-1`), "answering the ask clears the stamp at once");
}

export const chromeStatesTiered: Scenario = chromeStates(
  "chrome-states",
  "C69/C50 captures: idle and needs-you title rows in the seams, boxed, borderless, and gapped weights",
  2,
  [
    "seams-idle",
    "seams-needs-you-focused",
    "seams-needs-you-unfocused",
    "boxed-idle",
    "boxed-needs-you-focused",
    "bare-needs-you-focused",
    "gapped-idle",
  ],
);

function dimmedPanes(setting: "on" | "off"): Scenario {
  const expectedInk =
    setting === "on"
      ? dimStep(keyworkNight.textDim, keyworkNight.background)
      : keyworkNight.textDim;
  return {
    name: `chrome-states-dim-${setting}`,
    description: `C51 second half with dim ${setting}: unfocused pane content ink beside the focused page`,
    size: { width: 100, height: 24 },
    app: { dim: setting },
    goldens: ["unfocused-pane"],
    run: async (stage) => {
      await stage.settle();
      const frame = await stage.capture("unfocused-pane");
      assert.ok(frame.includes("no sessions yet"), "the unfocused tree pane is on screen");
      assert.equal(
        inkOf(stage.spans(), "no sessions yet"),
        expectedInk,
        `dim ${setting} renders the unfocused pane's chrome ink as ${expectedInk}`,
      );
      await stage.quit();
    },
  };
}

function inkOf(frame: CapturedFrame, needle: string): string {
  for (const line of frame.lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) return hexOf(span.fg);
    }
  }
  return "";
}

export const chromeStatesDimOn: Scenario = dimmedPanes("on");
export const chromeStatesDimOff: Scenario = dimmedPanes("off");

export const chromeStatesAscii: Scenario = chromeStates(
  "chrome-states-ascii",
  "C69 at glyph tier 0: the ask inverts with an ascii stamp inside the ground",
  0,
  ["seams-needs-you-focused"],
);

function focusCorners(rule: FocusOutline, tier: 0 | 2): Scenario {
  const suffix = tier === 0 ? "-ascii" : "";
  return {
    name: `focus-corners-${rule}${suffix}`,
    description: `focus outline rule "${rule}" at glyph tier ${tier}: a corner pane, a neighbour seam meeting the outline mid-edge, and the armed nav ring`,
    size: { width: 80, height: 20 },
    focusOutline: rule,
    glyphs: { glyphTier: tier, nerdFont: false },
    goldens: ["corner-pane", "mid-edge-seam", "nav-ring"],
    run: async (stage) => {
      await stage.settle();
      await stage.capture("corner-pane");
      await stage.press("ctrl+k", "s", "s", "escape");
      await stage.settle();
      await stage.press("ctrl+k", "h", "escape");
      await stage.settle();
      await stage.capture("mid-edge-seam");
      await stage.press("ctrl+k");
      await stage.settle();
      await stage.capture("nav-ring");
      await stage.press("escape");
      await stage.quit();
    },
  };
}

export const focusCornersFrame = focusCorners("frame", 2);
export const focusCornersGrid = focusCorners("grid", 2);
export const focusCornersFrameAscii = focusCorners("frame", 0);
export const focusCornersGridAscii = focusCorners("grid", 0);

const focusHues = [0, 0.5, 1].map((position) => paneBorder(keyworkNight, position, true));

export const focusRepaint: Scenario = {
  name: "focus-repaint",
  description:
    "live-renderer repaint check: moving focus leaves no cell in the old pane's focus hue, and closing a pane leaves no seam behind",
  size: { width: 80, height: 20 },
  run: async (stage) => {
    await stage.settle();
    await stage.press("ctrl+k", "s", "escape");
    await stage.settle();
    const before = await stage.capture("session-2-focused");
    const outlineHue = hueAt(stage.spans(), 79, 5);
    assert.ok(
      focusHues.includes(outlineHue),
      "the ring beside the focused pane wears its focus hue",
    );
    const litBefore = cellsInHue(stage.spans(), outlineHue);
    assert.ok(litBefore.length > 10, "the focused outline lights a run of cells");

    await stage.press("ctrl+k", "h", "escape");
    await stage.settle();
    await stage.capture("session-1-focused");
    const leftover = cellsInHue(stage.spans(), outlineHue);
    assert.deepEqual(leftover, [], "no cell keeps the old pane's focus hue after focus moves");

    const seamColumn = seamColumnBetween(before, "session-1", "session-2");
    await stage.press("ctrl+k", "l", "escape");
    await stage.type("/exit");
    await stage.press("enter");
    await stage.settle();
    const closed = await stage.capture("session-2-closed");
    const row = closed.split("\n")[10] ?? "";
    assert.equal(row[seamColumn], " ", "the seam that separated the closed pane is gone");
    await stage.quit();
  },
};

function hueAt(frame: CapturedFrame, x: number, y: number): string {
  let column = 0;
  for (const span of frame.lines[y]?.spans ?? []) {
    if (x < column + span.width) return hexOf(span.fg);
    column += span.width;
  }
  return "";
}

function cellsInHue(frame: CapturedFrame, hue: string): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [];
  frame.lines.forEach((line, y) => {
    let x = 0;
    for (const span of line.spans) {
      if (hexOf(span.fg) === hue && span.text.trim() !== "") cells.push({ x, y });
      x += span.width;
    }
  });
  return cells;
}

function hexOf(color: { r: number; g: number; b: number }): string {
  const byte = (channel: number) =>
    Math.round(channel * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
}

function seamColumnBetween(frame: string, left: string, right: string): number {
  const header = frame.split("\n")[rowOf(frame, right)] ?? "";
  const start = header.indexOf(left);
  const column = header.indexOf("│", start + left.length);
  assert.ok(column > 0, `a seam separates ${left} from ${right}`);
  return column;
}
