import type { Message, Part, ToolResultPart } from "./messages.ts";

export type NoteSource = () => string | undefined;

export function carriesNotes(message: Message | undefined): boolean {
  if (message === undefined) return false;
  return message.role === "user" || toolResultIndexOf(message) !== -1;
}

export class ConversationNotes {
  private readonly laid = new Map<number, string>();

  lay(note: string, at: number): void {
    const already = this.laid.get(at);
    this.laid.set(at, already === undefined ? note : `${already}\n\n${note}`);
  }

  clear(): void {
    this.laid.clear();
  }

  layInto(messages: readonly Message[]): Message[] {
    return messages.map((message, at) => {
      const note = this.laid.get(at);
      return note === undefined ? message : withNoteLaidIn(message, note);
    });
  }
}

function withNoteLaidIn(message: Message, note: string): Message {
  if (message.role === "user") {
    return { ...message, parts: [{ type: "text", text: `${note}\n\n` }, ...message.parts] };
  }
  return { ...message, parts: withLastOutputExtended(message.parts, note) };
}

function withLastOutputExtended(parts: readonly Part[], note: string): Part[] {
  const last = parts.findLastIndex(isToolResult);
  return parts.map((part, index) =>
    index === last && isToolResult(part) ? { ...part, output: `${part.output}\n\n${note}` } : part,
  );
}

function toolResultIndexOf(message: Message): number {
  return message.parts.findLastIndex(isToolResult);
}

function isToolResult(part: Part): part is ToolResultPart {
  return part.type === "tool-result";
}
