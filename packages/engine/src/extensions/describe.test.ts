import { describe, expect, it } from "vitest";
import { describeExtensions } from "./describe.ts";
import type { ExtensionRegistrations, ExtensionStatus } from "./host.ts";

const none: ExtensionRegistrations = { tools: [], commands: [], shortcuts: [], flags: [] };

const statuses: ExtensionStatus[] = [
  { name: "greeter", source: "project", file: "/p/greeter.ts", standing: "active" },
  { name: "counter", source: "user", standing: "active" },
  {
    name: "broken",
    source: "user",
    standing: "quarantined",
    failure: { phase: "load", reason: "the module must export a default function" },
  },
];

const registrations: Record<string, ExtensionRegistrations> = {
  greeter: { tools: ["greet"], commands: ["hello"], shortcuts: ["ctrl+shift+g"], flags: [] },
  counter: { ...none, commands: ["count"] },
};

describe("describeExtensions", () => {
  it("tabulates name, layer, standing and registrations, with the failure where it applies", () => {
    expect(
      describeExtensions({
        statuses,
        skipped: [],
        registrations: (name) => registrations[name] ?? none,
      }),
    ).toEqual([
      "2 extensions active · 1 quarantined",
      "  greeter  project  active       1 tool · 1 command · 1 shortcut",
      "  counter  user     active       0 tools · 1 command",
      "  broken   user     quarantined  load: the module must export a default function",
    ]);
  });
});
