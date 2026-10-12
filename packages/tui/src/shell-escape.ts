import {
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

export interface ShellEscapeSeams {
  tools: () => readonly Tool[];
  guard: ToolGuard;
  permissions?: PermissionResolver;
  onDecision?: (decision: PermissionDecision) => void;
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
      const ruling = rulingOf(seams.permissions?.(call));
      const gate = ruling?.gate ?? "default";
      const permission = ruling?.permission ?? defaultVerdict(tool);
      if (permission === "deny") {
        seams.onDecision?.(decision(call, "denied", gate));
        return failure("denied by permission policy");
      }
      if (permission === "ask") {
        const approved = await (seams.guard.confirm?.(call) ?? Promise.resolve(true));
        const askedBy = seams.guard.confirm === undefined ? gate : (seams.guard.gate ?? "user");
        seams.onDecision?.(decision(call, approved ? "granted" : "denied", askedBy));
        if (!approved) return failure("declined by user");
      } else {
        seams.onDecision?.({
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
