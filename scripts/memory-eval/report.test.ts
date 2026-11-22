import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryQuestions } from "../../packages/engine/src/index.ts";
import { scratchDirs } from "../../packages/shared/src/testing/index.ts";
import type { AnswerLine } from "./corpus.ts";
import { answersOf } from "./metrics.ts";
import { proofFindings, provenInReport } from "./proofs.ts";
import { builtinEdition, type DeciderEdition } from "./replay.ts";
import { formatReport, type ReportInput } from "./report.ts";
import {
  actionPoint,
  answers,
  corpusOf,
  entryPoint,
  keeps,
  relevant,
  verdict,
} from "./test-corpus.ts";

const scratch = scratchDirs("keywork-memory-eval-report-");
const jev: DeciderEdition = { decider: "jev", version: "1.13.0" };

const fitAuth = actionPoint("fit-auth", ["Auth Tokens", "Theme Tokens"], { half: "fit" });
const auth = actionPoint("auth", ["Auth Tokens", "Theme Tokens"]);
const durable = entryPoint("2026-10-08#1");
const corpus = corpusOf(
  [fitAuth, auth, durable],
  [
    relevant("fit-auth", "Auth Tokens"),
    relevant("fit-auth", "Theme Tokens", false),
    relevant("auth", "Auth Tokens"),
    relevant("auth", "Theme Tokens", false),
    verdict("2026-10-08#1", "new-durable"),
  ],
);
const builtinLines = [
  keeps(fitAuth, ["Auth Tokens", "Theme Tokens"], { decider: "builtin", latencyMs: 0 }),
  keeps(auth, ["Auth Tokens", "Theme Tokens"], { decider: "builtin", latencyMs: 0 }),
  answers(durable, "unsure", { decider: "builtin", latencyMs: 0 }),
];
const offLines = [keeps(fitAuth, []), keeps(auth, []), answers(durable, "unsure")];
const jevLines = [
  keeps(fitAuth, ["Auth Tokens"], {
    scores: { "Auth Tokens": 0.97, "Theme Tokens": 0.04 },
    latencyMs: 210,
    waitedMs: 12,
    inputTokens: 900,
  }),
  keeps(auth, ["Auth Tokens"], {
    scores: { "Auth Tokens": 0.97, "Theme Tokens": 0.04 },
    latencyMs: 230,
    waitedMs: 14,
    inputTokens: 900,
  }),
  answers(durable, "new-durable", { confidence: 0.93, latencyMs: 190, inputTokens: 400 }),
];

function reportOf(edition: DeciderEdition, lines: AnswerLine[], skipped?: string): string {
  const source = edition === builtinEdition ? ("rule" as const) : ("cassette" as const);
  const input: ReportInput = {
    corpus,
    corpusName: "fixtures/decisions",
    run: {
      record: {
        edition,
        corpus: "fixtures/decisions",
        corpusDigest: "digest",
        points: corpus.points.length,
        ...(skipped === undefined ? { source } : { skipped }),
      },
      answers: lines,
    },
    builtin: answersOf(builtinLines),
    off: answersOf(offLines),
  };
  return formatReport(input);
}

describe("formatReport for the reference arm", () => {
  const markdown = reportOf(builtinEdition, builtinLines);

  it("calls itself the reference and proves nothing", () => {
    expect(
      markdown.startsWith(
        "# Memory eval: builtin-1\n\nDecider `builtin` version `1`, answering by its rules",
      ),
    ).toBe(true);
    expect(markdown).toContain(
      [
        "## Verdict",
        "",
        "| Question | Held-out points | Gate | Proven |",
        "|---|---|---|---|",
        "| `action-relevance@1` | 1 | reference arm | reference |",
        "| `entry-durability@1` | 1 | reference arm | reference |",
      ].join("\n"),
    );
    expect(provenInReport(markdown)).toEqual([]);
  });
});

describe("formatReport for a challenger", () => {
  const markdown = reportOf(jev, jevLines);

  it("gates each question against the builtin and says which it proves", () => {
    expect(markdown).toContain("| `action-relevance@1` | 1 | 4 of 4 criteria pass | yes |");
    expect(markdown).toContain("| `entry-durability@1` | 1 | 1 of 3 criteria pass | no |");
    expect(provenInReport(markdown)).toEqual([memoryQuestions.actionRelevance]);
  });
});

describe("formatReport for a skipped run", () => {
  it("states the reason and proves nothing", () => {
    const markdown = reportOf(jev, [], "no cassette at x and no TypeSafe key");
    expect(markdown).toContain(
      "Decider `jev` version `1.13.0` over `fixtures/decisions` was not run, so it proves nothing. Skipped: no cassette at x and no TypeSafe key.",
    );
    expect(markdown).toContain("| `action-relevance@1` | 1 | not run | no |");
    expect(provenInReport(markdown)).toEqual([]);
  });
});

describe("proofFindings", () => {
  async function repoWith(reports: Record<string, string>): Promise<string> {
    const root = await scratch();
    await mkdir(join(root, "docs", "memory-eval"), { recursive: true });
    for (const [name, markdown] of Object.entries(reports))
      await writeFile(join(root, "docs", "memory-eval", name), markdown);
    return root;
  }

  it("holds the checked-in reports and memoryEvalProofs to each other", async () => {
    expect(await proofFindings()).toEqual([]);
  });

  it("accepts a proof whose report proves the question", async () => {
    const root = await repoWith({
      "jev-1.13.0.md": reportOf(jev, jevLines),
      "README.md": "# eval",
    });
    const proofs = [{ edition: "jev-1.13.0", question: memoryQuestions.actionRelevance }];
    expect(await proofFindings(proofs, root)).toEqual([]);
  });

  it("refuses a proof with no report, or one its report does not prove", async () => {
    const root = await repoWith({ "jev-1.13.0.md": reportOf(jev, jevLines) });
    const proofs = [
      { edition: "jev-1.13.0", question: memoryQuestions.entryDurability },
      { edition: "jev-1.14.0", question: memoryQuestions.actionRelevance },
    ];
    expect(await proofFindings(proofs, root)).toEqual([
      "memoryEvalProofs proves `entry-durability@1` for jev-1.13.0, but docs/memory-eval/jev-1.13.0.md does not",
      "memoryEvalProofs proves `action-relevance@1` for jev-1.14.0, but docs/memory-eval/jev-1.14.0.md is not checked in",
      'docs/memory-eval/jev-1.13.0.md proves `action-relevance@1`; add { edition: "jev-1.13.0", question: "action-relevance@1" } to memoryEvalProofs',
    ]);
  });
});
