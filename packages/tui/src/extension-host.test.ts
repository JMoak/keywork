import type { ExtensionNotice, ExtensionStatus } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { CommandRegistry } from "./commands.ts";
import {
  type ExtensionHostPort,
  type ExtensionHostSeams,
  extensionListingCommand,
  extensionStartupNotice,
  registerHostedCommands,
  routeExtensionNotice,
  watchExtensionNotices,
} from "./extension-host.ts";
import { waitFor } from "./testing/index.ts";

interface Recorded {
  seams: ExtensionHostSeams;
  statusBar: string[];
  feed: string[];
}

function recordedSeams(paneOpen = true): Recorded {
  const statusBar: string[] = [];
  const feed: string[] = [];
  return {
    statusBar,
    feed,
    seams: {
      notice: (text) => void statusBar.push(text),
      post: (text) => {
        if (!paneOpen) return false;
        feed.push(text);
        return true;
      },
    },
  };
}

function portOf(overrides: Partial<ExtensionHostPort> = {}): ExtensionHostPort {
  return {
    extensions: () => [],
    registrations: () => ({ tools: [], commands: [], shortcuts: [], flags: [] }),
    skipped: [],
    commands: () => [],
    runCommand: async () => undefined,
    onNotice: () => () => undefined,
    ...overrides,
  };
}

const greeter: ExtensionStatus = { name: "greeter", source: "project", standing: "active" };
const broken: ExtensionStatus = {
  name: "broken",
  source: "user",
  standing: "quarantined",
  failure: { phase: "load", reason: "no default export" },
};

describe("extension notices in the TUI", () => {
  it("sends warn and error to the status bar and info to the focused pane's feed", () => {
    const { seams, statusBar, feed } = recordedSeams();
    const notice = (level: ExtensionNotice["level"]): ExtensionNotice => ({
      extension: "greeter",
      level,
      message: `${level} line`,
    });
    routeExtensionNotice(notice("error"), seams);
    routeExtensionNotice(notice("warn"), seams);
    routeExtensionNotice(notice("info"), seams);
    expect(statusBar).toEqual(["greeter: error line", "greeter: warn line"]);
    expect(feed).toEqual(["greeter: info line"]);
  });

  it("drops info with no pane open and keeps listening through the port", () => {
    const { seams, statusBar, feed } = recordedSeams(false);
    let listener: ((notice: ExtensionNotice) => void) | undefined;
    const stop = watchExtensionNotices(
      portOf({
        onNotice: (given) => {
          listener = given;
          return () => {
            listener = undefined;
          };
        },
      }),
      seams,
    );
    listener?.({ extension: "greeter", level: "info", message: "quiet" });
    listener?.({ extension: "greeter", level: "warn", message: "loud" });
    expect(feed).toEqual([]);
    expect(statusBar).toEqual(["greeter: loud"]);
    stop();
    expect(listener).toBeUndefined();
  });

  it("summarizes load-time quarantines for the startup status bar", () => {
    expect(extensionStartupNotice(portOf({ extensions: () => [greeter] }))).toBeUndefined();
    expect(extensionStartupNotice(portOf({ extensions: () => [greeter, broken] }))).toBe(
      'extension "broken" quarantined during load: no default export',
    );
    expect(
      extensionStartupNotice(portOf({ extensions: () => [broken, { ...broken, name: "worse" }] })),
    ).toBe('extension "broken" quarantined during load: no default export (+1 more)');
  });
});

describe("/extensions", () => {
  it("prints the listing into the focused pane", () => {
    const { seams, feed, statusBar } = recordedSeams();
    const command = extensionListingCommand(
      portOf({
        extensions: () => [greeter, broken],
        registrations: (name) => ({
          tools: name === "greeter" ? ["greet"] : [],
          commands: name === "greeter" ? ["hello"] : [],
          shortcuts: [],
          flags: [],
        }),
      }),
      seams,
    );
    command.run(undefined);
    expect(statusBar).toEqual([]);
    expect(feed).toEqual([
      [
        "1 extension active · 1 quarantined",
        "  greeter  project  active       1 tool · 1 command",
        "  broken   user     quarantined  load: no default export",
      ].join("\n"),
    ]);
  });

  it("falls back to a one-line count on the status bar with no pane", () => {
    const { seams, statusBar } = recordedSeams(false);
    extensionListingCommand(portOf({ extensions: () => [greeter, broken] }), seams).run(undefined);
    expect(statusBar).toEqual([
      "extensions: 1 active · 1 quarantined · open a conversation to print the list into",
    ]);
  });
});

describe("hosted extension commands", () => {
  it("registers each command, posts its output, and reports collisions", async () => {
    const registry = new CommandRegistry();
    registry.register({ name: "exit", description: "taken", run: () => undefined });
    const ran: string[] = [];
    const { seams, feed, statusBar } = recordedSeams();
    const shadowed = registerHostedCommands(
      registry,
      portOf({
        commands: () => [
          { name: "hello", extension: "greeter", run: () => undefined },
          { name: "exit", extension: "greeter", run: () => undefined },
        ],
        runCommand: async (name, args) => {
          ran.push(`${name}:${args}`);
          return name === "hello" ? `hello ${args}` : undefined;
        },
      }),
      seams,
    );
    expect(shadowed).toEqual([{ name: "exit", claimedBy: "exit" }]);
    const hello = registry.search("hello")[0];
    expect(hello?.description).toBe("greeter extension command: /hello");
    hello?.run("world");
    await waitFor(() => expect(feed).toEqual(["hello world"]));
    expect(ran).toEqual(["hello:world"]);
    expect(statusBar).toEqual([]);
  });

  it("notices a failed command instead of throwing", async () => {
    const registry = new CommandRegistry();
    const { seams, statusBar } = recordedSeams();
    registerHostedCommands(
      registry,
      portOf({
        commands: () => [{ name: "boom", extension: "fragile", run: () => undefined }],
        runCommand: async () => {
          throw new Error("went sideways");
        },
      }),
      seams,
    );
    registry.search("boom")[0]?.run(undefined);
    await waitFor(() => expect(statusBar).toEqual(["/boom failed: went sideways"]));
  });
});
