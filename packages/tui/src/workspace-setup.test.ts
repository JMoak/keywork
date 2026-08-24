import { describe, expect, it } from "vitest";
import { AppProbe } from "./probe.ts";
import {
  readinessNotice,
  setupPrompt,
  type WorkspaceReadiness,
  type WorkspaceSetupPort,
} from "./workspace-setup.ts";

const root = "C:\\src\\playground";

function portOver(initial: WorkspaceReadiness, reopens = true) {
  let readiness = initial;
  const setUps: number[] = [];
  const port: WorkspaceSetupPort = {
    readiness: () => readiness,
    setUp: async () => {
      setUps.push(1);
      readiness = { kind: "ready", root, vault: `${root}\\.keywork\\memory` };
      return { root, vault: `${root}\\.keywork\\memory`, reopens };
    },
  };
  return { port, setUps };
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("workspace readiness vocabulary", () => {
  it("names the missing piece and the one command that fixes it", () => {
    expect(readinessNotice({ kind: "ready", root, vault: "v" })).toBeUndefined();
    expect(readinessNotice({ kind: "undecided", root })).toContain("isn't trusted yet");
    expect(readinessNotice({ kind: "undecided", root })).toContain("/init");
    expect(readinessNotice({ kind: "undeclared", root })).toContain("/init");
    expect(readinessNotice({ kind: "refused", root })).toContain("keywork trust");
  });

  it("only asks a question when /init can act", () => {
    expect(setupPrompt({ kind: "undecided", root })).toContain(`trust ${root}?`);
    expect(setupPrompt({ kind: "undeclared", root })).toContain(`set up a workspace at ${root}?`);
    expect(setupPrompt({ kind: "ready", root, vault: "v" })).toBeUndefined();
    expect(setupPrompt({ kind: "refused", root })).toBeUndefined();
  });
});

describe("/init", () => {
  it("asks before trusting, and n leaves everything untouched", () => {
    const { port, setUps } = portOver({ kind: "undecided", root });
    const probe = new AppProbe({ workspaceSetup: port });
    probe.type("/init").keys("enter");
    expect(probe.snapshot().overlay).toBe("setup");
    expect(probe.core.setupConfirmation()).toEqual({ kind: "undecided", root });
    probe.keys("n");
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(setUps).toEqual([]);
    expect(probe.exited).toBe(false);
  });

  it("y sets the workspace up and reopens keywork with memory live", async () => {
    const { port, setUps } = portOver({ kind: "undecided", root });
    const probe = new AppProbe({ workspaceSetup: port });
    probe.command("trust");
    probe.keys("y");
    await settled();
    expect(setUps).toHaveLength(1);
    expect(probe.snapshot().notice).toBe(
      `workspace ready at ${root} · reopening with memory and arcs live`,
    );
    expect(probe.exited).toBe(true);
  });

  it("stays open when no reopen seam exists and says what to do instead", async () => {
    const { port } = portOver({ kind: "undeclared", root }, false);
    const probe = new AppProbe({ workspaceSetup: port });
    probe.command("init");
    probe.keys("enter");
    await settled();
    expect(probe.snapshot().notice).toContain("reopen keywork");
    expect(probe.exited).toBe(false);
  });

  it("reports a ready workspace and a refused folder without asking anything", () => {
    const ready = new AppProbe({
      workspaceSetup: portOver({ kind: "ready", root, vault: "vault" }).port,
    });
    ready.command("init");
    expect(ready.snapshot().overlay).toBeUndefined();
    expect(ready.snapshot().notice).toBe(`workspace ready at ${root} · memory lives in vault`);
    const refused = new AppProbe({ workspaceSetup: portOver({ kind: "refused", root }).port });
    refused.command("init");
    expect(refused.snapshot().overlay).toBeUndefined();
    expect(refused.snapshot().notice).toContain("keywork trust");
  });

  it("surfaces a failed setup as a notice and keeps the app open", async () => {
    const port: WorkspaceSetupPort = {
      readiness: () => ({ kind: "undecided", root }),
      setUp: async () => {
        throw new Error("disk is read-only");
      },
    };
    const probe = new AppProbe({ workspaceSetup: port });
    probe.command("init");
    probe.keys("y");
    await settled();
    expect(probe.snapshot().notice).toBe("disk is read-only");
    expect(probe.exited).toBe(false);
  });
});

describe("/arc before the workspace is ready", () => {
  it("explains the gate instead of opening an empty picker", () => {
    const { port } = portOver({ kind: "undecided", root });
    const probe = new AppProbe({
      workspaceSetup: port,
      arcs: {
        list: async () => [],
        create: async () => {
          throw new Error("never reached");
        },
        close: async () => ({ kind: "closed", delivered: 0, released: 0 }),
        abandon: async () => {},
      },
    });
    probe.type("/arc").keys("enter");
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(probe.snapshot().notice).toContain("isn't trusted yet");
  });
});
