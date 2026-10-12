import {
  type Confirmation,
  type PermissionDecision,
  type PermissionResolver,
  rulingOf,
  type Tool,
  type ToolCallPart,
  type ToolGuard,
} from "@keywork/engine";

export interface ShellEscapeResult {
  output: string;
  isError: boolean;
}

export interface ShellEscapePort {
  run(call: ToolCallPart, signal?: AbortSignal): Promise<ShellEscapeResult>;
}

export type ShellDecisionSink = (decision: PermissionDecision, call: ToolCallPart) => void;

export interface ShellEscapeSeams {
  tools: () => readonly Tool[];
  guard: ToolGuard;
  permissions?: PermissionResolver;
  onDecision?: ShellDecisionSink;
}

export const shellEscapeToolName = "bash";

export function shellEscapeCommand(text: string): string | undefined {
  if (!text.startsWith("!") || text.length < 2) return undefined;
  if (/\s/.test(text.charAt(1))) return undefined;
  return text.slice(1);
}

export function shellEscapeCall(command: string, sequence: number): ToolCallPart {
  return {
    type: "tool-call",
    callId: `user-shell-${sequence}`,
    name: shellEscapeToolName,
    arguments: { command },
  };
}

export function shellEscapeTranscript(command: string, output: string): string {
  const body = output.trimEnd();
  return body === "" ? `$ ${command}` : `$ ${command}\n${body}`;
}

export function guardedShellEscape(seams: ShellEscapeSeams): ShellEscapePort {
  return {
    run: async (call, signal) => {
      const tool = seams.tools().find((candidate) => candidate.name === call.name);
      if (tool === undefined) return failure(`no ${call.name} tool in this session`);
      const report = (outcome: PermissionDecision): void => seams.onDecision?.(outcome, call);
      const ruling = rulingOf(seams.permissions?.(call));
      const gate = ruling?.gate ?? "default";
      const permission = ruling?.permission ?? defaultVerdict(tool);
      if (permission === "deny") {
        report(decision(call, "denied", gate));
        return failure("denied by permission policy");
      }
      if (permission === "ask") {
        const answer = answerOf(await (seams.guard.confirm?.(call) ?? Promise.resolve(true)));
        const askedBy =
          seams.guard.confirm === undefined ? gate : (answer.gate ?? seams.guard.gate ?? "user");
        report({
          ...decision(call, answer.approved ? "granted" : "denied", askedBy),
          ...(answer.approved && answer.scope !== undefined && { scope: answer.scope }),
        });
        if (!answer.approved) return failure("declined by user");
      } else {
        report({
          ...decision(call, "granted", gate),
          ...(ruling?.gate === "user" && { scope: ruling.scope }),
        });
      }
      if (tool.mutates === true) await seams.guard.beforeMutation?.();
      try {
        return { output: await tool.execute(call.arguments, signal), isError: false };
      } catch (cause) {
        return failure(cause instanceof Error ? cause.message : String(cause));
      }
    },
  };
}

type ShellAnswer = Partial<Exclude<Confirmation, boolean>> & { approved: boolean };

function answerOf(confirmation: Confirmation): ShellAnswer {
  return typeof confirmation === "boolean" ? { approved: confirmation } : confirmation;
}

function defaultVerdict(tool: Tool): "allow" | "ask" {
  return tool.mutates === true ? "ask" : "allow";
}

function decision(
  call: ToolCallPart,
  verdict: PermissionDecision["verdict"],
  gate: PermissionDecision["gate"],
): PermissionDecision {
  return { tool: call.name, callId: call.callId, verdict, gate };
}

function failure(output: string): ShellEscapeResult {
  return { output, isError: true };
}
