import { Agent, MockProvider } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import type { SessionExporter } from "./app-core.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { AppProbe } from "./probe.ts";
import { waitFor } from "./testing/index.ts";

describe("/export", () => {
  it("exports the focused session with the typed arguments and says where it went", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const probe = probeWith(async (sessionId, args) => {
      calls.push([sessionId, args]);
      return "/sessions/s-1.tree.html";
    }, "s-1");

    expect(probe.command("export tree")).toBe(true);

    await waitFor(() => expect(probe.snapshot().notice).toBe("exported → /sessions/s-1.tree.html"));
    expect(calls).toEqual([["s-1", "tree"]]);
  });

  it("passes a bare /export through with no arguments", async () => {
    const calls: Array<string | undefined> = [];
    const probe = probeWith(async (_sessionId, args) => {
      calls.push(args);
      return "/sessions/s-1.html";
    }, "s-1");

    probe.command("export");

    await waitFor(() => expect(calls).toEqual([undefined]));
  });

  it("reports a failed export in the notice", async () => {
    const probe = probeWith(async () => {
      throw new Error("EACCES: permission denied");
    }, "s-1");

    probe.command("export");

    await waitFor(() => expect(probe.snapshot().notice).toBe("EACCES: permission denied"));
  });

  it("says so when the pane has no session yet", () => {
    const calls: string[] = [];
    const probe = probeWith(async (sessionId) => {
      calls.push(sessionId);
      return "";
    }, undefined);

    probe.command("export");

    expect(probe.snapshot().notice).toBe("nothing to export · no session here yet");
    expect(calls).toEqual([]);
  });

  it("is absent when nothing can export", () => {
    expect(new AppProbe().command("export")).toBe(false);
  });
});

function probeWith(exportSession: SessionExporter, sessionId: string | undefined): AppProbe {
  return new AppProbe({
    exportSession,
    createPane: (id, notify, commands) => {
      const agent = new Agent({ provider: new MockProvider([]) });
      const pane = new ConversationPane(id, agent, notify, undefined, commands);
      pane.sessionId = sessionId;
      return pane;
    },
  });
}
