export type Role = "system" | "user" | "assistant" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolCallPart {
  type: "tool-call";
  callId: string;
  name: string;
  arguments: unknown;
}

export interface ToolResultPart {
  type: "tool-result";
  callId: string;
  output: string;
  isError: boolean;
}

export type Part = TextPart | ToolCallPart | ToolResultPart;

export interface Message {
  role: Role;
  parts: Part[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export function textMessage(role: Role, text: string): Message {
  return { role, parts: [{ type: "text", text }] };
}

export function messageText(message: Message): string {
  return message.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function toolCalls(message: Message): ToolCallPart[] {
  return message.parts.filter((part): part is ToolCallPart => part.type === "tool-call");
}
