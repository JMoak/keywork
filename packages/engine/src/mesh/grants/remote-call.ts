import type { PermissionRule } from "@keywork/shared";
import { z } from "zod";
import type { ToolCallPart } from "../../messages.ts";
import type { MeshClient } from "../pairing/client.ts";
import type { PairRecord } from "../pairing/store.ts";
import { creatureSlug } from "./grant.ts";

export interface MeshOrigin {
  kind: "mesh";
  creature: string;
  node: string;
}

export interface MeshToolEnvelope {
  type: "mesh.tool.call";
  origin: MeshOrigin;
  grantId: string;
  call: ToolCallPart;
  rules: readonly PermissionRule[];
}

export interface GateOutcome {
  verdict: "allowed" | "denied";
  output: string;
  isError: boolean;
  reason: string;
}

export interface MeshGate {
  run(envelope: MeshToolEnvelope): Promise<GateOutcome>;
}

export interface RemoteCallResult extends GateOutcome {
  callId: string;
}

export type RemoteCallRequest = z.infer<typeof remoteCallSchema>;

export type RemoteCallInput = z.input<typeof remoteCallSchema>;

export const meshToolCallPath = "/mesh/tools/call";
export const maxMeshHops = 4;

export const remoteCallSchema = z
  .object({
    creature: z.string().regex(creatureSlug),
    grantId: z.string().min(1).max(256),
    call: z
      .object({
        callId: z.string().min(1).max(128),
        name: z.string().min(1).max(128),
        arguments: z.unknown(),
      })
      .strict(),
    hop: z.number().int().min(0).default(0),
  })
  .strict();

export const remoteCallResultSchema = z.object({
  callId: z.string(),
  verdict: z.enum(["allowed", "denied"]),
  output: z.string(),
  isError: z.boolean(),
  reason: z.string(),
});

export async function callRemoteTool(
  client: Pick<MeshClient, "send">,
  pair: PairRecord,
  request: RemoteCallInput,
): Promise<RemoteCallResult> {
  const response = await client.send(pair, "POST", meshToolCallPath, request);
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = remoteCallResultSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  return {
    callId: request.call.callId,
    verdict: "denied",
    output: "",
    isError: true,
    reason: refusalReason(body) ?? `the target answered ${response.status}`,
  };
}

export function toolCallOf(call: RemoteCallRequest["call"]): ToolCallPart {
  return { type: "tool-call", callId: call.callId, name: call.name, arguments: call.arguments };
}

function refusalReason(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { error } = body as { error?: unknown };
  return typeof error === "string" ? error : undefined;
}
