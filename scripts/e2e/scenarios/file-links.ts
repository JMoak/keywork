import { strict as assert } from "node:assert";
import { textTurn } from "../../../packages/engine/src/index.ts";
import type { Scenario, Stage } from "../scenario.ts";

const reference = "packages/engine/src/providers/messages-wire.ts:210";
const reply = `The fault sits in ${reference} today.`;
const linkOpen = "\x1b]8;";
const linkClose = "\x1b]8;;\x1b\\";
const kittyVersionReply = "\x1bP>|kitty(0.35.2)\x1b\\";

export const fileLinksOn: Scenario = {
  name: "file-links",
  description:
    "a path:line reference wraps across rows and every row opens and closes its own OSC 8",
  size: { width: 40, height: 14 },
  captureTerminal: true,
  app: { hyperlinks: true },
  turns: [textTurn(reply)],
  run: async (stage) => {
    const bytes = await replied(stage);
    const opens = linkOpensFor(bytes, "messages-wire.ts#L210");
    stage.evidence("links.txt", JSON.stringify(opens.map((at) => bytes.slice(at, at + 160))));
    assert.ok(opens.length >= 2, "the wrapped reference carries a link on each of its rows");
    for (const at of opens) assertClosedOnItsRow(bytes, at);
  },
};

export const fileLinksOff: Scenario = {
  name: "file-links-off",
  description: "no OSC 8 reaches a link-capable terminal unless keywork says it opens links",
  size: { width: 40, height: 14 },
  captureTerminal: true,
  turns: [textTurn(reply)],
  run: async (stage) => {
    const bytes = await replied(stage);
    assert.ok(!bytes.includes(linkOpen), "no hyperlink escape reaches a terminal that never asked");
  },
};

async function replied(stage: Stage): Promise<string> {
  stage.answer(kittyVersionReply);
  await stage.settle();
  await stage.type("where is the fault?");
  await stage.press("enter");
  await stage.until("today.");
  await stage.settle();
  return stage.terminalBytes();
}

function linkOpensFor(bytes: string, target: string): number[] {
  const opens: number[] = [];
  for (let at = bytes.indexOf(linkOpen); at !== -1; at = bytes.indexOf(linkOpen, at + 1)) {
    if (!bytes.startsWith(linkClose, at) && bytes.slice(at, at + 400).includes(target)) {
      opens.push(at);
    }
  }
  return opens;
}

function assertClosedOnItsRow(bytes: string, open: number): void {
  const close = bytes.indexOf(linkClose, open + linkOpen.length);
  assert.ok(close !== -1, "every opened link is closed");
  const nextOpen = bytes.indexOf(linkOpen, open + linkOpen.length);
  assert.equal(nextOpen, close, "a link closes before any other link opens");
  const row = lastCursorRow(bytes.slice(0, open));
  const inner = bytes.slice(open, close);
  for (const match of inner.matchAll(cursorMove)) {
    assert.equal(Number(match[1]), row, "a link never crosses onto another row");
  }
  assert.ok(!inner.includes("\n"), "a link never spans a line feed");
}

const cursorMove = new RegExp(`${"\x1b"}\\[(\\d+);\\d+H`, "g");

function lastCursorRow(before: string): number | undefined {
  const moves = [...before.matchAll(cursorMove)];
  const last = moves.at(-1);
  return last === undefined ? undefined : Number(last[1]);
}
