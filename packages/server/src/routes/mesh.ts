import {
  type AuditLog,
  type Authenticated,
  type CreatureMail,
  creatureSlug,
  defaultMessageLimits,
  type GrantService,
  isPairingFailure,
  isRefusal,
  type MeshCaller,
  type MeshCensus,
  type MeshClient,
  type MessageOutcome,
  meshAuditPath,
  meshGrantsPath,
  meshMessagesPath,
  meshRevocationsPath,
  meshToolCallPath,
  messageRefusalStatus,
  type PairingService,
  pairingPaths,
  pairRoles,
  type Refusal,
  rowsAfter,
  verifyAuditChain,
} from "@keywork/engine";
import type { SessionHost } from "../host.ts";
import type { MeshParams, MeshRoute } from "../mesh/router.ts";
import type { ManifestReader } from "../mesh/routes.ts";
import { screenSignalRelay } from "../mesh/screen-relay.ts";
import { screenTickets } from "../mesh/screen-tickets.ts";
import { settledCensus } from "../mesh-events.ts";
import { servedBy, unserved } from "./answers.ts";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";
import { meshConsoleRoutes, type OutboundPairings, outboundPairings } from "./mesh-console.ts";

export interface MeshTrust {
  pairing: PairingService;
  grants: GrantService;
  audit: AuditLog;
  screen?: ScreenHouse | undefined;
  messages?: Pick<CreatureMail, "receive"> | undefined;
}

export interface ScreenHouse {
  house: string;
  self(): string;
  machine(): string;
  pairSecret(pairId: string): Promise<Uint8Array | undefined>;
}

export interface MeshConsole extends MeshTrust {
  client: MeshClient;
  messages?: CreatureMail | undefined;
  census?: (() => Promise<MeshCensus>) | undefined;
}

export interface MeshFamilyOptions {
  now?: (() => number) | undefined;
}

export function meshTrustRoutes(trust: MeshTrust): MeshRoute[] {
  const paired = authenticatedBy(trust.pairing);
  const { pairing, grants } = trust;
  return [
    route("POST", pairingPaths.hello, async (request, caller) =>
      answered(await pairing.hello(caller, await bodyOf(request)), 201),
    ),
    route(
      "GET",
      pairingPaths.pending,
      paired(async (request) =>
        request.pair.role === "console"
          ? json(200, { pending: pairing.pending() })
          : json(403, { error: "mesh.not-a-console" }),
      ),
    ),
    route("GET", pairingPaths.attempt, async (_request, caller, { id = "" }) =>
      answered(await pairing.status(caller, id)),
    ),
    route("DELETE", pairingPaths.attempt, async (_request, caller, { id = "" }) =>
      answered(await pairing.cancel(caller, id)),
    ),
    route("POST", pairingPaths.reveal, async (request, caller, { id = "" }) =>
      answered(await pairing.reveal(caller, id, await bodyOf(request))),
    ),
    route("POST", pairingPaths.confirm, async (request, caller, { id = "" }) =>
      answered(await pairing.confirm(caller, id, await bodyOf(request))),
    ),
    route(
      "POST",
      pairingPaths.endorse,
      paired(async (request, { id = "" }) =>
        answered(await pairing.endorse(request, id, parsedBody(request))),
      ),
    ),
    route(
      "POST",
      meshGrantsPath,
      paired(async (request) => answered(await grants.install(request), 201)),
    ),
    route(
      "POST",
      meshToolCallPath,
      paired(async (request) => answered(await grants.call(request))),
    ),
    route("POST", meshRevocationsPath, async (request, caller) =>
      answered(await grants.applyRevocation(caller, await bodyOf(request))),
    ),
    route(
      "GET",
      meshAuditPath,
      paired(async (request, _params, url) => {
        if (request.pair.role !== "console") return json(403, { error: "mesh.not-a-console" });
        const after = url.searchParams.get("after") ?? undefined;
        const limit = Number(url.searchParams.get("limit") ?? "") || undefined;
        return json(200, { rows: await trust.audit.rows({ after, limit }) });
      }),
    ),
    ...screenRoutesOf(trust),
    ...messageRoutesOf(trust),
  ];
}

function screenRoutesOf({ screen, pairing }: MeshTrust): MeshRoute[] {
  if (screen === undefined) return [];
  const tickets = screenTickets({ ...screen, pairs: () => pairing.pairs() });
  return screenSignalRelay({ tickets, machine: screen.machine });
}

