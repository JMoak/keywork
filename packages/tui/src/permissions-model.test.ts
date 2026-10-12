import type { PermissionDecision, PermissionsView, ToolCallPart } from "@keywork/engine";
import { type PermissionRule, SessionGrants, trustedReadRules } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import {
  bundleSummary,
  PermissionsModel,
  type PermissionsPort,
  permissionsKeyHint,
  QuietRunLog,
  quietReasonOf,
  quietRunLine,
} from "./permissions-model.ts";

const allowBash = (resource: string): PermissionRule => ({
  action: "bash",
  resource,
  effect: "allow",
});

function port(
  workspace: PermissionRule[],
  trusted = true,
): PermissionsPort & { held: PermissionRule[] } {
  const held = [...workspace];
  return {
    held,
    view: (): PermissionsView => ({
      trusted,
      bundle: trusted ? [...trustedReadRules] : [],
      workspace: [...held],
      session: {},
    }),
    revokeWorkspace: (rule) => {
      const at = held.findIndex((candidate) => candidate.resource === rule.resource);
      if (at < 0) return false;
      held.splice(at, 1);
      return true;
    },
    recordedAt: () => new Date(2026, 9, 12, 14, 2),
  };
}

function harness(workspace: PermissionRule[], session?: SessionGrants, trusted = true) {
  const notices: string[] = [];
  let notified = 0;
  const grants = port(workspace, trusted);
  const model = new PermissionsModel(grants, {
    notify: () => {
      notified += 1;
    },
    notice: (text) => notices.push(text),
    focused:
      session === undefined
        ? undefined
        : {
            session: () => ({ rules: () => session.rules, forget: (rule) => session.forget(rule) }),
            lastQuietRun: () => undefined,
          },
  });
  const texts = () => model.rows().map((row) => row.spans.map((span) => span.text).join(""));
  return { model, grants, notices, texts, notified: () => notified };
}

describe("PermissionsModel rows", () => {
  it("lists the three groups with the bundle folded and the key hint last", () => {
    const session = new SessionGrants();
    session.remember("bash", { command: "npm run build" });
    const { texts } = harness([allowBash("git push *")], session);

    expect(texts()).toEqual([
      "nothing has run without asking yet",
      bundleSummary({ trusted: true, bundle: [...trustedReadRules], workspace: [], session: {} }),
      "workspace grants · last changed 2026-10-12 14:02",
      "▸ bash git push *",
      "session grants · this pane",
      "  bash npm run *",
      permissionsKeyHint,
    ]);
    expect(
      bundleSummary({ trusted: true, bundle: [...trustedReadRules], workspace: [], session: {} }),
    ).toBe(
      "trusted reads · 40 read-only commands run, 11 write forms still ask · fixed in keywork, your rules win",
    );
  });

  it("says when the bundle is off and when there is nothing granted", () => {
    const { texts } = harness([], new SessionGrants(), false);
    expect(texts()).toEqual([
      "nothing has run without asking yet",
      "trusted reads · off until this folder is trusted",
      "workspace grants · none yet",
      "session grants · none this session",
      permissionsKeyHint,
    ]);
  });

  it("unfolds the bundle on b, every rule present, and folds it again", () => {
    const { model, texts } = harness([]);
    model.handleKey(parseChord("b"));
    const unfolded = texts().join("\n");
    for (const rule of trustedReadRules) expect(unfolded).toContain(rule.resource);
    expect(unfolded).toContain("still asks:");
    model.handleKey(parseChord("b"));
    expect(texts()).toHaveLength(5);
  });

  it("windows the rows around the selection when the panel is short", () => {
    const { model } = harness([allowBash("a *"), allowBash("b *"), allowBash("c *")]);
    model.handleKey(parseChord("b"));
    model.handleKey(parseChord("down"));
    model.handleKey(parseChord("down"));
    const window = model.rows(6);
    expect(window).toHaveLength(6);
    expect(window.some((row) => row.selected)).toBe(true);
  });
});

