import { describe, expect, it } from "vitest";
import { configSchema } from "../config/schema.ts";
import { permissionRules, rulesFromLegacy } from "./rules.ts";

describe("rulesFromLegacy", () => {
  it("puts tool-wide rules first, in declaration order", () => {
    expect(rulesFromLegacy({ tools: { read: "deny", bash: "ask" } })).toEqual([
      { action: "read", resource: "*", effect: "deny" },
      { action: "bash", resource: "*", effect: "ask" },
    ]);
  });

  it("orders bash globs from least to most literal so the most specific wins last", () => {
    expect(
      rulesFromLegacy({ bash: { "git status*": "allow", "*": "ask", "git *": "ask" } }).map(
        (rule) => rule.resource,
      ),
    ).toEqual(["*", "git *", "git status*"]);
  });

  it("places the first declared of equally literal globs last", () => {
    expect(
      rulesFromLegacy({ bash: { "git*": "allow", "*git": "ask" } }).map((rule) => rule.resource),
    ).toEqual(["*git", "git*"]);
  });

  it("moves every deny to the end, so any matching deny still wins outright", () => {
    expect(
      rulesFromLegacy({ bash: { "*--force*": "deny", "git push*": "allow" } }).map(
        (rule) => rule.effect,
      ),
    ).toEqual(["allow", "deny"]);
  });
});

describe("permissionRules", () => {
  it("passes an ordered list through untouched", () => {
    const rules = [{ action: "read", resource: "**/.env*", effect: "deny" as const }];
    expect(permissionRules(rules)).toBe(rules);
  });

  it("reads nothing as no rules", () => {
    expect(permissionRules(undefined)).toEqual([]);
    expect(permissionRules({})).toEqual([]);
  });
});

describe("migrated rules", () => {
  it("form a config the schema accepts, so a preset switch can write them back", () => {
    const migrated = rulesFromLegacy({
      tools: { bash: "ask" },
      bash: { "git *": "allow", "rm *": "deny" },
    });
    expect(configSchema.parse({ permissions: migrated }).permissions).toEqual(migrated);
  });
});
