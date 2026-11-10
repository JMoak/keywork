import {
  CampaignError,
  type CampaignService,
  CampaignStoreError,
  createCampaignRequestSchema,
} from "@keywork/engine";
import { z } from "zod";
import { bodyOf, json, type RouteFamily, type RouteSpec } from "./family.ts";

export const campaignRoutes = [
  {
    method: "GET",
    path: "/campaigns/cartridges",
    operationId: "listCampaignCartridges",
    summary:
      "Discover trusted task cartridges by metadata. Full instructions enter a model context only when explicitly activated for its stage.",
    authenticated: true,
    responses: {
      "200": "`{ cartridges }` with id, version, digest, title, description, and stages.",
      "501": "Campaigns are unavailable.",
    },
  },
  {
    method: "GET",
    path: "/campaigns",
    operationId: "listCampaigns",
    summary:
      "List refinement campaigns for this workspace with activity, accounted spending, and verified achievements.",
    authenticated: true,
    responses: { "200": "`{ campaigns }`.", "501": "Campaigns are unavailable." },
  },
  {
    method: "POST",
    path: "/campaigns/{id}/artifacts/{artifactId}/export",
    operationId: "exportCampaignArtifact",
    summary:
      "Export an immutable version to a new directory within the owning workspace. Body `{ destination }`; existing files are never overwritten. Export does not apply a patch, publish, or merge.",
    authenticated: true,
    requestBody: {
      type: "object",
      properties: { destination: { type: "string" } },
      required: ["destination"],
      additionalProperties: false,
    },
    responses: {
      "200": "`{ artifactId, path }`.",
      "403": "Workspace trust is required.",
      "404": "Unknown artifact.",
      "422": "Destination is outside scope, exists, or cannot be written.",
    },
  },
  {
    method: "POST",
    path: "/campaigns",
    operationId: "createCampaign",
    summary:
      "Create a ready campaign and immutable baseline. Creation does not dispatch paid work; the start command authorizes the selected model within the displayed budget and persistence allowance.",
    authenticated: true,
    requestBody: z.toJSONSchema(createCampaignRequestSchema),
    responses: {
      "201": "`{ campaign, sequence }`.",
      "400": "Invalid purpose, model, budget, or artifact.",
      "403": "Workspace trust is required.",
    },
  },
  {
    method: "GET",
    path: "/campaigns/{id}",
    operationId: "readCampaign",
    summary:
      "Read the durable campaign projection and independent event cursor: `{ campaign, sequence }`.",
    authenticated: true,
    responses: { "200": "Campaign snapshot.", "404": "No accessible campaign has that id." },
  },
  {
    method: "POST",
    path: "/campaigns/{id}/commands",
    operationId: "commandCampaign",
    summary:
      "Steer a campaign with `{ expectedRevision, command }`. Commands: start, pause, resume, cancel, finish, retain, branch, adopt, redirect, select-model, set-cartridges, renew-persistence, reconcile, and review-artifact. Renewal changes total limits without resetting consumed allowance. Reconcile requires an explicit total charge and receipt reference. review-artifact requires artifactId, observations for every current criterion (criterionId, verdict, summary), reason, adopt, and attested:true; it atomically records real human observations without inference. Model critique alone cannot certify outcomes. Authority, accounting, and verification remain server-owned. Pause and cancellation requests are distinct from confirmed execution state.",
    authenticated: true,
    requestBody: {
      type: "object",
      required: ["expectedRevision", "command"],
      properties: {
        expectedRevision: { type: "integer", minimum: 0 },
        command: { type: "object" },
      },
      additionalProperties: false,
    },
    responses: {
      "200": "`{ campaign, sequence }` after steering.",
      "400": "Invalid command.",
      "404": "Unknown campaign.",
      "409": "Stale revision or conflicting execution.",
      "422": "The requested execution cannot be admitted.",
    },
  },
  {
    method: "GET",
    path: "/campaigns/{id}/events",
    operationId: "campaignEvents",
    summary:
      "Campaign SSE stream with durable `campaign` events, authoritative `snapshot` events (`{ campaign, sequence }`), and 15-second `heartbeat` events (`{ at }`, epoch milliseconds). Last-Event-ID or ?after= resumes an event cursor. A current snapshot follows retained replay, so reconnect cannot lose state. Monitoring performs no inference.",
    authenticated: true,
    responses: {
      "200": "text/event-stream.",
      "400": "Invalid event cursor.",
      "404": "Unknown campaign.",
    },
  },
  {
    method: "GET",
    path: "/campaigns/{id}/artifacts/{artifactId}",
    operationId: "readCampaignArtifact",
    summary:
      "Read a bounded immutable artifact preview `{ artifactId, path, mimeType, content, truncated, totalBytes }`. Optional ?path= selects a manifest entry; paths cannot escape the artifact. Text is for inspection, never executable markup. Source access is rechecked.",
    authenticated: true,
    responses: {
      "200": "Bounded preview.",
      "400": "Invalid artifact path.",
      "404": "Unknown artifact.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const campaignFamily: RouteFamily<typeof campaignRoutes> = {
  routes: campaignRoutes,
  handlers: (context) => {
    const served =
      (
        work: (
          service: CampaignService,
          request: Request,
          params: Readonly<Record<string, string>>,
        ) => Promise<Response>,
      ) =>
      async (request: Request, params: Readonly<Record<string, string>>) => {
        if (context.host.campaigns === undefined)
          return json(501, { error: "campaigns are unavailable", code: "unavailable" });
        try {
          return await work(context.host.campaigns, request, params);
        } catch (cause) {
          return campaignFailure(cause);
        }
      };
    return {
      listCampaignCartridges: served(async (service) => json(200, service.cartridgeInventory())),
      exportCampaignArtifact: served(async (service, request, params) =>
        json(
          200,
          await service.exportArtifact(
            params.id ?? "",
            params.artifactId ?? "",
            await boundedBody(request),
          ),
        ),
      ),
      listCampaigns: served(async (service) => json(200, service.list())),
      createCampaign: served(async (service, request) =>
        json(201, await service.create(await boundedBody(request))),
      ),
      readCampaign: served(async (service, _request, params) => {
        const snapshot = service.read(params.id ?? "");
        return snapshot === undefined
          ? json(404, { error: "no accessible campaign has that id" })
          : json(200, snapshot);
      }),
      commandCampaign: served(async (service, request, params) =>
        json(200, await service.command(params.id ?? "", await boundedBody(request))),
      ),
      readCampaignArtifact: served(async (service, request, params) =>
        json(
          200,
          await service.artifact(
            params.id ?? "",
            params.artifactId ?? "",
            new URL(request.url).searchParams.get("path") ?? undefined,
          ),
        ),
      ),
      campaignEvents: served(async (service, request, params) => {
        const id = params.id ?? "";
        if (service.read(id) === undefined)
          return json(404, { error: "no accessible campaign has that id" });
        const cursor =
          request.headers.get("last-event-id") ??
          new URL(request.url).searchParams.get("after") ??
          "0";
        if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
          return json(400, { error: "invalid campaign event cursor" });
        return campaignStream(service, id, Number(cursor), request.signal, context.streams);
      }),
    };
  },
};

function campaignStream(
  service: CampaignService,
  id: string,
  after: number,
  signal: AbortSignal,
  registry: { add(close: () => void): () => void },
): Response {
  let dispose = () => {};
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const cleanups: (() => void)[] = [];
      dispose = () => {
        if (closed) return;
        closed = true;
        for (const cleanup of cleanups) cleanup();
        try {
          controller.close();
        } catch {
          return;
        }
      };
      const write = (event: string, data: unknown, sequence?: number) => {
        if (closed) return;
        if ((controller.desiredSize ?? 1) < -100) {
          dispose();
          return;
        }
        try {
          controller.enqueue(
            encoder.encode(
              `${sequence === undefined ? "" : `id: ${sequence}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        } catch {
          dispose();
        }
      };
      let cursor = after;
      cleanups.push(
        service.subscribe(id, (event) => {
          if (event.sequence <= cursor) return;
          cursor = event.sequence;
          write("campaign", event, event.sequence);
        }),
      );
      for (const event of service.events(id, after)) {
        if (event.sequence <= cursor) continue;
        cursor = event.sequence;
        write("campaign", event, event.sequence);
      }
      const snapshot = service.read(id);
      if (snapshot !== undefined) {
        cursor = snapshot.sequence;
        write("snapshot", snapshot, cursor);
      }
      const timer = setInterval(() => write("heartbeat", { at: Date.now() }), 15_000);
      timer.unref?.();
      cleanups.push(() => clearInterval(timer));
      cleanups.push(registry.add(dispose));
      signal.addEventListener("abort", dispose, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", dispose));
      if (signal.aborted) dispose();
    },
    cancel: () => dispose(),
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

async function boundedBody(request: Request): Promise<unknown> {
  if (request.body === null) return bodyOf(request);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of request.body) {
    bytes += chunk.byteLength;
    if (bytes > 1_100_000)
      throw new CampaignStoreError("state", "campaign request exceeds the supported size");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    return undefined;
  }
}

function campaignFailure(cause: unknown): Response {
  if (cause instanceof z.ZodError)
    return json(400, {
      code: "invalid",
      error: "invalid campaign request",
      issues: cause.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  if (cause instanceof CampaignStoreError)
    return json(
      cause.code === "missing"
        ? 404
        : cause.code === "trust"
          ? 403
          : cause.code === "conflict" || cause.code === "lease"
            ? 409
            : 422,
      { code: cause.code, error: cause.message },
    );
  if (cause instanceof CampaignError)
    return json(cause.code === "stale-revision" ? 409 : cause.code === "forbidden" ? 403 : 422, {
      code: cause.code,
      error: cause.message,
    });
  return json(422, {
    code: "unavailable",
    error: cause instanceof Error ? cause.message : "campaign operation could not complete",
  });
}