function messageRoutesOf({ messages, pairing }: MeshTrust): MeshRoute[] {
  if (messages === undefined) return [];
  const paired = authenticatedBy(pairing);
  return [
    route(
      "POST",
      meshMessagesPath,
      paired(async (request) => mailAnswer(await messages.receive(request))),
    ),
  ];
}

export function pairedManifestReader(pairing: Pick<PairingService, "pairs">): ManifestReader {
  return (caller) =>
    pairing
      .pairs()
      .some(
        ({ peerStableId, peerUserId }) =>
          peerStableId === caller.node.stableId && peerUserId === (caller.human?.userId ?? null),
      );
}

export const meshRoutes = [
  {
    method: "GET",
    path: "/mesh/pairs",
    operationId: "listMeshPairs",
    summary:
      "This node's pairing state: `{ claim, owner, pairs, pending }`. `claim` is `unclaimed` until the first console pairs; `owner` is the `(tailnetId, userId)` of the human who claimed it; `pairs` are the peers this node trusts, each `{ id, peerStableId, peerUserId, peerTags, role, caps, endpoint, createdAt, confirmedBy }` where `role` is `console` (may issue grants here), `node` (may call with grants) or `target` (this node is its console); `pending` lists inbound attempts with the six-digit `sas` to compare.",
    authenticated: true,
    responses: { "200": "`{ claim, owner, pairs, pending }`.", "503": "The mesh is not served." },
  },
  {
    method: "POST",
    path: "/mesh/pairs",
    operationId: "beginMeshPairing",
    summary:
      "Start pairing this console with a node found by discovery: sends the hello and the nonce reveal, then answers `{ attemptId, sas, confirmation, expiresAt }`. Show `sas` to the keeper; `confirmation` says what the target needs (`on-device`, a `claim-code`, or an `endorsement` from a console already paired there).",
    authenticated: true,
    requestBody: {
      type: "object",
      required: ["endpoint", "stableId", "role"],
      properties: {
        endpoint: {
          type: "string",
          description: "The node's mesh base URL, e.g. http://100.88.77.66:47800.",
        },
        stableId: { type: "string", description: "The node's StableID as WhoIs reports it." },
        userId: { type: ["string", "null"] },
        tags: { type: "array", items: { type: "string" } },
        role: { enum: [...pairRoles] },
        caps: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    responses: {
      "201": "The attempt with its SAS.",
      "400": "The body is not a pairing request.",
      "502": "The node refused or answered badly; `failed` says why.",
    },
  },
  {
    method: "POST",
    path: "/mesh/pairs/{id}/complete",
    operationId: "completeMeshPairing",
    summary:
      "Finish an attempt this console began. `matches: false` cancels it on both sides; `matches: true` sends the confirmation (with `claimCode` for a headless host) and waits for the target's own confirmation, then stores the pair key and answers `{ paired }`.",
    authenticated: true,
    requestBody: {
      type: "object",
      required: ["matches"],
      properties: { matches: { type: "boolean" }, claimCode: { type: "string" } },
      additionalProperties: false,
    },
    responses: {
      "200": "`{ paired }`.",
      "409": "The attempt ended without a pair; `failed` says why.",
    },
  },
  {
    method: "POST",
    path: "/mesh/pairings/{id}/confirm",
    operationId: "confirmMeshPairingHere",
    summary:
      "The keeper at this machine confirms an inbound attempt after comparing the SAS on both screens; `sas` is the code this node showed.",
    authenticated: true,
    requestBody: {
      type: "object",
      required: ["sas"],
      properties: { sas: { type: "string", pattern: "^[0-9]{6}$" } },
      additionalProperties: false,
    },
    responses: {
      "200": "`{ state }`: `confirming` until the console confirms, then `paired`.",
      "404": "No attempt has that id.",
      "409": "The attempt aborted; `reason` says why.",
    },
  },
  {
    method: "DELETE",
    path: "/mesh/pairs/{id}",
    operationId: "removeMeshPair",
    summary:
      "Forget a pair here at once. When this node is the peer's console, a signed revocation is pushed to the peer and retried until it lands.",
    authenticated: true,
    responses: { "200": "The signed revocation.", "404": "No pair has that id." },
  },
  {
    method: "GET",
    path: "/mesh/grants",
    operationId: "listMeshGrants",
    summary:
      "Live grants: `{ issued, installed }`. `issued` are grants this console signed for creatures to act on other nodes; `installed` are grants other consoles signed that let creatures act here. Each is `{ id, issuer, subject: { creature, node }, target, caps, issuedAt, expiresAt, nonce, signature }`.",
    authenticated: true,
    responses: { "200": "`{ issued, installed }`." },
  },
  {
    method: "POST",
    path: "/mesh/grants",
    operationId: "issueMeshGrant",
    summary:
      "Sign a grant with this console's device key and push it to the target node, which verifies the chain to a paired owner console and renders `files:*` and `exec` caps into rules scoped to the creature. Caps: `{ kind: files:read | files:write, paths }`, `{ kind: exec, commands }` (literal command heads), `{ kind: screen:view | screen:control | clipboard }`.",
    authenticated: true,
    requestBody: grantDraftBody(),
    responses: {
      "201": "The signed grant.",
      "400": "The draft is not a grant.",
      "403": "The target refused it.",
      "404": "This console is not paired with the target.",
    },
  },
  {
    method: "DELETE",
    path: "/mesh/grants/{id}",
    operationId: "revokeMeshGrant",
    summary:
      "Revoke a grant here at once and push a signed revocation to the target, retried until it lands.",
    authenticated: true,
    responses: { "200": "The signed revocation.", "404": "No live grant has that id." },
  },
  {
    method: "GET",
    path: "/mesh/audit",
    operationId: "meshAudit",
    summary:
      "This node's hash-chained audit rows: `{ rows, chain }`, each row `{ ts, actorStableID, actorUserID, actorTags, targetStableID, capability, requestDigest, decision, reason, prevHash, hash }`. Rows come oldest first; `?order=newest` turns the page newest first, so its first page holds the latest rows. `?after=<hash>` continues from a known row in the page's order (older rows when newest first) and `?limit=` caps the page; `chain` reports whether the whole log still verifies.",
    authenticated: true,
    responses: {
      "200": "`{ rows, chain }`.",
      "400": "`order` is neither `oldest` nor `newest`.",
    },
  },
  {
    method: "POST",
    path: "/mesh/screen/audit",
    operationId: "recordScreenAudit",
    summary:
      "Chain one screen row into this node's audit log, posted by the console that shared the screen. `kind: control` records a control grant decided over a live view (`decision`, `reason` in words, `expiresAt`); `kind: session` records a finished session with its grant, `scopes` (`view`, or `view` and `control`), `displays`, `path`, `startedAt`, `endedAt`, the end `reason` and the injected input counts. The row's capability is `screen:control` when control was held or asked, `screen:view` otherwise; its reason says every field in words and its `requestDigest` binds the record. A creature may control only its own workshop's display, so the console records an agent's request to control a keeper's desktop as a `deny` row.",
    authenticated: true,
    requestBody: screenAuditBody(),
    responses: {
      "201": "`{ row }`: the chained audit row.",
      "400": "The body is not a screen audit record.",
      "503": "The mesh is not served.",
    },
  },
  {
    method: "POST",
    path: "/mesh/messages",
    operationId: "sendCreatureMessage",
    summary:
      'One creature messages another, here or on a paired machine: plain text, delivered into the conversation of the receiving creature as one creature-origin line (`Message from <sender> on <machine>: <text>`, the `keywork.creature.report` entry the thread reports use, so it reads on `GET /sessions/{id}` under `reports`), never a prompt: no turn starts, and it cannot approve, grant, change configuration or run anything. `node` names the receiving machine by StableID; omit it (or name this machine) for a creature here, which needs no pairing. Across machines it rides the tailnet listener of the node with the pair-key proof every paired request carries, so a machine this one has not paired is refused in words before anything is sent. The `inbound` policy of the receiving creature decides (`nobody`, `paired`, the default, or `{ named }`); a message may cross one machine (`hop`), a creature may send 12 an hour, a conversation takes 50 an hour, and the same words from the same sender within the hour are dropped. Every message is an audit row on both nodes (`message.send` here, `message.receive` where it lands; the text is only digested). The `origin` of the delivered line is `{ kind: "creature", creature: <sender>, thread: <message id>, node, machine }`.',
    authenticated: true,
    requestBody: messageDraftBody(),
    responses: {
      "201":
        "`{ delivered: { id, from, to, node, machine, hop } }`: `node` is the sender's machine, `machine` the name of the one it landed on.",
      "400":
        "The body is not a message, or it has crossed more machines than the hop limit allows; `error` says which.",
      "403":
        "The receiving creature's inbound policy refused the sender, or the machines are not paired; `error` says why in words.",
      "404": "No creature has that slug, here or on the receiving machine.",
      "409":
        "The same words from the same sender reached that creature within the hour; the repeat is dropped.",
      "429": "The sender or the receiving conversation reached its hourly limit.",
      "502": "The receiving machine did not answer, or does not take creature messages yet.",
      "503": "The mesh or creature messages are not served.",
    },
  },
  {
    method: "POST",
    path: "/mesh/messages/arrivals",
    operationId: "takeCreatureMessage",
    summary:
      "The node hands this workspace a creature message that reached it over the tailnet after the pair proof held: `{ message: { id, from, to, text, hop }, caller: { stableId, name, userId, tags } }`, the caller as WhoIs named it, never as the sender claimed. The workspace runs it as a message that lands here through `POST /mesh/messages`: the inbound policy of the receiving creature, the hop, repeat and hourly limits, one line in its conversation and one `message.receive` audit row. A node that keeps its tailnet listener in another process than its workspaces posts each arrival here, trying the next workspace on 404.",
    authenticated: true,
    requestBody: arrivalBody(),
    responses: {
      "201": "`{ delivered }`, as `POST /mesh/messages` answers.",
      "400":
        "The body is not an arrival, or the message has crossed more machines than the hop limit allows.",
      "403": "The inbound policy of the receiving creature refused the sender.",
      "404": "No creature here has that slug.",
      "409": "The message was already delivered, or the same words arrived within the hour.",
      "429": "The sender or the receiving conversation reached its hourly limit.",
      "503": "The mesh or creature messages are not served.",
    },
  },
] as const satisfies readonly RouteSpec[];

const meshFamilyRoutes = [...meshRoutes, ...meshConsoleRoutes] as const;

export function meshFamily(
  meshOf: (host: SessionHost) => MeshConsole | undefined,
  options: MeshFamilyOptions = {},
): RouteFamily<typeof meshFamilyRoutes> {
  const now = options.now ?? Date.now;
  const ledgers = new WeakMap<MeshClient, OutboundPairings>();
  const pairingsOf = (client: MeshClient): OutboundPairings => {
    const held = ledgers.get(client) ?? outboundPairings(now);
    ledgers.set(client, held);
    return held;
  };
  return {
    routes: meshFamilyRoutes,
    handlers: (context) => {
      const served = servedBy(() => meshOf(context.host), "the mesh");
      return {
        listMeshPairs: served(async ({ pairing }) =>
          json(200, {
            claim: pairing.claimState(),
            owner: pairing.owner(),
            pairs: pairing.pairs(),
            pending: pairing.pending(),
          }),
        ),
        beginMeshPairing: served(async ({ client }, request) => {
          const target = pairingTargetOf(await bodyOf(request));
          if (target === undefined)
            return json(400, { error: "a pairing names an endpoint, a stableId and a role" });
          const begun = await client.begin(target, target);
          if (isPairingFailure(begun)) return json(502, begun);
          pairingsOf(client).began(target, begun);
          return json(201, begun);
        }),
        completeMeshPairing: served(async ({ client }, request, { id = "" }) => {
          const fields = fieldsOf<{ matches: unknown; claimCode: unknown }>(await bodyOf(request));
          if (typeof fields?.matches !== "boolean")
            return json(400, { error: "say whether the codes match" });
          const claimCode = typeof fields.claimCode === "string" ? fields.claimCode : undefined;
          const pairings = pairingsOf(client);
          if (fields.matches) pairings.confirming(id);
          try {
            const result = await client.complete(id, { matches: fields.matches, claimCode });
            return isPairingFailure(result) ? json(409, result) : json(200, result);
          } finally {
            pairings.ended(id);
          }
        }),
        confirmMeshPairingHere: served(async ({ pairing }, request, { id = "" }) => {
          const sas = fieldsOf<{ sas: unknown }>(await bodyOf(request))?.sas;
          if (typeof sas !== "string")
            return json(400, { error: "send the code this node showed" });
          return answered(await pairing.confirmOnDevice(id, sas));
        }),
        removeMeshPair: served(async ({ grants }, _request, { id = "" }) =>
          answered(await grants.forgetPair(id)),
        ),
        listMeshGrants: served(async ({ grants }) => json(200, grants.list())),
        issueMeshGrant: served(async ({ grants }, request) =>
          answered(await grants.issue(await bodyOf(request)), 201),
        ),
        revokeMeshGrant: served(async ({ grants }, _request, { id = "" }) =>
          answered(await grants.revoke(id)),
        ),
        meshAudit: served(async ({ audit }, request) => {
          const { searchParams } = new URL(request.url);
          const order = searchParams.get("order") ?? "oldest";
          if (order !== "oldest" && order !== "newest") {
            return json(400, { error: "order is oldest or newest" });
          }
          const all = await audit.rows({ limit: Number.MAX_SAFE_INTEGER });
          const query = {
            after: searchParams.get("after") ?? undefined,
            limit: Number(searchParams.get("limit") ?? "") || undefined,
          };
          const page =
            order === "newest" ? rowsAfter(all.toReversed(), query) : await audit.rows(query);
          return json(200, { rows: page, chain: verifyAuditChain(all) });
        }),
        recordScreenAudit: served(async ({ grants }, request) => {
          const recorded = await grants.recordScreen(await bodyOf(request));
          return isRefusal(recorded) ? answered(recorded) : json(201, { row: recorded });
        }),
        listMeshPeers: served(async ({ census }) => {
          if (census === undefined) return unserved("the tailnet census");
          try {
            return json(200, await settledCensus(census));
          } catch (cause) {
            const detail = cause instanceof Error ? cause.message : String(cause);
            return json(502, { error: `tailscale did not answer: ${detail}` });
          }
        }),
        listMeshPairings: served(async ({ client }) =>
          json(200, { pairings: pairingsOf(client).live() }),
        ),
        sendCreatureMessage: served(async ({ messages }, request) =>
          messages === undefined
            ? unserved("creature messages")
            : mailAnswer(await messages.send(await bodyOf(request))),
        ),
        takeCreatureMessage: served(async ({ messages }, request) =>
          messages === undefined
            ? unserved("creature messages")
            : mailAnswer(await messages.take(await bodyOf(request))),
        ),
      };
    },
  };
}

type PairedHandler = (request: Authenticated, params: MeshParams, url: URL) => Promise<Response>;

const refusalStatus: Readonly<Record<Refusal["refused"], number>> = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  missing: 404,
};

function route(method: MeshRoute["method"], path: string, handle: MeshRoute["handle"]): MeshRoute {
  return { method, path, handle };
}

function authenticatedBy(pairing: PairingService) {
  return (handle: PairedHandler): MeshRoute["handle"] =>
    async (request: Request, caller: MeshCaller, params: MeshParams) => {
      const authenticated = await pairing.authenticate(request, caller);
      if (isRefusal(authenticated)) return answered(authenticated);
      return handle(authenticated, params, new URL(request.url));
    };
}

function answered(value: unknown, status = 200): Response {
  if (isRefusal(value)) return json(refusalStatus[value.refused], { error: value.error });
  if (isAborted(value)) return json(409, value);
  return json(status, value);
}

function mailAnswer(outcome: MessageOutcome): Response {
  if ("refused" in outcome)
    return json(messageRefusalStatus[outcome.refused], { error: outcome.error });
  return json(201, outcome);
}

function isAborted(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { state?: unknown }).state === "aborted"
  );
}

