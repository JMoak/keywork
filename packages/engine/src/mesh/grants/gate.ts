import { grantCandidates, type PermissionRule } from "@keywork/shared";
import { type PermissionResolver, type PermissionRuling, rulingOf } from "../../agent.ts";
import { PermissionLedger, type WorkspaceGrants } from "../../permission-ledger.ts";
import type { PermissionAsk } from "../../session/journal.ts";
import type { Tool } from "../../tools.ts";
import type { GateOutcome, MeshGate, MeshOrigin, MeshToolEnvelope } from "./remote-call.ts";

export type MeshAsk = (envelope: MeshToolEnvelope, ask: PermissionAsk) => Promise<boolean>;

export interface LedgerGateOptions {
  root: string;
  tools(origin: MeshOrigin): readonly Tool[];
  user?: PermissionResolver | undefined;
  ask?: MeshAsk | undefined;
}

export function ledgerGate(options: LedgerGateOptions): MeshGate {
  return {
    run: async (envelope) => {
      const tool = options.tools(envelope.origin).find(({ name }) => name === envelope.call.name);
      if (tool === undefined)
        return denied(`no tool named ${envelope.call.name} serves mesh calls`);
      const ruling = rulingFor(envelope, tool, options);
      if (ruling.permission === "deny") return denied(`denied by ${rulingSource(ruling)}`);
      if (ruling.permission === "ask" && !(await approved(envelope, ruling, options.ask))) {
        return denied(
          options.ask === undefined ? "asks are not served for mesh calls" : "the keeper declined",
        );
      }
      return executed(tool, envelope, ruling);
    },
  };
}

export function meshWorkspace(rules: () => readonly PermissionRule[]): WorkspaceGrants {
  return { rules, grant: () => undefined, revoke: () => false };
}

type GateRuling = PermissionRuling | { permission: "allow" | "ask"; gate: "default" };

function rulingFor(envelope: MeshToolEnvelope, tool: Tool, options: LedgerGateOptions): GateRuling {
  const ledger = new PermissionLedger({
    trusted: false,
    root: options.root,
    workspace: meshWorkspace(() => envelope.rules),
    user: options.user,
  });
  return (
    rulingOf(ledger.resolverFor()(envelope.call)) ?? {
      permission: tool.mutates === true ? "ask" : "allow",
      gate: "default",
    }
  );
}

async function approved(envelope: MeshToolEnvelope, ruling: GateRuling, ask: MeshAsk | undefined) {
  if (ask === undefined) return false;
  const { call } = envelope;
  return ask(envelope, {
    tool: call.name,
    callId: call.callId,
    arguments: call.arguments,
    rule: ruling.gate === "user" ? "policy" : ruling.gate,
    rules: grantCandidates(call.name, call.arguments),
  });
}

async function executed(
  tool: Tool,
  envelope: MeshToolEnvelope,
  ruling: GateRuling,
): Promise<GateOutcome> {
  const reason =
    ruling.permission === "ask" ? "the keeper approved" : `allowed by ${rulingSource(ruling)}`;
  try {
    return {
      verdict: "allowed",
      output: await tool.execute(envelope.call.arguments),
      isError: false,
      reason,
    };
  } catch (cause) {
    return {
      verdict: "allowed",
      output: cause instanceof Error ? cause.message : String(cause),
      isError: true,
      reason,
    };
  }
}

function rulingSource(ruling: GateRuling): string {
  switch (ruling.gate) {
    case "user":
      return "the grant's rules";
    case "policy":
      return "this node's permission policy";
    case "trusted":
      return "the trusted bundle";
    default:
      return "the default posture";
  }
}

function denied(reason: string): GateOutcome {
  return { verdict: "denied", output: "", isError: true, reason };
}
