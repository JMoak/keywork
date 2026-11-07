import type { PermissionRule } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import {
  capabilityLines,
  creatureInjection,
  grantsHeading,
  introductionOf,
  noGrantsSentence,
} from "./prompt.ts";

const grants: PermissionRule[] = [
  { action: "read", resource: "**", effect: "allow" },
  { action: "bash", resource: "git status *", effect: "allow" },
  { action: "bash", resource: "git push *", effect: "deny" },
  { action: "write", resource: "src/**", effect: "ask" },
  { action: "bash", resource: "git status *", effect: "allow" },
];

describe("the composition sentence", () => {
  it("is the one sentence the spec names, with the creature and the keeper in it", () => {
    expect(introductionOf("Pip", "Jordan")).toBe(
      "You are Pip, Jordan's creature; you keep work moving between conversations and you ask before anything that cannot be undone.",
    );
  });
});

describe("the capability list", () => {
  it("renders one line per distinct grant in ledger order, so the last-wins reading survives", () => {
    expect(capabilityLines(grants)).toEqual([
      "- read **: allowed without asking",
      "- bash git status *: allowed without asking",
      "- bash git push *: refused",
      "- write src/**: asks first",
    ]);
  });

  it("says plainly when nothing is granted, so the creature cannot claim what it lacks", () => {
    expect(creatureInjection({ introduction: "You are Pip." }, [])).toBe(
      `You are Pip.\n\n${noGrantsSentence}`,
    );
  });

  it("follows the introduction with the grants that exist and nothing else", () => {
    const injection = creatureInjection({ introduction: "You are Pip." }, grants);
    expect(injection.startsWith(`You are Pip.\n\n${grantsHeading}\n`)).toBe(true);
    expect(injection.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(4);
  });

  it("is byte-stable for the same grants, so prefix caches hold", () => {
    const once = creatureInjection({ introduction: "You are Pip." }, grants);
    const again = creatureInjection({ introduction: "You are Pip." }, [...grants]);
    expect(again).toBe(once);
  });
});
