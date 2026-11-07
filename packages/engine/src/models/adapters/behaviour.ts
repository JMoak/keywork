import { known } from "../capabilities/record.ts";
import type { CapabilityRecord } from "../capabilities/types.ts";
import { joinUrl } from "./http.ts";
import { arrayAt, objectAt, stringAt } from "./json.ts";
import type { ServerProbe } from "./types.ts";

export type ToolCallProbeOutcome =
  | { kind: "tool_calls" }
  | { kind: "content"; text: string }
  | { kind: "refused"; status: number };

export const toolCallProbeName = "keywork_probe_ping";

export async function probeToolCalls(
  probe: ServerProbe,
  model: string,
): Promise<ToolCallProbeOutcome> {
  const reply = await probe.http.post(joinUrl(probe.root, "/v1/chat/completions"), {
    model,
    stream: false,
    temperature: 0,
    max_tokens: 64,
    messages: [{ role: "user", content: `Call the ${toolCallProbeName} tool now.` }],
    tools: [
      {
        type: "function",
        function: {
          name: toolCallProbeName,
          description: "Answers ping. Call it when asked.",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });
  if (!reply.ok) return { kind: "refused", status: reply.status };
  const message = objectAt(arrayAt(reply.body, "choices")[0], "message");
  const called = arrayAt(message, "tool_calls").map((call) => stringAt(call, "function", "name"));
  if (called.includes(toolCallProbeName)) return { kind: "tool_calls" };
  return { kind: "content", text: stringAt(message, "content") ?? "" };
}

export function withToolCallProbe(
  record: CapabilityRecord,
  outcome: ToolCallProbeOutcome,
): CapabilityRecord {
  const evidence = { source: "behaviour-probe", probe: "tool_calls" } as const;
  if (outcome.kind === "refused") {
    return {
      ...record,
      tools: known(false, { source: "rejected-field", field: "tools", status: outcome.status }),
    };
  }
  return { ...record, tools: known(outcome.kind === "tool_calls", evidence) };
}

export async function oneTokenProbe(probe: ServerProbe, model: string): Promise<boolean> {
  const reply = await probe.http.post(joinUrl(probe.root, "/v1/chat/completions"), {
    model,
    stream: false,
    max_tokens: 1,
    messages: [{ role: "user", content: "ok" }],
  });
  return reply.ok;
}
