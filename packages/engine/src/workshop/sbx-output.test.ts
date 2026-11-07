import { describe, expect, it } from "vitest";
import {
  allowedFor,
  compareVersions,
  healthIn,
  policyRulesIn,
  UnreadableSbxOutput,
  versionOf,
} from "./sbx-output.ts";

const listing = [
  "SANDBOX            AGENT           STATUS                      PORTS                      WORKSPACE         CREATED",
  "my-sandbox         claude          ● running                   127.0.0.1:8080->3000/tcp4  /home/user/proj   2m",
  "stead-pip-0a1b2c   stead-workshop  ● running (not responding)                                               1h",
  "stead-wren-9f8e7d  stead-workshop  ○ stopped                                                                3d",
  "stead-moss-111111  stead-workshop  ● starting                                                               1s",
].join("\n");

describe("reading sbx output", () => {
  it.each([
    ["my-sandbox", "up"],
    ["stead-pip-0a1b2c", "unresponsive"],
    ["stead-wren-9f8e7d", "down"],
    ["stead-moss-111111", "starting"],
    ["stead-gone-000000", "down"],
  ])("reads %s from sbx ls as %s", (sandbox, health) => {
    expect(healthIn(listing, sandbox)).toBe(health);
  });

  it("reads the version out of whatever line sbx prints", () => {
    expect(versionOf("sbx version v0.45.1 (9d79d90)\n")).toBe("0.45.1");
    expect(() => versionOf("sbx: command not found")).toThrow(UnreadableSbxOutput);
  });

  it("orders versions numerically", () => {
    expect(compareVersions("0.45.1", "0.46.0")).toBe(-1);
    expect(compareVersions("0.100.0", "0.99.9")).toBe(1);
    expect(compareVersions("0.45.1", "0.45.1")).toBe(0);
  });

  it("collects the network allows that reach one sandbox from sbx policy ls", () => {
    const rules = policyRulesIn(
      [
        "SCOPE              TYPE      DECISION   RESOURCES",
        "(global)           network   allow      *.googleapis.com,api.anthropic.com",
        "(global)           network   deny       ads.example.com",
        "stead-pip-0a1b2c   network   allow      pypi.org",
        "stead-wren-9f8e7d  network   allow      crates.io",
      ].join("\n"),
    );

    expect(allowedFor(rules, "stead-pip-0a1b2c")).toEqual([
      "*.googleapis.com",
      "api.anthropic.com",
      "pypi.org",
    ]);
  });

  it("refuses to guess at a policy table it cannot read", () => {
    expect(() => policyRulesIn("ID  KIND  TARGET\n1  net  example.com")).toThrow(
      UnreadableSbxOutput,
    );
  });

  it("reads an empty policy as no rules", () => {
    expect(policyRulesIn("")).toEqual([]);
  });
});
