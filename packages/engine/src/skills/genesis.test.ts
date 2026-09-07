import { describe, expect, it } from "vitest";
import {
  commandSequenceOf,
  recurringSequences,
  sequenceFingerprint,
  skillBodyFor,
  skillDescriptionFor,
  skillNameFor,
  skillProposalFor,
} from "./genesis.ts";

const release = "tagged: `bun run check` then `bun run test` and finally `git tag v1`";
const releaseAgain = "$ bun   run check\n$ bun run test\n$ git tag v1";

describe("commandSequenceOf", () => {
  it("reads backticked commands in order and prompted lines, normalizing whitespace", () => {
    expect(commandSequenceOf(release)).toEqual(["bun run check", "bun run test", "git tag v1"]);
    expect(commandSequenceOf(releaseAgain)).toEqual([
      "bun run check",
      "bun run test",
      "git tag v1",
    ]);
    expect(commandSequenceOf("no commands here")).toEqual([]);
  });
});

describe("recurringSequences", () => {
  it("fingerprints by the normalized sequence and needs two distinct occurrences", () => {
    const once = recurringSequences([{ id: "a", text: release }]);
    expect(once).toEqual([]);
    const twice = recurringSequences([
      { id: "a", text: release },
      { id: "b", text: releaseAgain },
    ]);
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({
      fingerprint: sequenceFingerprint(["bun run check", "bun run test", "git tag v1"]),
      occurrences: ["a", "b"],
    });
  });

  it("counts the same entry once and ignores single-command mentions", () => {
    expect(
      recurringSequences([
        { id: "a", text: release },
        { id: "a", text: release },
      ]),
    ).toEqual([]);
    expect(
      recurringSequences([
        { id: "a", text: "just `bun run check`" },
        { id: "b", text: "just `bun run check`" },
      ]),
    ).toEqual([]);
  });

  it("keeps sequences apart when the order differs", () => {
    const sequences = recurringSequences([
      { id: "a", text: "`bun run check` then `bun run test`" },
      { id: "b", text: "`bun run test` then `bun run check`" },
    ]);
    expect(sequences).toEqual([]);
  });
});

describe("skillProposalFor", () => {
  it("names the skill after the first command and carries the steps as one redactable string", () => {
    const [sequence] = recurringSequences([
      { id: "a", text: release },
      { id: "b", text: releaseAgain },
    ]);
    if (sequence === undefined) throw new Error("expected a sequence");
    const proposal = skillProposalFor(sequence);
    expect(proposal).toEqual({
      kind: "skill-proposal",
      name: "bun-run-check",
      fingerprint: sequence.fingerprint,
      commands: "bun run check\nbun run test\ngit tag v1",
      occurrences: 2,
    });
    expect(skillDescriptionFor(proposal)).toBe(
      "Run bun run check and the 2 steps that followed it, a routine seen 2 times",
    );
    expect(skillBodyFor(proposal)).toBe(
      "Run these in order, checking each before the next:\n\n1. `bun run check`\n2. `bun run test`\n3. `git tag v1`\n",
    );
  });

  it("falls back to a fingerprint name when the first command yields nothing nameable", () => {
    expect(skillNameFor({ fingerprint: "abcdef0123456789", commands: ["./~", "x"] })).toBe(
      "routine-abcdef01",
    );
  });
});
