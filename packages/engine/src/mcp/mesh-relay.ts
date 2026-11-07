import { z } from "zod";
import type { ArrivalCaller } from "../creatures/messages/message.ts";
import type { AuditLog } from "../mesh/audit/log.ts";
import { creatureSlug } from "../mesh/grants/grant.ts";
import type { MeshCaller } from "../mesh/listener/admission.ts";
import {
  exchangeResponse,
  type McpExchange,
  protocolHeaderRefusal,
  rpcErrorCodes,
} from "./server.ts";
import type { CreatureTickets } from "./tickets.ts";
import { asRecord } from "./wire.ts";

export const meshCreatureMcpPath = "/mesh/creatures/{slug}/mcp";
export const meshCreatureTicketsPath = "/mesh/creatures/tickets";

export interface McpArrival {
  caller: ArrivalCaller;
  message: unknown;
}

export const mcpArrivalSchema = z
  .object({
    caller: z
      .object({
        stableId: z.string().min(1).max(256),
        name: z.string().min(1).max(256),
        userId: z.string().min(1).max(256).nullable(),
        tags: z.array(z.string().min(1).max(256)).max(32),
      })
      .strict(),
    message: z.unknown(),
  })
  .strict();

export interface RelayRefusal {
  refused: "missing" | "unreachable";
  error: string;
}

export type RelayedExchange = McpExchange | RelayRefusal;

export interface CreatureMcpRelayOptions {
  tickets: CreatureTickets;
  forward(slug: string, arrival: McpArrival): Promise<RelayedExchange>;
  audit?: AuditLog | undefined;
  self?: (() => string) | undefined;
}

export interface CreatureMeshRoute {
  method: "POST";
  path: string;
  handle(
    request: Request,
    caller: MeshCaller,
    params: Readonly<Record<string, string>>,
  ): Promise<Response>;
}

export function creatureMcpMeshRoutes(options: CreatureMcpRelayOptions): CreatureMeshRoute[] {
  return [
    { method: "POST", path: meshCreatureMcpPath, handle: relayed(options) },
    { method: "POST", path: meshCreatureTicketsPath, handle: minted(options.tickets) },
  ];
}

export function arrivalCallerOf(caller: MeshCaller): ArrivalCaller {
  return {
    stableId: caller.node.stableId,
    name: caller.node.name,
    userId: caller.human?.userId ?? null,
    tags: caller.node.tags,
  };
}

export function bearerOf(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function relayed(options: CreatureMcpRelayOptions): CreatureMeshRoute["handle"] {
  return async (request, caller, { slug = "" }) => {
    if (!creatureSlug.test(slug)) return plain(404, `no creature is called ${slug}`);
    const ticket = await options.tickets.check(bearerOf(request), caller, slug);
    if (!ticket.ok) {
      await auditRefusal(options, caller, slug, ticket.problem);
      return plain(ticket.status, ticket.problem, ticket.status === 401);
    }
    const message = await request.json().catch(() => unparseable);
    if (message === unparseable) return exchangeResponse(parseRefusal);
    const refusal = protocolHeaderRefusal(request.headers, message);
    if (refusal !== undefined) return exchangeResponse(refusal);
    const exchange = await options.forward(slug, { caller: arrivalCallerOf(caller), message });
    if ("refused" in exchange)
      return plain(exchange.refused === "missing" ? 404 : 502, exchange.error);
    return exchangeResponse(exchange);
  };
}

function minted(tickets: CreatureTickets): CreatureMeshRoute["handle"] {
  return async (request, caller) => {
    const body = asRecord(await request.json().catch(() => undefined));
    const { node, creature } = body;
    if (typeof node !== "string" || typeof creature !== "string" || !creatureSlug.test(creature))
      return plain(400, "a ticket names the machine (node, its StableID) and the creature's slug");
    const issued = await tickets.issue(bearerOf(request), caller, { node, creature });
    if ("refused" in issued) return plain(issued.status, issued.problem);
    return new Response(JSON.stringify(issued), {
      status: 201,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  };
}

async function auditRefusal(
  options: CreatureMcpRelayOptions,
  caller: MeshCaller,
  slug: string,
  problem: string,
): Promise<void> {
  if (options.audit === undefined) return;
  await options.audit.append({
    actor: {
      stableId: caller.node.stableId,
      userId: caller.human?.userId ?? null,
      tags: caller.node.tags,
    },
    target: options.self?.() ?? "unknown",
    capability: "creature.mcp",
    request: { creature: slug },
    decision: "deny",
    reason: problem,
  });
}

const unparseable = Symbol("unparseable");

const parseRefusal: McpExchange = {
  status: 400,
  body: {
    jsonrpc: "2.0",
    id: null,
    error: { code: rpcErrorCodes.parse, message: "the body is not JSON" },
  },
};

function plain(status: number, error: string, challenge = false): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(challenge && { "www-authenticate": "Bearer" }),
    },
  });
}
