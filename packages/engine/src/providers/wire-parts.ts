import type { ImagePart, ToolCallPart } from "../messages.ts";
import { ProviderStreamError } from "./errors.ts";

export interface ToolCallFragment {
  id?: string | undefined;
  name?: string | undefined;
  argumentsJson?: string | undefined;
}

export class ToolCallAssembler {
  private readonly pending = new Map<number, PendingToolCall>();

  constructor(private readonly provider: string) {}

  add(index: number, fragment: ToolCallFragment): void {
    const existing = this.pending.get(index) ?? { id: "", name: "", argumentsJson: "" };
    const argumentsJson = existing.argumentsJson + (fragment.argumentsJson ?? "");
    if (argumentsJson.length > maxToolArgumentChars) {
      throw new ProviderStreamError(this.provider, "tool-call arguments exceeded the size ceiling");
    }
    this.pending.set(index, {
      id: firstSet(existing.id, fragment.id),
      name: firstSet(existing.name, fragment.name),
      argumentsJson,
    });
  }

  completed(): ToolCallPart[] {
    return [...this.pending]
      .sort(([left], [right]) => left - right)
      .map(([index, call]) => ({
        type: "tool-call",
        callId: call.id !== "" ? call.id : `call_${index}`,
        name: call.name,
        arguments: parseToolArguments(call.argumentsJson),
      }));
  }
}

export function parseToolArguments(raw: string): unknown {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function imageDataUrl(part: ImagePart): string {
  return `data:${part.mediaType};base64,${part.data}`;
}

const maxToolArgumentChars = 1_048_576;

interface PendingToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

function firstSet(current: string, incoming: string | undefined): string {
  return current !== "" ? current : (incoming ?? "");
}
