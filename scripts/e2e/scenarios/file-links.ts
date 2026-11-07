import { strict as assert } from "node:assert";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { textTurn } from "../../../packages/engine/src/index.ts";
import type { Scenario, Stage } from "../scenario.ts";
import { type LinkCell, replayLinks } from "../terminal-links.ts";

const file = "packages/engine/src/providers/messages-wire.ts";
const reference = `${file}:210`;
const lead = "The fault sits in ";
const reply = `${lead}${reference} today.`;
const size = { width: 40, height: 14 };
const linkOpen = "\x1b]8;";
const kittyVersionReply = "\x1bP>|kitty(0.35.2)\x1b\\";

export const fileLinksOn: Scenario = {
  name: "file-links",
  description: "every cell of a wrapped path:line reference links to the workspace file and line",
  size,
  captureTerminal: true,
  app: { hyperlinks: true },
  turns: [textTurn(reply)],
  run: async (stage) => {
    const bytes = await replied(stage);
    const expectedTarget = `${pathToFileURL(join(stage.workspaceDir, file)).href}#L210`;
    const { rows, activeTarget } = await replayLinks(bytes, size, expectedTarget);
    stage.evidence(
      "linked-cells.json",
      JSON.stringify(
        {
          expectedTarget,
          activeTarget,
          rows: rows.map((row) => ({
            text: row.map(({ text }) => text || " ").join(""),
            links: row
              .map(({ target }) => ({ expected: "+", other: "?", none: " " })[target])
              .join(""),
          })),
        },
        null,
        2,
      ),
    );
    assert.equal(activeTarget, "", "the completed frame leaves no hyperlink active");
    assertReferenceLinks(rows);
  },
};

export const fileLinksOff: Scenario = {
  name: "file-links-off",
  description: "no OSC 8 reaches a link-capable terminal unless keywork says it opens links",
  size,
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

export function assertReferenceLinks(rows: readonly (readonly LinkCell[])[]): void {
  const leadGlyphs = [...lead];
  const leadColumns = rows.map((row) =>
    row.findIndex((_, col) => leadGlyphs.every((char, offset) => row[col + offset]?.text === char)),
  );
  const firstRow = leadColumns.findIndex((col) => col >= 0);
  const firstColumn = leadColumns[firstRow];
  assert.ok(firstColumn !== undefined, "the terminal shows the start of the reply");

  let matched = 0;
  let wrappedRows = 0;
  for (const [rowIndex, row] of rows.entries()) {
    const beforeRow = matched;
    const start: number = firstColumn + (rowIndex === firstRow ? lead.length : 0);
    if (rowIndex >= firstRow) {
      for (let col = start; matched < reference.length; col++) {
        const cell = row[col];
        if (cell === undefined || cell.text !== reference[matched]) break;
        assert.equal(
          cell.target,
          "expected",
          `reference cell ${rowIndex + 1}:${col + 1} links to the exact workspace file and line`,
        );
        matched++;
      }
    }
    const matchedInRow = matched - beforeRow;
    if (matchedInRow > 0) wrappedRows++;
    assert.ok(
      row.every(
        ({ target }, col) => target === "none" || (col >= start && col < start + matchedInRow),
      ),
      `row ${rowIndex + 1} has a link outside the visible file reference`,
    );
    if (rowIndex >= firstRow && beforeRow < reference.length) {
      assert.ok(matchedInRow > 0, "the entire file reference is visible on consecutive rows");
    }
  }
  assert.equal(matched, reference.length, "the entire file reference is visible");
  assert.ok(wrappedRows >= 2, "the file reference wraps across multiple linked rows");
}
