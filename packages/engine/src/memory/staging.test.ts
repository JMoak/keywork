import { describe, expect, it } from "vitest";
import {
  describeStaged,
  isStagedWrite,
  MalformedStagedItemError,
  parseLegacyInbox,
  parseStagedMeta,
  reviewKey,
  serializeStagedMeta,
  stagedIdOfFile,
} from "./staging.ts";

const id = "00000000-0000-4000-8000-000000000001";

describe("reviewKey", () => {
  it("keys proposals by their lowercase identity", () => {
    expect(
      reviewKey({
        kind: "borderline-promotion",
        title: "Prefer PNPM",
        body: "b",
        confidence: 0.6,
        source: "d#0",
      }),
    ).toBe("promotion:prefer pnpm");
    expect(
      reviewKey({ kind: "link-proposal", note: "Setup", target: "Bun runtime", mention: "bun" }),
    ).toBe("link:setup->bun runtime");
    expect(reviewKey({ kind: "preference-proposal", toolShape: "bash git", approvals: 3 })).toBe(
      "preference:bash git",
    );
  });

  it("treats contradiction and merge keys as unordered pairs", () => {
    const forward = reviewKey({
      kind: "contradiction",
      a: "Uses npm",
      b: "Uses pnpm",
      aProvenance: "user",
      bProvenance: "agent",
      confidence: 0.9,
    });
    const backward = reviewKey({
      kind: "contradiction",
      a: "Uses pnpm",
      b: "Uses npm",
      aProvenance: "agent",
      bProvenance: "user",
      confidence: 0.9,
    });
    expect(forward).toBe(backward);
    expect(reviewKey({ kind: "merge-proposal", keep: "B", retire: "A", confidence: 1 })).toBe(
      reviewKey({ kind: "merge-proposal", keep: "a", retire: "b", confidence: 1 }),
    );
  });
});

describe("staged sidecars", () => {
  it("round-trips write metadata and review metadata through one grammar", () => {
    const write = { kind: "note" as const, target: "Planted.md", created: "2026-08-10T00:00:00Z" };
    const review = {
      kind: "arc-question" as const,
      arc: "dock-v2",
      note: "Tie order",
      key: "arc-question:dock-v2:tie order",
      created: "2026-08-10T00:00:00Z",
    };
    expect(parseStagedMeta(serializeStagedMeta(write), "x.json")).toEqual(write);
    expect(parseStagedMeta(serializeStagedMeta(review), "x.json")).toEqual(review);
  });

  it("keeps an optional supersedes only when present", () => {
    const meta = parseStagedMeta(
      JSON.stringify({ kind: "note", target: "New.md", created: "c", supersedes: "Old" }),
      "x.json",
    );
    expect(meta).toEqual({ kind: "note", target: "New.md", created: "c", supersedes: "Old" });
    expect(
      "supersedes" in
        parseStagedMeta(JSON.stringify({ kind: "note", target: "N.md", created: "c" }), "x"),
    ).toBe(false);
  });

  it.each([
    ["not json", "not valid JSON"],
    ["[]", "not an object"],
    [JSON.stringify({ kind: "wat", created: "c" }), 'unknown kind "wat"'],
    [
      JSON.stringify({ kind: "note", target: "../out.md", created: "c" }),
      "target: leaves the vault",
    ],
    [JSON.stringify({ kind: "note", created: "c" }), "target"],
    [JSON.stringify({ kind: "contradiction", a: "x", key: "k", created: "c" }), "b"],
    [JSON.stringify({ kind: "arc-question", arc: "a", note: "n" }), "key"],
  ])("rejects %j with a typed error naming the file", (raw, detail) => {
    const failure = (() => {
      try {
        parseStagedMeta(raw, ".staging/x.json");
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(MalformedStagedItemError);
    expect((failure as MalformedStagedItemError).file).toBe(".staging/x.json");
    expect((failure as MalformedStagedItemError).message).toContain(detail);
  });

  it("drops unknown fields so a legacy id never leaks into a sidecar", () => {
    const meta = parseStagedMeta(
      JSON.stringify({ kind: "arc-question", arc: "a", note: "n", key: "k", created: "c", id }),
      "x.json",
    );
    expect("id" in meta).toBe(false);
  });
});

describe("parseLegacyInbox", () => {
  it("reads the old inbox.json array into review metadata", () => {
    const legacy = [
      {
        id,
        kind: "preference-proposal",
        toolShape: "bash git",
        approvals: 3,
        key: "k",
        created: "c",
      },
    ];
    expect(parseLegacyInbox(JSON.stringify(legacy), ".staging/inbox.json")).toEqual([
      { kind: "preference-proposal", toolShape: "bash git", approvals: 3, key: "k", created: "c" },
    ]);
  });

  it("rejects anything that is not an array of review items", () => {
    expect(() => parseLegacyInbox("{}", "inbox.json")).toThrow(MalformedStagedItemError);
    expect(() => parseLegacyInbox("[1]", "inbox.json")).toThrow(MalformedStagedItemError);
    expect(() => parseLegacyInbox(JSON.stringify([{ kind: "note" }]), "inbox.json")).toThrow(
      MalformedStagedItemError,
    );
  });
});

describe("staged ids", () => {
  it("recognizes only uuid-named json sidecars", () => {
    expect(stagedIdOfFile(`${id}.json`)).toBe(id);
    expect(stagedIdOfFile(`${id}.md`)).toBeUndefined();
    expect(stagedIdOfFile("ask-gate.json")).toBeUndefined();
    expect(stagedIdOfFile("inbox.json")).toBeUndefined();
  });
});

describe("describeStaged", () => {
  it("names writes by target and reviews by key", () => {
    const write = {
      id,
      kind: "daily" as const,
      target: "daily/2026-08-10.md",
      created: "c",
      content: "x",
    };
    const review = {
      id,
      kind: "arc-question" as const,
      arc: "a",
      note: "n",
      key: "arc-question:a:n",
      created: "c",
    };
    expect(isStagedWrite(write)).toBe(true);
    expect(isStagedWrite(review)).toBe(false);
    expect(describeStaged(write)).toBe("daily → daily/2026-08-10.md");
    expect(describeStaged(review)).toBe("arc-question:a:n");
  });
});
