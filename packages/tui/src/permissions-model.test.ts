import type { PermissionDecision, PermissionsView, ToolCallPart } from "@keywork/engine";
import { type PermissionRule, SessionGrants, trustedReadRules } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import {
  bundleSummary,
  firstEncounterLine,
  PermissionsModel,
  type PermissionsPort,
  type PermissionsSeat,
  permissionsKeyHint,
  type QuietRun,
  QuietRunLog,
  quietReasonOf,
  quietRunLine,
} from "./permissions-model.ts";

const allowBash = (resource: string): PermissionRule => ({
  action: "bash",
  resource,
  effect: "allow",
});

interface HarnessOptions {
  session?: SessionGrants;
  trusted?: boolean;
  seat?: PermissionsSeat;
  quiet?: QuietRun;
  unreachable?: string;
}

function port(
  workspace: PermissionRule[],
  { trusted = true, seat = "pane", unreachable }: HarnessOptions,
): PermissionsPort & { held: PermissionRule[] } {
  const held = [...workspace];
  const reachable = (): void => {
    if (unreachable !== undefined) throw new Error(unreachable);
  };
  return {
    held,
    seat,
    view: async (): Promise<PermissionsView> => {
      reachable();
      return {
        trusted,
        bundle: trusted ? [...trustedReadRules] : [],
        workspace: [...held],
        session: {},
      };
    },
    revokeWorkspace: async (rule) => {
      reachable();
      const at = held.findIndex((candidate) => candidate.resource === rule.resource);
      if (at < 0) return false;
      held.splice(at, 1);
      return true;
    },
    recordedAt: () => new Date(2026, 9, 12, 14, 2),
  };
}

async function harness(workspace: PermissionRule[], options: HarnessOptions = {}) {
  const notices: string[] = [];
  const grants = port(workspace, options);
  const { session, quiet } = options;
  const model = new PermissionsModel(grants, {
    notify: () => undefined,
    notice: (text) => notices.push(text),
    focused:
      session === undefined
        ? undefined
        : {
            session: () => ({
              rules: async () => session.rules,
              forget: async (rule) => session.forget(rule),
            }),
            lastQuietRun: () => quiet,
          },
  });
  await model.refresh();
  const press = async (key: string) => {
    model.handleKey(parseChord(key));
    await settled();
  };
  return { model, grants, notices, texts: () => textsOf(model), press };
}

function textsOf(model: PermissionsModel): string[] {
  return model.rows().map((row) => row.spans.map((span) => span.text).join(""));
}

