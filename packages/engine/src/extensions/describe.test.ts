import { describe, expect, it } from "vitest";
import {
  describeExtensions,
  extensionLoadNotices,
  noExtensionsLine,
  summarizeExtensions,
} from "./describe.ts";
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

  it("teaches where to put one when nothing loaded and names skipped layers", () => {
    expect(
      describeExtensions({
        statuses: [],
        skipped: [{ source: "project", dir: "/p/.keywork/extensions", reason: "untrusted" }],
        registrations: () => none,
      }),
    ).toEqual([noExtensionsLine, "  project layer skipped · /p/.keywork/extensions · untrusted"]);
  });

  it("counts standings and rebuilds the load-time quarantine lines", () => {
    expect(summarizeExtensions(statuses)).toEqual({ active: 2, quarantined: 1, deactivated: 0 });
    expect(extensionLoadNotices({ statuses })).toEqual([
      'extension "broken" quarantined during load: the module must export a default function',
    ]);
  });
});
