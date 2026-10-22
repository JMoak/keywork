import { describe, expect, it } from "vitest";
import type { ToolGuard } from "../agent.ts";
import type { ToolCallPart } from "../messages.ts";
import type { PermissionDecision } from "../session/journal.ts";
import { refusingSandbox, type Sandbox, SandboxRefusal, unconfined } from "./sandbox.ts";
import { askGateUnconfined, unconfinedToolName, workspaceSandbox } from "./session.ts";

const refusal = new SandboxRefusal(
  "workspace",
  "bubblewrap isn't installed",
  "install it or turn it off",
);
const refused = refusingSandbox(refusal);
const honoured: Sandbox = { mode: "workspace", refusal: undefined, confine: (launch) => launch };

function countingConsent(answer: boolean) {
  const asked: SandboxRefusal[] = [];
  return {
    asked,
    consent: async (seen: SandboxRefusal) => {
      asked.push(seen);
      return answer;
    },
  };
}

describe("workspaceSandbox", () => {
  it("hands an enforcing sandbox straight to every agent and never asks", async () => {
    const { asked, consent } = countingConsent(true);

    expect(await workspaceSandbox(honoured).forAgent(consent).current()).toBe(honoured);
    expect(asked).toEqual([]);
  });

  it("asks once per workspace when the sandbox is refused, and a yes runs unconfined", async () => {
    const { asked, consent } = countingConsent(true);
    const workspace = workspaceSandbox(refused);

    const first = await workspace.forAgent(consent).current();
    const second = await workspace.forAgent(consent).current();

    expect(first).toBe(unconfined);
    expect(second).toBe(unconfined);
    expect(asked).toEqual([refusal]);
  });

  it("keeps refusing after a no, without asking again", async () => {
    const { asked, consent } = countingConsent(false);
    const agent = workspaceSandbox(refused).forAgent(consent);

    expect(await agent.current()).toBe(refused);
    expect(await agent.current()).toBe(refused);
    expect(asked).toHaveLength(1);
  });

  it("names the mode in the status word, and says unconfined once the user waives it", async () => {
    const { consent: yes } = countingConsent(true);
    const { consent: no } = countingConsent(false);
    const waived = workspaceSandbox(refused);
    const kept = workspaceSandbox(refused);

    expect(workspaceSandbox(unconfined).status()).toBeUndefined();
    expect(workspaceSandbox(honoured).status()).toBe("sandbox workspace");
    expect(waived.status()).toBe("sandbox workspace refused");
    await waived.forAgent(yes).current();
    await kept.forAgent(no).current();
    expect(waived.status()).toBe("unconfined");
    expect(kept.status()).toBe("sandbox workspace refused");
  });

  it("treats a consent that throws as a no", async () => {
    const agent = workspaceSandbox(refused).forAgent(async () => {
      throw new Error("pane closed");
    });

    expect(await agent.current()).toBe(refused);
  });
});

describe("askGateUnconfined", () => {
  function askingGuard(answer: boolean, gate?: ToolGuard["gate"]) {
    const calls: ToolCallPart[] = [];
    const guard: ToolGuard = {
      confirm: async (call) => {
        calls.push(call);
        return answer;
      },
      ...(gate !== undefined && { gate }),
    };
    return { calls, guard };
  }

  it("rides the ask gate with a call that names why, and records the user's yes", async () => {
    const { calls, guard } = askingGuard(true);
    const said: string[] = [];
    const decisions: PermissionDecision[] = [];

    const allowed = await askGateUnconfined(guard, {
      say: (line) => said.push(line),
      onDecision: (decision) => decisions.push(decision),
      nextCallId: () => "unconfined-1",
    })(refusal);

    expect(allowed).toBe(true);
    expect(calls).toEqual([
      {
        type: "tool-call",
        callId: "unconfined-1",
        name: unconfinedToolName,
        arguments: { why: "bubblewrap isn't installed" },
      },
    ]);
    expect(said).toEqual([
      "sandbox workspace can't run here: bubblewrap isn't installed · allow runs commands unconfined until keywork exits, deny keeps them refused",
    ]);
    expect(decisions).toEqual([
      {
        tool: "unconfined",
        callId: "unconfined-1",
        verdict: "granted",
        gate: "user",
        scope: "session",
        asked: true,
      },
    ]);
  });

  it("answers no for a headless run without printing the question", async () => {
    const { guard } = askingGuard(false, "headless");
    const said: string[] = [];
    const decisions: PermissionDecision[] = [];

    const allowed = await askGateUnconfined(guard, {
      say: (line) => said.push(line),
      onDecision: (decision) => decisions.push(decision),
      nextCallId: () => "unconfined-2",
    })(refusal);

    expect(allowed).toBe(false);
    expect(said).toEqual([]);
    expect(decisions).toEqual([
      {
        tool: "unconfined",
        callId: "unconfined-2",
        verdict: "denied",
        gate: "headless",
        asked: true,
      },
    ]);
  });

  it("fails closed when the guard has no one to ask", async () => {
    const decisions: PermissionDecision[] = [];

    const allowed = await askGateUnconfined(
      {},
      { onDecision: (decision) => decisions.push(decision) },
    )(refusal);

    expect(allowed).toBe(false);
    expect(decisions[0]).toMatchObject({ verdict: "denied", gate: "default" });
  });
});