describe("PermissionsModel keys", () => {
  it("moves across workspace and session grants and wraps", () => {
    const session = new SessionGrants();
    session.remember("bash", { command: "npm run build" });
    const { model } = harness([allowBash("git push *")], session);
    expect(model.selected()?.rule.resource).toBe("git push *");
    model.handleKey(parseChord("down"));
    expect(model.selected()?.layer).toBe("session");
    model.handleKey(parseChord("down"));
    expect(model.selected()?.layer).toBe("workspace");
    model.handleKey(parseChord("up"));
    expect(model.selected()?.layer).toBe("session");
  });

  it("revokes the selected workspace grant on r through the port", () => {
    const { model, grants, notices, texts } = harness([allowBash("git push *")]);
    model.handleKey(parseChord("r"));
    expect(grants.held).toEqual([]);
    expect(notices).toEqual(["revoked bash git push * · it asks again from the next call on"]);
    expect(texts()).toContain("workspace grants · none yet");
  });

  it("drops the selected session grant on d and refuses the wrong layer", () => {
    const session = new SessionGrants();
    session.remember("bash", { command: "npm run build" });
    const { model, grants, notices } = harness([allowBash("git push *")], session);
    model.handleKey(parseChord("d"));
    expect(notices).toEqual(["pick a session grant to drop"]);
    model.handleKey(parseChord("down"));
    model.handleKey(parseChord("r"));
    expect(notices.at(-1)).toBe("pick a workspace grant to revoke");
    model.handleKey(parseChord("d"));
    expect(session.rules).toEqual([]);
    expect(grants.held).toEqual([allowBash("git push *")]);
    expect(notices.at(-1)).toBe("dropped bash npm run * for this session");
    expect(model.selected()?.layer).toBe("workspace");
  });

  it("closes on escape and q, never on ctrl chords", () => {
    const { model } = harness([]);
    expect(model.handleKey(parseChord("ctrl+r"))).toBe("stay");
    expect(model.handleKey(parseChord("q"))).toBe("close");
    expect(model.handleKey(parseChord("escape"))).toBe("close");
  });
});

describe("QuietRunLog", () => {
  const call = (callId: string, command: string): ToolCallPart => ({
    type: "tool-call",
    callId,
    name: "bash",
    arguments: { command },
  });
  const decision = (
    callId: string,
    gate: PermissionDecision["gate"],
    scope?: PermissionDecision["scope"],
  ): PermissionDecision => ({
    tool: "bash",
    callId,
    verdict: "granted",
    gate,
    ...(scope !== undefined && { scope }),
  });

  function bus() {
    const listeners = new Map<string, (payload: unknown) => void>();
    return {
      on: (type: string, listener: (payload: never) => void) => {
        listeners.set(type, listener as (payload: unknown) => void);
        return () => listeners.delete(type);
      },
      started: (part: ToolCallPart) => listeners.get("tool.started")?.({ call: part }),
      decided: (verdict: PermissionDecision) =>
        listeners.get("gate.permission")?.({ decision: verdict }),
    };
  }

  it("names the last call that ran under the bundle or a grant, in either event order", () => {
    const log = new QuietRunLog();
    const events = bus();
    log.follow(events);
    events.started(call("c1", "git status"));
    events.decided(decision("c1", "trusted"));
    expect(log.lastQuietRun).toEqual({ summary: "git status", reason: "trusted" });
    events.decided(decision("c2", "user", "workspace"));
    events.started(call("c2", "git push origin main"));
    expect(quietRunLine(log.lastQuietRun)).toBe(
      "ran without asking · git push origin main · workspace grant",
    );
  });

  it("ignores asks answered once, policy allows and denials", () => {
    expect(quietReasonOf(decision("c", "user", "once"))).toBeUndefined();
    expect(quietReasonOf(decision("c", "policy"))).toBeUndefined();
    expect(quietReasonOf({ ...decision("c", "trusted"), verdict: "denied" })).toBeUndefined();
    expect(quietReasonOf(decision("c", "user", "session"))).toBe("session");
  });
});
