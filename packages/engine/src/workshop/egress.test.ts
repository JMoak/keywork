import { describe, expect, it } from "vitest";
import { type EgressRule, patternCovers, renderSbxEgress } from "./egress.ts";
import { parseWorkshopSpec, workshopSpecSchema } from "./spec.ts";

const balancedDefaults = ["*.googleapis.com", "*.npmjs.org", "api.anthropic.com"];

function rulesOf(egress: unknown): readonly EgressRule[] {
  return workshopSpecSchema.parse({ creature: "pip", substrate: "sbx", egress }).egress;
}

function allowedResources(commands: readonly (readonly string[])[]): string[] {
  return commands.filter((command) => command[1] === "allow").map((command) => command[5] ?? "");
}

describe("egress rendered to sbx policy", () => {
  it("starts from deny-all: a creature that names no host is allowed none", () => {
    expect(renderSbxEgress("stead-pip", [], [])).toEqual({
      commands: [],
      allowed: [],
      conflicts: [],
    });
  });

  it("denies every inherited allow for this sandbox, so no wildcard survives", () => {
    const rules = rulesOf([{ host: "pypi.org" }, { host: "api.anthropic.com", methods: "any" }]);

    const plan = renderSbxEgress("stead-pip", rules, balancedDefaults);

    expect(plan.conflicts).toEqual([]);
    expect(plan.commands).toEqual([
      ["policy", "deny", "network", "--sandbox", "stead-pip", "*.googleapis.com"],
      ["policy", "deny", "network", "--sandbox", "stead-pip", "*.npmjs.org"],
      [
        ...["policy", "allow", "network", "--sandbox", "stead-pip", "pypi.org"],
        ...["--method", "GET", "--method", "HEAD", "--method", "OPTIONS"],
      ],
      ["policy", "allow", "network", "--sandbox", "stead-pip", "api.anthropic.com"],
    ]);
    expect(plan.allowed).toEqual(["pypi.org", "api.anthropic.com"]);
    expect([...plan.allowed, ...allowedResources(plan.commands)].join(" ")).not.toContain("*");
  });

  it("refuses rather than narrows when an inherited wildcard covers a wanted host", () => {
    const plan = renderSbxEgress("stead-pip", rulesOf([{ host: "api.github.com" }]), [
      "*.github.com",
    ]);

    expect(plan.conflicts).toEqual([
      "api.github.com is also allowed by the inherited rule *.github.com, which this workshop must deny; remove it with: sbx policy rm network --resource *.github.com",
    ]);
  });

  it("treats an inherited exact host as a conflict when the creature wants fewer methods", () => {
    const plan = renderSbxEgress("stead-pip", rulesOf([{ host: "api.anthropic.com" }]), [
      "api.anthropic.com",
    ]);

    expect(plan.conflicts).toHaveLength(1);
  });

  it("gives general web egress GET, HEAD and OPTIONS unless a rule names more", () => {
    expect(
      rulesOf([{ host: "docs.python.org" }, { host: "api.github.com", methods: ["POST"] }]),
    ).toEqual([
      { host: "docs.python.org", methods: ["GET", "HEAD", "OPTIONS"] },
      { host: "api.github.com", methods: ["POST"] },
    ]);
  });

  it("opens non-HTTP TCP only through an explicit host and port", () => {
    const plan = renderSbxEgress("stead-pip", rulesOf([{ host: "git.example.com", port: 22 }]), []);

    expect(plan.commands).toEqual([
      ["policy", "allow", "network", "--sandbox", "stead-pip", "git.example.com:22"],
    ]);
  });

  it.each([
    ["a wildcard", "*.example.com", "wildcards never reach a workshop's egress"],
    ["a double wildcard", "**", "wildcards never reach a workshop's egress"],
    ["a scheme", "https://example.com", "a bare DNS name"],
    ["a path", "example.com/api", "a bare DNS name"],
    ["an address", "10.1.2.3", "a bare DNS name"],
  ])("refuses %s in a creature's egress", (_what, host, message) => {
    const parsed = parseWorkshopSpec({ creature: "pip", substrate: "sbx", egress: [{ host }] });

    expect(parsed).toEqual({ invalid: expect.stringContaining(message) });
  });

  it("refuses a port rule that also names methods", () => {
    const parsed = parseWorkshopSpec({
      creature: "pip",
      substrate: "sbx",
      egress: [{ host: "git.example.com", port: 22, methods: ["GET"] }],
    });

    expect(parsed).toEqual({ invalid: expect.stringContaining("carries no methods") });
  });

  it("matches inherited patterns the way sbx host wildcards read", () => {
    expect(patternCovers("*.github.com", "api.github.com")).toBe(true);
    expect(patternCovers("*.github.com", "github.com")).toBe(false);
    expect(patternCovers("**", "anything.example")).toBe(true);
    expect(patternCovers("myhost:22", "myhost")).toBe(true);
  });
});