function parsedBody(request: Authenticated): unknown {
  try {
    return JSON.parse(request.body);
  } catch {
    return undefined;
  }
}

interface PairingTargetFields {
  endpoint: string;
  stableId: string;
  userId: string | null;
  tags: string[];
  role: (typeof pairRoles)[number];
  caps: string[];
}

function pairingTargetOf(body: unknown): PairingTargetFields | undefined {
  const fields = fieldsOf<Record<keyof PairingTargetFields, unknown>>(body);
  const role = pairRoles.find((candidate) => candidate === fields?.role);
  if (
    typeof fields?.endpoint !== "string" ||
    typeof fields.stableId !== "string" ||
    role === undefined
  ) {
    return undefined;
  }
  return {
    endpoint: fields.endpoint,
    stableId: fields.stableId,
    userId: typeof fields.userId === "string" ? fields.userId : null,
    tags: stringsOf(fields.tags),
    role,
    caps: stringsOf(fields.caps),
  };
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function grantDraftBody(): JsonSchema {
  const paths = { type: "array", items: { type: "string" }, minItems: 1 };
  return {
    type: "object",
    required: ["subject", "target", "caps", "expiresAt"],
    properties: {
      subject: {
        type: "object",
        required: ["creature", "node"],
        properties: { creature: { type: "string" }, node: { type: "string" } },
        additionalProperties: false,
      },
      target: { type: "string", description: "The StableID of the node the creature may act on." },
      caps: {
        type: "array",
        minItems: 1,
        items: {
          oneOf: [
            {
              type: "object",
              required: ["kind", "paths"],
              properties: { kind: { enum: ["files:read", "files:write"] }, paths },
            },
            {
              type: "object",
              required: ["kind", "commands"],
              properties: {
                kind: { const: "exec" },
                commands: { type: "array", items: { type: "string" }, minItems: 1 },
              },
            },
            {
              type: "object",
              required: ["kind"],
              properties: { kind: { enum: ["screen:view", "screen:control", "clipboard"] } },
            },
          ],
        },
      },
      expiresAt: { type: "string", format: "date-time" },
    },
    additionalProperties: false,
  };
}

function messageDraftBody(): JsonSchema {
  const slug = { type: "string", pattern: creatureSlug.source };
  return {
    type: "object",
    required: ["from", "to", "text"],
    properties: {
      from: { ...slug, description: "The sending creature, on this machine." },
      to: { ...slug, description: "The receiving creature." },
      node: {
        type: "string",
        minLength: 1,
        description:
          "The receiving machine's StableID; omitted, or this machine's own, for a creature here.",
      },
      text: { type: "string", minLength: 1, maxLength: defaultMessageLimits.maxChars },
      hop: {
        type: "integer",
        minimum: 0,
        description:
          "How many machines the message that prompted this one had crossed; 0, the default, for a fresh message.",
      },
    },
    additionalProperties: false,
  };
}

function arrivalBody(): JsonSchema {
  const text = { type: "string", minLength: 1 };
  const slug = { type: "string", pattern: creatureSlug.source };
  return {
    type: "object",
    required: ["message", "caller"],
    properties: {
      message: {
        type: "object",
        required: ["id", "from", "to", "text", "hop"],
        properties: {
          id: text,
          from: slug,
          to: slug,
          text: { ...text, maxLength: defaultMessageLimits.maxChars },
          hop: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      caller: {
        type: "object",
        required: ["stableId", "name", "userId", "tags"],
        properties: {
          stableId: text,
          name: text,
          userId: { type: ["string", "null"] },
          tags: { type: "array", items: text },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
}

function screenAuditBody(): JsonSchema {
  const text = { type: "string", minLength: 1 };
  const instant = { type: "string", format: "date-time" };
  const grant = {
    sessionId: text,
    grantId: text,
    controlGrantId: text,
    peer: {
      type: "object",
      required: ["stableId", "name", "userId", "tags"],
      properties: {
        stableId: text,
        name: text,
        userId: { type: ["string", "null"] },
        loginName: text,
        tags: { type: "array", items: text },
      },
      additionalProperties: false,
    },
    controller: { enum: ["human", "agent"] },
  };
  const grantRequired = ["sessionId", "grantId", "peer", "controller"];
  return {
    oneOf: [
      {
        type: "object",
        required: ["kind", ...grantRequired, "decision", "reason"],
        properties: {
          kind: { const: "control" },
          ...grant,
          decision: { enum: ["allow", "deny"] },
          reason: text,
          expiresAt: instant,
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: [
          "kind",
          ...grantRequired,
          "scopes",
          "displays",
          "path",
          "endedAt",
          "reason",
          "inputs",
        ],
        properties: {
          kind: { const: "session" },
          ...grant,
          scopes: { type: "array", items: { enum: ["view", "control"] }, minItems: 1 },
          displays: { type: "array", items: text },
          path: text,
          startedAt: instant,
          endedAt: instant,
          reason: text,
          inputs: {
            type: "object",
            required: ["pointer", "keys"],
            properties: {
              pointer: { type: "integer", minimum: 0 },
              keys: { type: "integer", minimum: 0 },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    ],
  };
}
