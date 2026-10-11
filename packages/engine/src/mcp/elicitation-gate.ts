import { randomUUID } from "node:crypto";
import type { Confirmation, ConfirmingGate, ToolGuard } from "../agent.ts";
import type { ToolCallPart } from "../messages.ts";
import {
  defaultFormContent,
  describeElicitation,
  type ElicitationAnswer,
  type ElicitationHandler,
  type ElicitationRequest,
  type FormElicitation,
  validateFormContent,
} from "./elicitation.ts";

export const elicitationToolName = "mcp_elicitation";

export interface ElicitationGateOptions {
  say?: (line: string) => void;
  nextCallId?: () => string;
}

export function askGateElicitation(
  guard: ToolGuard,
  options: ElicitationGateOptions = {},
): ElicitationHandler {
  const nextCallId = options.nextCallId ?? randomCallIds();
  return async (request) => {
    if (request.mode === "url") options.say?.(describeElicitation(request));
    const prepared = request.mode === "form" ? prepareForm(request) : { content: undefined };
    if ("declined" in prepared) return prepared.declined;
    const confirmation = await guard.confirm?.(elicitationCall(request, nextCallId()));
    if (confirmation === undefined || !approvedBy(confirmation)) {
      return declinedBy(answeredBy(confirmation, guard), request);
    }
    return {
      action: "accept",
      ...(prepared.content !== undefined && { content: prepared.content }),
    };
  };
}

export function elicitationCall(request: ElicitationRequest, callId: string): ToolCallPart {
  return { type: "tool-call", callId, name: elicitationToolName, arguments: askArguments(request) };
}

type PreparedForm = { content: Record<string, unknown> } | { declined: ElicitationAnswer };

function prepareForm(request: FormElicitation): PreparedForm {
  const content = defaultFormContent(request.fields);
  const problems = validateFormContent(request.fields, content);
  if (problems.length === 0) return { content };
  return {
    declined: {
      action: "decline",
      reason: `${request.server} asked for ${problems.join(", ")} and keywork has no way to collect that yet`,
    },
  };
}

function approvedBy(confirmation: Confirmation): boolean {
  return typeof confirmation === "boolean" ? confirmation : confirmation.approved;
}

function answeredBy(
  confirmation: Confirmation | undefined,
  guard: ToolGuard,
): ConfirmingGate | undefined {
  if (confirmation === undefined) return undefined;
  return typeof confirmation === "boolean" ? guard.gate : confirmation.gate;
}

function declinedBy(
  gate: ConfirmingGate | undefined,
  request: ElicitationRequest,
): ElicitationAnswer {
  const reason =
    gate === "user"
      ? `${request.server} asked for input and you declined`
      : `${request.server} asked for input and this run has no one to answer`;
  return { action: "decline", reason };
}

function askArguments(request: ElicitationRequest): Record<string, unknown> {
  if (request.mode === "url") {
    return { server: request.server, message: request.message, url: request.url };
  }
  const fields = Object.fromEntries(
    request.fields.map((field) => [field.title ?? field.name, field.default ?? field.kind]),
  );
  return {
    server: request.server,
    message: request.message,
    ...(request.fields.length > 0 && { fields }),
  };
}

function randomCallIds(): () => string {
  return () => `${elicitationToolName}-${randomUUID()}`;
}
