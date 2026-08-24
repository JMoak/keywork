import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emDash, findEmDashes, scanProse } from "./check-prose.ts";

describe("findEmDashes", () => {
  it("reports every em dash as line:column, one-based, in document order", () => {
    const content = ["clean line", `two${emDash}here and${emDash}again`, `${emDash}first`].join(
      "\n",
    );
    expect(findEmDashes(content)).toEqual(["2:4", "2:13", "3:1"]);
  });

  it("leaves hyphens, double hyphens, and en dashes alone", () => {
    expect(findEmDashes("keyboard-first, --flag, 2026-08-22, pages 3–10")).toEqual([]);
  });
});

describe("scanProse", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "keywork-prose-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes a tree with no em dashes", async () => {
    seed(root, {
      "docs/vision.md": "keywork is keyboard-first; the palette is the front door.",
      NOTICE: "Adapted from Pi (MIT) - see docs/README.md.",
      "packages/tui/src/app.ts": 'const separator = " · ";',
    });
    expect(await scanProse(root)).toEqual([]);
  });

  it("fails with file:line:column for every em dash in any tracked file, sorted", async () => {
    seed(root, {
      "scripts/e2e/goldens/cold-start.txt": `ready ${emDash} waiting`,
      "docs/backlog/99-modes.md": `one${emDash}two\nthree\nfour ${emDash} five ${emDash} six`,
      NOTICE: "Adapted from OpenCode (MIT).",
      "packages/cli/src/chat.ts": `const label = "tools ${emDash} 3";`,
    });
    expect(await scanProse(root)).toEqual([
      "docs/backlog/99-modes.md:1:4",
      "docs/backlog/99-modes.md:3:6",
      "docs/backlog/99-modes.md:3:13",
      "packages/cli/src/chat.ts:1:22",
      "scripts/e2e/goldens/cold-start.txt:1:7",
    ]);
  });

  it("skips the excluded directories but nothing else", async () => {
    seed(root, {
      "node_modules/dep/README.md": `vendored ${emDash} text`,
      "artifacts/audit/report.md": `quoted ${emDash} text`,
      "dist/bundle.js": `built ${emDash} text`,
      ".claude/worktrees/w/notes.md": `scratch ${emDash} text`,
      "docs/influencers/pi.md": `Pi ${emDash} notes`,
    });
    expect(await scanProse(root)).toEqual(["docs/influencers/pi.md:1:4"]);
  });
});

function seed(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}
