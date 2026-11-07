import {
  type CreatureMcpPort,
  exchangeResponse,
  type McpCaller,
  mcpArrivalSchema,
  protocolHeaderRefusal,
  rpcErrorCodes,
} from "@keywork/engine";
import type { SessionHost } from "../host.ts";
import { servedBy } from "./answers.ts";
import { json, type RouteFamily, type RouteSpec } from "./family.ts";

export const creatureMcpRoutes = [
  {
    method: "POST",
    path: "/creatures/{slug}/mcp",
    operationId: "serveCreatureMcp",
    summary:
      "The creature as an MCP server for an agent on this machine, over streamable HTTP with this server's token as the bearer (the loopback ticket): one JSON-RPC message per POST, answered as JSON (`202` and no body for a notification); no event stream and no session id. It speaks MCP `2026-07-28` (`server/discover`) and the 2025 revisions (`initialize`). Three tools: `ask` leaves the creature plain words (`{ text }`, up to 2000 characters) as one creature-origin line in its conversation, the `keywork.creature.report` entry creature mail uses, so it starts no turn and carries no approval, grant or configuration, and answers a `handle`; `ask { handle }` polls, returning the creature's first reply from the turn after the words landed, or that it has not answered yet. `status` answers `working`, `at the porch`, `back`, `idle` or `paused`. `deliveries` returns the report lines finished threads and chores delivered (`{ after?, limit? }`, oldest first). The creature's `inbound` policy gates every tool (`nobody` refuses, `paired` admits, `{ named }` admits only those creatures, never an agent); asks share the hourly limits of creature mail; every call is an audit row (`creature.ask`, `creature.status`, `creature.deliveries`) with its arguments only digested. Bad arguments, an unknown tool, or fields such as `approve` are JSON-RPC `-32602`.",
    authenticated: true,
    requestBody: { type: "object", description: "One JSON-RPC 2.0 message." },
    responses: {
      "200": "The JSON-RPC response.",
      "202": "The message was a notification or a response; nothing to answer.",
      "400":
        "The body is not one JSON-RPC message, or the `mcp-protocol-version` or `mcp-method` header is refused; the body is a JSON-RPC error.",
      "404": "No creature here has that slug.",
      "503": "Creature MCP is not served: the node keeps no audit log without its mesh.",
    },
  },
  {
    method: "POST",
    path: "/creatures/{slug}/mcp/arrivals",
    operationId: "takeCreatureMcpArrival",
    summary:
      "The node hands this workspace one MCP message that reached `/mesh/creatures/{slug}/mcp` on its tailnet listener after a creature ticket held: `{ caller: { stableId, name, userId, tags }, message }`, the caller as WhoIs named it, never as the agent claimed. The workspace answers it as `POST /creatures/{slug}/mcp` would, for a caller on that paired machine: the inbound policy, the shared limits and the audit row all name it. A node that keeps its tailnet listener in another process than its workspaces posts each arrival here, trying the next workspace on 404.",
    authenticated: true,
    requestBody: {
      type: "object",
      required: ["caller", "message"],
      properties: {
        caller: {
          type: "object",
          required: ["stableId", "name", "userId", "tags"],
          properties: {
            stableId: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1 },
            userId: { type: ["string", "null"] },
            tags: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
        message: { type: "object", description: "One JSON-RPC 2.0 message." },
      },
      additionalProperties: false,
    },
    responses: {
      "200": "The JSON-RPC response.",
      "202": "The message was a notification or a response; nothing to answer.",
      "400": "The body is not an arrival, or the message is not one JSON-RPC message.",
      "404": "No creature here has that slug.",
      "503": "Creature MCP is not served here.",
    },
  },
] as const satisfies readonly RouteSpec[];

export function creatureMcpFamily(
  portOf: (host: SessionHost) => CreatureMcpPort | undefined,
): RouteFamily<typeof creatureMcpRoutes> {
  return {
    routes: creatureMcpRoutes,
    handlers: ({ host }) => {
      const served = servedBy(() => portOf(host), "creature MCP");
      const answered = async (
        port: CreatureMcpPort,
        slug: string,
        message: unknown,
        caller: McpCaller,
      ): Promise<Response> => {
        const mail = host.mesh?.messages;
        const answer = await port.answer(slug, message, caller, mail);
        if (answer === "missing") return json(404, { error: `no creature here is called ${slug}` });
        return exchangeResponse(answer);
      };
      return {
        serveCreatureMcp: served(async (port, request, { slug = "" }) => {
          const message = await jsonOf(request);
          if (message === unparseable) return parseRefusal();
          const refusal = protocolHeaderRefusal(request.headers, message);
          if (refusal !== undefined) return exchangeResponse(refusal);
          return answered(port, slug, message, { kind: "local" });
        }),
        takeCreatureMcpArrival: served(async (port, request, { slug = "" }) => {
          const arrival = mcpArrivalSchema.safeParse(await jsonOf(request));
          if (!arrival.success)
            return json(400, {
              error: "an arrival is { caller, message } as WhoIs named the caller",
            });
          const { caller, message } = arrival.data;
          return answered(port, slug, message, { kind: "paired", peer: caller });
        }),
      };
    },
  };
}

const unparseable = Symbol("unparseable");

async function jsonOf(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return unparseable;
  }
}

function parseRefusal(): Response {
  return exchangeResponse({
    status: 400,
    body: {
      jsonrpc: "2.0",
      id: null,
      error: { code: rpcErrorCodes.parse, message: "the body is not JSON" },
    },
  });
}
