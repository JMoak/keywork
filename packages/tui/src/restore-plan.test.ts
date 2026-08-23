import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRestorePlan, type WorkspacePort } from "./restore-plan.ts";
import { type SessionAttachment, sessionEscrow } from "./session-attachment.ts";
import type { WorkspaceState } from "./workspace-state.ts";

function stateWith(panes: WorkspaceState["panes"]): unknown {
  return {
    version: 2,
    layout: {
      tree:
        panes.length === 1
          ? { kind: "leaf", id: panes[0]?.id }
          : {
              kind: "split",
              orientation: "row",
              ratio: 0.5,
              first: { kind: "leaf", id: panes[0]?.id },
              second: { kind: "leaf", id: panes[1]?.id },
            },
      focused: panes[0]?.id,
    },
    panes,
  };
}

function workspaceLoading(value: unknown): WorkspacePort {
  return { load: async () => value, save: () => {}, seal: () => {} };
}

function attachmentOf(id: string): SessionAttachment {
  return { id, history: [], replay: () => {}, append: async () => undefined };
}

describe("loadRestorePlan", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("starts fresh without a workspace port or a parseable state", async () => {
    const escrow = sessionEscrow(undefined);
    expect(await loadRestorePlan({}, escrow)).toEqual({ kind: "fresh" });
    expect(await loadRestorePlan({ workspace: workspaceLoading("nope") }, escrow)).toEqual({
      kind: "fresh",
    });
  });

  it("reports a rejecting port as a failure instead of aborting boot", async () => {
    const cause = new Error("disk gone");
    const workspace: WorkspacePort = {
      load: () => Promise.reject(cause),
      save: () => {},
      seal: () => {},
    };
    expect(await loadRestorePlan({ workspace }, sessionEscrow(undefined))).toEqual({
      kind: "failed",
      cause,
    });
  });

  it("keeps panes whose backing still exists and holds opened sessions in escrow", async () => {
    const root = mkdtempSync(join(tmpdir(), "keywork-restore-"));
    roots.push(root);
    writeFileSync(join(root, "notes.md"), "hi");
    const escrow = sessionEscrow(undefined);
    const opened: string[] = [];
    const plan = await loadRestorePlan(
      {
        workspace: workspaceLoading(
          stateWith([
            { id: "session-1", kind: "conversation", sessionId: "s1" },
            { id: "file-1", kind: "file", path: join(root, "notes.md") },
          ]),
        ),
        sessions: {
          open: async (id) => {
            opened.push(id);
            return attachmentOf(id);
          },
          create: async () => undefined,
        },
      },
      escrow,
    );
    expect(plan.kind).toBe("restore");
    if (plan.kind !== "restore") return;
    expect(plan.state.panes.map((pane) => pane.id)).toEqual(["session-1", "file-1"]);
    expect(opened).toEqual(["s1"]);
    expect(escrow.claim("s1")?.id).toBe("s1");
  });

  it("holds opened sessions for held panes too and drops held panes whose session is gone", async () => {
    const escrow = sessionEscrow(undefined);
    const state = stateWith([{ id: "session-1", kind: "conversation", sessionId: "s1" }]) as {
      held?: unknown;
    };
    state.held = [
      { id: "session-2", kind: "conversation", sessionId: "s2" },
      { id: "session-3", kind: "conversation", sessionId: "missing" },
    ];
    const plan = await loadRestorePlan(
      {
        workspace: workspaceLoading(state),
        sessions: {
          open: async (id) => (id === "missing" ? undefined : attachmentOf(id)),
          create: async () => undefined,
        },
      },
      escrow,
    );
    expect(plan.kind).toBe("restore");
    if (plan.kind !== "restore") return;
    expect(plan.state.held.map((pane) => pane.id)).toEqual(["session-2"]);
    expect(escrow.claim("s2")?.id).toBe("s2");
  });

  it("drops a conversation whose session cannot be opened and a file that is gone", async () => {
    const plan = await loadRestorePlan(
      {
        workspace: workspaceLoading(
          stateWith([
            { id: "session-1", kind: "conversation", sessionId: "missing" },
            { id: "file-1", kind: "file", path: join(tmpdir(), "keywork-nope", "gone.md") },
          ]),
        ),
        sessions: { open: async () => undefined, create: async () => undefined },
      },
      sessionEscrow(undefined),
    );
    expect(plan).toEqual({ kind: "fresh" });
  });
});
