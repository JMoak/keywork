import { describe, expect, it } from "vitest";
import type { PermissionResolver } from "../agent.ts";
import { type CreatureSessionKind, creatureSessionKinds } from "../creatures/sessions.ts";
import type { ToolCallPart } from "../messages.ts";
import { mutatingToolNames } from "../mutations.ts";
import { acceptedGrantRules, postureResolver, readOnlyRefusal, sessionPosture } from "./posture.ts";
import type { ToolPosture } from "./routine.ts";

const allowEverything: PermissionResolver = () => "allow";

function call(name: string): ToolCallPart {
  return { type: "tool-call", callId: `c-${name}`, name, arguments: {} };
}

describe("a read-only chore's permission resolver", () => {
  it.each([...mutatingToolNames])(
    "denies %s without asking, whatever the keeper's rules allow",
    (tool) => {
      const resolve = postureResolver(() => "read-only", allowEverything);
      expect(resolve(call(tool))).toEqual({ permission: "deny", gate: "policy" });
      expect(resolve(call(tool))).toBe(readOnlyRefusal);
    },
  );

  it("leaves reading tools to the keeper's rules", () => {
    const resolve = postureResolver(() => "read-only", allowEverything);
    expect(resolve(call("read"))).toBe("allow");
    expect(resolve(call("grep"))).toBe("allow");
  });

  it("follows the posture as it changes, so a confinement lifted later stops denying", () => {
    let posture: ToolPosture | undefined = "read-only";
    const resolve = postureResolver(() => posture, allowEverything);
    expect(resolve(call("write"))).toBe(readOnlyRefusal);
    posture = "write";
    expect(resolve(call("write"))).toBe("allow");
    posture = undefined;
    expect(resolve(call("bash"))).toBe("allow");
  });

  it("answers nothing of its own for an unconfined session without base rules", () => {
    expect(postureResolver(() => undefined, undefined)(call("bash"))).toBeUndefined();
  });
});

describe("a session's posture", () => {
  it("is read-only for a chore's thread until the run confines it otherwise", () => {
    expect(sessionPosture("routine", undefined)).toBe("read-only");
    expect(sessionPosture("routine", "act")).toBe("act");
  });

  it("is unconfined for the conversation, threads and children unless a run says so", () => {
    expect(sessionPosture("conversation", undefined)).toBeUndefined();
    expect(sessionPosture("thread", undefined)).toBeUndefined();
    expect(sessionPosture("child", undefined)).toBeUndefined();
    expect(sessionPosture(undefined, undefined)).toBeUndefined();
    expect(sessionPosture(undefined, "read-only")).toBe("read-only");
  });

  it("is decided for every kind of creature session, so a new kind cannot slip in unconfined", () => {
    const unprompted: Record<CreatureSessionKind, ToolPosture | undefined> = {
      conversation: undefined,
      thread: undefined,
      routine: "read-only",
      child: undefined,
    };
    for (const kind of creatureSessionKinds) {
      expect(sessionPosture(kind, undefined), kind).toBe(unprompted[kind]);
    }
  });
});

describe("an accepted grant set", () => {
  it("becomes allow rules the session holds, nothing wider", () => {
    expect(
      acceptedGrantRules([
        { action: "write", resource: "notes/**" },
        { action: "bash", resource: "git status *" },
      ]),
    ).toEqual([
      { action: "write", resource: "notes/**", effect: "allow" },
      { action: "bash", resource: "git status *", effect: "allow" },
    ]);
  });
});