function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("PermissionsModel rows", () => {
  it("lists the three groups with the bundle folded and the key hint last", async () => {
    const session = new SessionGrants();
    session.remember("bash", { command: "npm run build" });
    const { texts } = await harness([allowBash("git push *")], { session });

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
    ).toBe("trusted reads · 40 read-only commands run, 11 write forms ask · your rules win");
  });

  it("teaches the bundle and how a grant happens on a first look with nothing granted or run", async () => {
    const { texts } = await harness([], { session: new SessionGrants() });
    expect(texts()[0]).toBe(
      "trusted reads just run · [a] on an ask grants this session, the app can grant the workspace",
    );
    expect(texts().filter((text) => text.includes("[a] on an ask"))).toHaveLength(1);
  });

  it("says when the bundle is off and when there is nothing granted", async () => {
    const { texts } = await harness([], { session: new SessionGrants(), trusted: false });
    expect(texts()).toEqual([
      "nothing's granted yet · [a] on an ask grants this session, the app can grant the workspace",
      "trusted reads · off until this folder is trusted",
      "workspace grants · none yet",
      "session grants · none this session",
      permissionsKeyHint,
    ]);
  });

  it("points an attached seat at the app, since its pane can't answer asks", async () => {
    const view = { trusted: true, bundle: [], workspace: [], session: {} };
    expect(firstEncounterLine(view, "attached")).toBe(
      "trusted reads just run · grants come from answering an ask in the app with a scope",
    );
    const { texts } = await harness([], { session: new SessionGrants(), seat: "attached" });
    expect(texts()[0]).toBe(firstEncounterLine(view, "attached"));
  });

  it("drops the lesson once something ran quietly or a grant exists", async () => {
    const quiet: QuietRun = { summary: "git status", reason: "trusted", shellEscape: true };
    const ran = await harness([], { session: new SessionGrants(), quiet });
    expect(ran.texts()[0]).toBe("ran without asking · shell escape !git status · trusted reads");
    const granted = await harness([allowBash("git push *")], { session: new SessionGrants() });
    expect(granted.texts()[0]).toBe("nothing has run without asking yet");
  });

  it("says it is checking until the grants arrive, and why when they can't", async () => {
    const reading = new PermissionsModel(port([], {}), {
      notify: () => undefined,
      notice: () => undefined,
    });
    expect(textsOf(reading)).toEqual(["checking grants", permissionsKeyHint]);
    const { texts } = await harness([], { unreachable: "the server answered 401" });
    expect(texts()).toEqual(["can't read grants · the server answered 401", permissionsKeyHint]);
  });

  it("unfolds the bundle on b, every rule present, and folds it again", async () => {
    const { model, texts } = await harness([]);
    model.handleKey(parseChord("b"));
    const unfolded = texts().join("\n");
    for (const rule of trustedReadRules) expect(unfolded).toContain(rule.resource);
    expect(unfolded).toContain("still asks:");
    model.handleKey(parseChord("b"));
    expect(texts()).toHaveLength(5);
  });

  it("windows the rows around the selection when the panel is short", async () => {
    const { model } = await harness([allowBash("a *"), allowBash("b *"), allowBash("c *")]);
    model.handleKey(parseChord("b"));
    model.handleKey(parseChord("down"));
    model.handleKey(parseChord("down"));
    const window = model.rows(6);
    expect(window).toHaveLength(6);
    expect(window.some((row) => row.selected)).toBe(true);
  });
});

describe("PermissionsModel keys", () => {
  it("moves across workspace and session grants and wraps", async () => {
    const session = new SessionGrants();
    session.remember("bash", { command: "npm run build" });
    const { model } = await harness([allowBash("git push *")], { session });
    expect(model.selected()?.rule.resource).toBe("git push *");
    model.handleKey(parseChord("down"));
    expect(model.selected()?.layer).toBe("session");
    model.handleKey(parseChord("down"));
    expect(model.selected()?.layer).toBe("workspace");
    model.handleKey(parseChord("up"));
    expect(model.selected()?.layer).toBe("session");
  });

  it("revokes the selected workspace grant on r through the port", async () => {
    const { grants, notices, texts, press } = await harness([allowBash("git push *")]);
    await press("r");
    expect(grants.held).toEqual([]);
    expect(notices).toEqual(["revoked bash git push * · it asks again from the next call on"]);
    expect(texts()).toContain("workspace grants · none yet");
  });

  it("drops the selected session grant on d and refuses the wrong layer", async () => {
    const session = new SessionGrants();
    session.remember("bash", { command: "npm run build" });
    const { model, grants, notices, press } = await harness([allowBash("git push *")], {
      session,
    });
    await press("d");
    expect(notices).toEqual(["pick a session grant to drop"]);
    await press("down");
    await press("r");
    expect(notices.at(-1)).toBe("pick a workspace grant to revoke");
    await press("d");
    expect(session.rules).toEqual([]);
    expect(grants.held).toEqual([allowBash("git push *")]);
    expect(notices.at(-1)).toBe("dropped bash npm run * for this session");
    expect(model.selected()?.layer).toBe("workspace");
  });

  it("says why a revoke failed instead of claiming it worked", async () => {
    const grants = port([allowBash("git push *")], {});
    const notices: string[] = [];
    const model = new PermissionsModel(
      {
        ...grants,
        revokeWorkspace: async () => {
          throw new Error("lost the server");
        },
      },
      { notify: () => undefined, notice: (text) => notices.push(text) },
    );
    await model.refresh();
    model.handleKey(parseChord("r"));
    await settled();
    expect(notices).toEqual(["couldn't revoke bash git push * · lost the server"]);
    expect(textsOf(model)).toContain("▸ bash git push *");
  });

  it("closes on escape and q, never on ctrl chords", async () => {
    const { model } = await harness([]);
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
