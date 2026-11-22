import type { PermissionRule } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import { capabilityLines, creatureInjection, grantsHeading, noGrantsSentence } from "./prompt.ts";

const grants: PermissionRule[] = [
  { action: "read", resource: "**", effect: "allow" },
  { action: "bash", resource: "git status *", effect: "allow" },
  { action: "bash", resource: "git push *", effect: "deny" },
  { action: "write", resource: "src/**", effect: "ask" },
  { action: "bash", resource: "git status *", effect: "allow" },
];

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
});
