import { strict as assert } from "node:assert";
import { reviewKey, textTurn } from "../../../packages/engine/src/index.ts";
import type { Scenario } from "../scenario.ts";

const vault = ".keywork/memory";
const stagedNoteId = "11111111-1111-4111-8111-111111111111";
const contradictionId = "22222222-2222-4222-8222-222222222222";
const contradiction = {
  kind: "contradiction",
  a: "Dock Rule",
  b: "Fresh Guess",
  aProvenance: "user",
  bProvenance: "agent",
  confidence: 0.7,
} as const;

function note(frontmatter: Record<string, string | number | boolean>, body: string): string {
  const lines = Object.entries(frontmatter).map(
    ([key, value]) => `${key}: ${JSON.stringify(value)}`,
  );
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

const files: Record<string, string> = {
  ".keywork/workspace.json": `${JSON.stringify({ name: "memory-browser-e2e" })}\n`,
  [`${vault}/MEMORY.md`]: "- [[Dock Rule]]\n- [[Split Ratios]]\n- [[Old Dock Rule]]\n",
  [`${vault}/Dock Rule.md`]: note(
    {
      provenance: "user",
      created: "2026-08-10T09:00:00.000Z",
      pinned: true,
      supersedes: "[[Old Dock Rule]]",
    },
    "# Dock Rule\n\nThe left dock keeps **0.3** of the width; panes inside it stack by weight.\n\n- the main area takes the rest\n- see [[Split Ratios]] for how the main area divides\n",
  ),
  [`${vault}/Old Dock Rule.md`]: note(
    {
      provenance: "agent",
      created: "2026-08-01T09:00:00.000Z",
      superseded_by: "[[Dock Rule]]",
    },
    "The dock used to take half the width.\n",
  ),
  [`${vault}/Split Ratios.md`]: note(
    {
      provenance: "agent",
      created: "2026-08-12T09:00:00.000Z",
      confidence: 0.9,
      usefulness: 0.6,
      depends_on: "[[Dock Rule]]",
    },
    "Main-area splits default to 60/40; `ctrl+k r` rebalances them. The dock side follows [[Dock Rule]].\n",
  ),
  [`${vault}/Fresh Guess.md`]: note(
    { provenance: "agent", created: "2026-08-21T09:00:00.000Z" },
    "The title bar might want a second telemetry slot.\n",
  ),
  [`${vault}/daily/2026-08-20.md`]:
    "- 09:12 [prov: user] decided the dock ratio stays 0.3\n- 10:40 [prov: agent] split ratios rebalanced after a resize\n",
  [`${vault}/curation.md`]:
    "- 2026-08-21T10:00:00.000Z gardener sweep: promoted 1, merged 0, superseded 1, flagged 1, rejected 0\n- 2026-08-21T10:00:01.000Z approved note → Split Ratios.md\n",
  [`${vault}/.staging/${stagedNoteId}.json`]: `${JSON.stringify({
    kind: "note",
    target: "Web Claim.md",
    created: "2026-08-22T09:00:00.000Z",
  })}\n`,
  [`${vault}/.staging/${stagedNoteId}.md`]: note(
    { provenance: "untrusted", created: "2026-08-22T09:00:00.000Z" },
    "A fetched page claims docks should be 0.25 wide.\n",
  ),
  [`${vault}/.staging/${contradictionId}.json`]: `${JSON.stringify({
    ...contradiction,
    key: reviewKey(contradiction),
    created: "2026-08-22T09:30:00.000Z",
  })}\n`,
  [`${vault}/arcs/dock-v2/MOC.md`]: note(
    { arc: "dock-v2", status: "active", created: "2026-08-15T08:00:00.000Z" },
    "arc dock-v2\n",
  ),
  [`${vault}/arcs/dock-v2/Dock Lesson.md`]: note(
    { provenance: "agent", created: "2026-08-18T09:00:00.000Z" },
    "Folding the dock members keeps the main area calm. It leans on [[Dock Rule]].\n",
  ),
  [`${vault}/arcs/dock-v2/Fold Habit.md`]: note(
    { provenance: "agent", created: "2026-08-19T09:00:00.000Z", usefulness: 0.3 },
    "Members come back in creation order after a fold.\n",
  ),
  [`${vault}/arcs/dock-v2/questions/Tie order.md`]: note(
    {
      type: "open-question",
      status: "open",
      provenance: "user",
      created: "2026-08-20T09:00:00.000Z",
    },
    "Who wins focus ties between two folded members?\n",
  ),
  [`${vault}/arcs/next-arc/MOC.md`]: note(
    { arc: "next-arc", status: "active", created: "2026-08-21T08:00:00.000Z" },
    "arc next-arc\n",
  ),
};

const frozenClock = (): number => Date.parse("2026-08-22T12:00:00.000Z");

const digestRows = {
  candidate: "▓ Fold Habit · 3d",
  question: "█ Tie order · question · 2d",
  fold: "░ 1 below the bar · uncited · archived, searchable",
  close: "░ close #dock-v2 · 2 to decide",
};

function occurrences(frame: string, marker: string): number {
  return frame.split(marker).length - 1;
}

async function closeArcAtTheAirlock(stage: Parameters<Scenario["run"]>[0]): Promise<string> {
  await stage.press("ctrl+p");
  await stage.type("session-1");
  await stage.press("enter");
  await stage.type("/arc close dock-v2");
  await stage.press("enter");
  await stage.until("arc dock-v2 is waiting at the airlock · 2 notes and 1 question");
  await stage.press("ctrl+p");
  await stage.type("memory");
  await stage.press("enter");
  return stage.until(digestRows.close);
}

export const memoryBrowser: Scenario = {
  name: "memory-browser",
  description:
    "memory browser over a seeded vault: garden lens with layers, prompt budget, inbox and airlock → approve → ? asks memory the way the agent sees it (legs, ranks, arc boost) → note lens with page typography and outline hop → ledger with one-key revert → relaunch revives the lens",
  size: { width: 160, height: 40 },
  files,
  turns: [textTurn("noted.")],
  app: { clock: frozenClock },
  run: async (stage) => {
    await stage.settle();
    await stage.type("/arc dock-v2");
    await stage.press("enter");
    await stage.until("arc → dock-v2");

    await stage.type("/memory");
    await stage.press("enter");
    const garden = await stage.until("│ memory · 6 notes · ░1 ");
    assert.ok(garden.includes("#dock-v2 · 2 notes"), "the focused arc's layer leads the garden");
    assert.ok(garden.includes("in prompt · "), "the workspace layer shows its prompt budget");
    assert.ok(garden.includes("by search only"), "notes beyond the prompt are labelled");
    assert.ok(garden.includes("░ staged · Web Claim.md"), "the staged write sits in the inbox");
    assert.ok(garden.includes("conflict · Dock Rule vs Fresh Guess"), "the contradiction shows");
    assert.ok(garden.includes("? ask"), "the question box advertises itself");
    await stage.settle();
    await stage.capture("garden");

    await stage.press("i", "a");
    await stage.until("│ memory · 7 notes ");

    await stage.press("?");
    await stage.type("dock");
    const asked = await stage.until("? dock▌ · lexical");
    assert.ok(asked.includes("lexical #1"), "hits carry their per-leg ranks");
    assert.ok(asked.includes("#dock-v2 ×2"), "the bound arc's notes show their boost");
    await stage.settle();
    await stage.capture("ask");

    await stage.press("enter");
    const lens = await stage.until("agent · fresh · 4d · #dock-v2");
    assert.ok(lens.includes("leans on [[Dock Rule]]"), "the body renders through the page");
    assert.ok(lens.includes("links out"), "the outline follows the body");
    await stage.settle();
    await stage.capture("note");

    await stage.press("j", "j", "j", "enter");
    const hopped = await stage.until("user · settled · in prompt · pinned");
    assert.ok(hopped.includes("supersedes Old Dock Rule"), "the relations strip reads");
    assert.ok(hopped.includes("The left dock keeps"), "enter on an outline row hops to that note");
    await stage.settle();
    await stage.capture("hop");

    await stage.press(...Array.from({ length: 12 }, () => "j"));
    const outline = await stage.until("← depends on");
    assert.ok(outline.includes("links in"), "the cursor walks the body down into the outline");
    await stage.settle();
    await stage.capture("hop-outline");

    await stage.press("escape", "escape", "tab");
    const ledger = await stage.until("ledger · ");
    assert.ok(ledger.includes("approve · Web Claim"), "this run's approval heads the ledger");
    assert.ok(ledger.includes("gardener sweep"), "the persisted audit joins the feed");
    await stage.press("u");
    await stage.until("reverted · the previous text is back");
    await stage.until("│ memory · 6 notes · ░1 ");
    await stage.settle();
    await stage.capture("ledger-revert");

    await stage.press("escape", "g", "enter");
    await stage.until("agent · cured · 3d · #dock-v2");
    await stage.relaunch();
    const revived = await stage.until("agent · cured · 3d · #dock-v2");
    assert.ok(revived.includes("│ memory · 6 notes · ░1 "), "the pane revives in its note lens");
    await stage.settle();
    await stage.capture("relaunched-note-lens");

    await stage.press("escape");
    const digest = await closeArcAtTheAirlock(stage);
    assert.ok(
      digest.includes("#dock-v2 · 2 notes · airlock ░3 · 1 flushed"),
      "the header counts the sweep",
    );
    assert.ok(digest.includes(digestRows.candidate), "the eligible candidate waits");
    assert.ok(digest.includes(digestRows.question), "the open question waits");
    assert.ok(digest.includes(digestRows.fold), "below-bar notes fold into one dim row");
    assert.equal(occurrences(digest, " · undecided"), 2, "both decisions are still open");
    await stage.settle();
    await stage.capture("airlock-digest");

    await stage.press("i", "a", "j", "c");
    const triaged = await stage.until("→ carry to #next-arc");
    assert.ok(triaged.includes(" → deliver"), "a marks the candidate deliver");
    assert.ok(
      triaged.includes("█ close #dock-v2 · enter closes"),
      "every item decided reads enter closes",
    );
    await stage.press("j", "space");
    const unfolded = await stage.until("▒ 1 below the bar");
    assert.ok(unfolded.includes("▓ Dock Lesson · uncited"), "space unfolds the below-bar note");
    await stage.settle();
    await stage.capture("airlock-triaged");

    await stage.press("j", "j", "enter");
    await stage.until("arc dock-v2 closed · delivered 1 note · 1 session released");
    const delivered = await stage.until("arc dock-v2 delivery");
    assert.ok(delivered.includes("Fold Habit"), "the delivered note lands in the workspace layer");
    const released = await stage.until("(untitled session) · now · 2e");
    assert.ok(!released.includes("#dock-v2 · "), "the archived arc leaves the garden and the tree");
    await stage.settle();
    await stage.capture("arc-delivered");
    await stage.quit();
  },
};

export const memoryAirlockStamp: Scenario = {
  name: "memory-airlock-stamp",
  description:
    "the alternative digest treatment: decisions stamped into the row lead instead of trailing the title",
  size: { width: 160, height: 40 },
  files,
  turns: [textTurn("noted.")],
  app: { memoryDigest: "stamp", clock: frozenClock },
  run: async (stage) => {
    await stage.settle();
    await stage.type("/arc dock-v2");
    await stage.press("enter");
    await stage.until("arc → dock-v2");
    await stage.type("/memory");
    await stage.press("enter");
    await stage.until("│ memory · 6 notes · ░1 ");
    await closeArcAtTheAirlock(stage);
    await stage.press("i", "a", "j", "c");
    const stamped = await stage.until("██ carry to #next-arc · Tie order");
    assert.ok(stamped.includes("█▓ deliver · Fold Habit"), "the decision stamps the lead");
    await stage.settle();
    await stage.capture("airlock-digest-stamp");
    await stage.quit();
  },
};
