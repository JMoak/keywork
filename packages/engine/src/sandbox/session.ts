import { randomUUID } from "node:crypto";
import type { Confirmation, ToolGuard } from "../agent.ts";
import type { ToolCallPart } from "../messages.ts";
import type { PermissionDecision, PermissionGate } from "../session/journal.ts";
import { type Sandbox, type SandboxRefusal, unconfined } from "./sandbox.ts";

export interface ToolSandbox {
  readonly configured: Sandbox;
  current(): Promise<Sandbox>;
}

export interface WorkspaceSandbox {
  readonly configured: Sandbox;
  forAgent(consent: UnconfinedConsent): ToolSandbox;
  status(): string | undefined;
}

export type UnconfinedConsent = (refusal: SandboxRefusal) => Promise<boolean>;

export const unconfinedToolName = "unconfined";

export function fixedSandbox(sandbox: Sandbox): ToolSandbox {
  return { configured: sandbox, current: () => Promise.resolve(sandbox) };
}

export function workspaceSandbox(configured: Sandbox): WorkspaceSandbox {
  const refusal = configured.refusal;
  if (refusal === undefined) {
    return {
      configured,
      forAgent: () => fixedSandbox(configured),
      status: () => (configured.mode === "off" ? undefined : `sandbox ${configured.mode}`),
    };
  }
  let answered: Promise<Sandbox> | undefined;
  let waived = false;
  const answer = (consent: UnconfinedConsent): Promise<Sandbox> => {
    answered ??= consent(refusal).then(
      (allowed) => {
        waived = allowed;
        return allowed ? unconfined : configured;
      },
      () => configured,
    );
    return answered;
  };
  return {
    configured,
    forAgent: (consent) => ({ configured, current: () => answer(consent) }),
    status: () => (waived ? "unconfined" : `sandbox ${refusal.mode} refused`),
  };
}

export interface UnconfinedAskOptions {
  say?: ((line: string) => void) | undefined;
  onDecision?: ((decision: PermissionDecision) => void) | undefined;
  nextCallId?: (() => string) | undefined;
}

export function askGateUnconfined(
  guard: ToolGuard,
  options: UnconfinedAskOptions = {},
): UnconfinedConsent {
  const nextCallId = options.nextCallId ?? (() => `unconfined-${randomUUID()}`);
  return async (refusal) => {
    if (guard.gate !== "headless") options.say?.(consentQuestion(refusal));
    const call = unconfinedCall(refusal, nextCallId());
    const answer = await guard.confirm?.(call);
    const allowed = answer !== undefined && approvedBy(answer);
    options.onDecision?.(decisionOn(call, allowed, answeringGate(answer, guard)));
    return allowed;
  };
}

export function unconfinedCall(refusal: SandboxRefusal, callId: string): ToolCallPart {
  return {
    type: "tool-call",
    callId,
    name: unconfinedToolName,
    arguments: { why: refusal.fact },
  };
}

function consentQuestion(refusal: SandboxRefusal): string {
  return `sandbox ${refusal.mode} can't run here: ${refusal.fact} · allow runs commands unconfined until keywork exits, deny keeps them refused`;
}

function approvedBy(confirmation: Confirmation): boolean {
  return typeof confirmation === "boolean" ? confirmation : confirmation.approved;
}

function answeringGate(answer: Confirmation | undefined, guard: ToolGuard): PermissionGate {
  if (answer === undefined) return "default";
  if (typeof answer === "boolean") return guard.gate ?? "user";
  return answer.gate;
}

function decisionOn(
  call: ToolCallPart,
  allowed: boolean,
  gate: PermissionGate,
): PermissionDecision {
  return {
    tool: call.name,
    callId: call.callId,
    verdict: allowed ? "granted" : "denied",
    gate,
    ...(allowed && { scope: "session" as const }),
  };
}
