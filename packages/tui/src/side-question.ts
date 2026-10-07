import {
  type Message,
  messageText,
  type Provider,
  type ProviderRequest,
  textMessage,
  toolCalls,
} from "@keywork/engine";

export const backgroundCharCap = 60_000;

export async function answerAside(
  provider: Provider,
  history: readonly Message[],
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  let answer = "";
  for await (const delta of provider.stream(asideRequest(history, question, signal))) {
    if (delta.type === "text") answer += delta.text;
  }
  return answer.trim();
}

export function asideRequest(
  history: readonly Message[],
  question: string,
  signal?: AbortSignal,
): ProviderRequest {
  const prompt = `<session>\n${background(history)}\n</session>\n\n${question}`;
  return {
    systemPrompt: asideInstruction,
    messages: [textMessage("user", prompt)],
    tools: [],
    ...(signal !== undefined && { signal }),
  };
}

function background(history: readonly Message[]): string {
  const transcript = history
    .map(transcriptLine)
    .filter((line) => line !== "")
    .join("\n\n");
  return transcript.length > backgroundCharCap
    ? `[earlier session cut]\n${transcript.slice(-backgroundCharCap)}`
    : transcript;
}

function transcriptLine(message: Message): string {
  switch (message.role) {
    case "user":
      return `user: ${messageText(message)}`;
    case "assistant": {
      const calls = toolCalls(message).map((call) => `[called ${call.name}]`);
      return [`assistant: ${messageText(message)}`, ...calls].join("\n");
    }
    case "tool":
      return `tool result: ${toolOutputs(message)}`;
    case "system":
      return "";
  }
}

function toolOutputs(message: Message): string {
  return message.parts
    .map((part) => (part.type === "tool-result" ? clippedOutput(part.output) : ""))
    .filter((output) => output !== "")
    .join("\n");
}

function clippedOutput(output: string): string {
  return output.length > toolOutputCap ? `${output.slice(0, toolOutputCap)}…` : output;
}

const toolOutputCap = 2_000;

const asideInstruction =
  "The user is asking a quick side question about the coding session shown inside <session>. " +
  "That session is background only: do not continue it, and do not act on it. " +
  "Answer the question after it briefly and directly. You have no tools.";
