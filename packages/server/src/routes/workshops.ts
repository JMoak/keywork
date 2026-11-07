import {
  type DisplayFrame,
  isRefused,
  type Refused,
  type SubstrateKind,
  type SubstrateReport,
  substrateKinds,
  type TerminalRun,
  terminalGrantAction,
  type WorkshopDetail,
  type WorkshopHealthReport,
  type WorkshopRemoval,
  type Workshops,
  type WorkshopView,
} from "@keywork/engine";
import type { PermissionRule } from "@keywork/shared";
import type { SessionHost } from "../host.ts";
import { servedBy } from "./answers.ts";
import {
  bodyOf,
  type JsonSchema,
  json,
  type RouteContext,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

export type WorkshopSubstrateKind = SubstrateKind;
export type WorkshopRecord = WorkshopView;
export type WorkshopHealthRecord = WorkshopHealthReport;
export type WorkshopRemovalRecord = WorkshopRemoval;
export type WorkshopFrame = DisplayFrame;
export type WorkshopRefusalRecord = Refused;
export type WorkshopDetailRecord = WorkshopDetail;
export type WorkshopSubstrateReport = SubstrateReport;
export type WorkshopTerminalRun = TerminalRun;

export type WorkshopsPort = Pick<
  Workshops,
  | "list"
  | "substrates"
  | "create"
  | "detail"
  | "start"
  | "stop"
  | "health"
  | "exec"
  | "remove"
  | "display"
>;

const egressRule: JsonSchema = {
  type: "object",
  required: ["host"],
  properties: {
    host: { type: "string", description: "A bare DNS name; wildcards are refused." },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    methods: {
      oneOf: [
        { const: "any" },
        {
          type: "array",
          items: { enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] },
        },
      ],
    },
  },
  additionalProperties: false,
};

const workshopBody: JsonSchema = {
  type: "object",
  required: ["creature", "substrate"],
  properties: {
    creature: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$" },
    substrate: { enum: [...substrateKinds] },
    template: { type: "string", pattern: "^docker/sandbox-templates@sha256:[a-f0-9]{64}$" },
    disks: {
      type: "object",
      properties: {
        rootGb: { type: "integer", minimum: 8, maximum: 512 },
        dockerGb: { type: "integer", minimum: 1, maximum: 512 },
      },
      additionalProperties: false,
    },
    cpus: { type: "integer", minimum: 1, maximum: 64 },
    memory: { type: "string", pattern: "^[1-9][0-9]*[mg]$" },
    gpu: { type: "boolean" },
    egress: { type: "array", items: egressRule },
    brokers: {
      type: "array",
      items: { enum: ["anthropic", "openai", "openrouter", "google", "groq", "mistral", "xai"] },
    },
    setup: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const terminalBody: JsonSchema = {
  type: "object",
  required: ["command"],
  properties: {
    command: { type: "string", minLength: 1, maxLength: 8000 },
    cwd: { type: "string", minLength: 1 },
    timeoutMs: { type: "integer", minimum: 1, maximum: 600000 },
  },
  additionalProperties: false,
};

const refusalResponses = {
  "404": "No workshop has that id.",
  "502": "The substrate's own command failed; `error` carries what it said.",
  "503": "This host serves no workshops, or the workshop's substrate is not available here.",
} as const;

export const workshopRoutes = [
  {
    method: "GET",
    path: "/workshops",
    operationId: "listWorkshops",
    summary:
      "Every creature's workshop on this node, oldest first: `{ workshops }`, each `{ id, creature, substrate, state, workdir, brokers, limitations, display, createdAt }`. A creature holds at most one workshop and two creatures never share one. `substrate` is `sbx` (a sealed microVM) or `host` (the bare node, whose `workdir` is the workspace that raised it); `limitations` says plainly what a workshop lacks, so a bare host is never shown as sealed. `brokers` names the model-provider credentials the node swaps in on egress; the workshop itself only ever holds sentinels. `display` is true when the substrate can carry a viewable display.",
    authenticated: true,
    responses: {
      "200": "`{ workshops }`.",
      "503": "This host serves no workshops.",
    },
  },
  {
    method: "GET",
    path: "/workshops/substrates",
    operationId: "listWorkshopSubstrates",
    summary:
      "What this node can raise a workshop on: `{ substrates, preferred }`, one row per kind (`sbx`, `compose`, `host`) `{ kind, supported, version, reason, limitations }`. `supported` is asked of the substrate itself (the `sbx` CLI is run for its version and must be the qualified one); an unsupported row's `reason` says why in words the keeper can act on, such as the sbx CLI not being installed. `limitations` names what every workshop of that kind lacks, so a bare host is never offered as sealed. `preferred` is the first supported kind in the order sbx, compose, host, or `null` when none is.",
    authenticated: true,
    responses: {
      "200": "`{ substrates, preferred }`.",
      "503": "This host serves no workshops.",
    },
  },
  {
    method: "POST",
    path: "/workshops",
    operationId: "createWorkshop",
    summary:
      "Raise a workshop for a creature. `substrate` picks `sbx` or `host`; `egress` lists the only hosts the creature may reach (bare DNS names; `methods` defaults to GET, HEAD and OPTIONS, `any` opens every method, and `port` opens plain TCP such as SSH), everything else stays denied; `brokers` grants model-provider credentials the node holds; `disks` are sized now because an `sbx` disk cannot grow later; `setup` runs once inside after the first start. A `host` workshop works in the workspace this node serves the request from: its `workdir` and jail are the workspace path, and its home under the node's state dir keeps only the workshop's own state; a sealed one never mounts the workspace. An `sbx` workshop is refused before anything is created when an inherited host-wide allow rule would cover a host the creature wants, and is removed again if its egress cannot be applied. `workshop.changed` fires with `change: \"created\"`.",
    authenticated: true,
    requestBody: workshopBody,
    responses: {
      "201": "The new workshop record, stopped.",
      "400": "The body is not a workshop spec; `error` names each field.",
      "409":
        "The creature already has a workshop, or the host's sbx policy conflicts with its egress.",
      "501": "The spec asks for something deferred past milestone one, such as a GPU.",
      ...refusalResponses,
    },
  },
  {
    method: "GET",
    path: "/workshops/{id}",
    operationId: "readWorkshop",
    summary: `One workshop as \`GET /workshops\` lists it, plus what the workshop pane shows: \`workspace\` (how it reaches the keeper's workspace: \`access\` \`direct\` for a bare host, which works in the workspace itself with the workspace path as its jail, \`working-copy\` for a sealed substrate, which never mounts it and works on a copy, or \`none\` for a bare host raised outside a workspace; \`path\`, the workspace or \`null\`; and \`returns\`, how its work comes back, in words), \`egress\` (\`policy\` \`deny-all\` and \`enforced\` for a microVM, \`none\` for a bare host; the creature's own \`rules\`; the \`brokerHosts\` its brokered credentials reach), \`resources\` (the \`cpus\` and \`memory\` recorded at creation, the \`disks\` sized then or \`null\` for a bare host, and \`measured\` disk and memory in bytes, each \`null\` with the reason in \`unmeasured\` when it cannot be read, such as a stopped microVM), \`refusals\` (\`entries\`, the newest fifty things the node refused for this workshop, each \`{ at, operation, refused, error }\`, and \`unreported\`, which refusals the node cannot see: an sbx network log has no documented reader yet) and \`terminal\` (\`allowed\` and \`reason\` for typed commands under the keeper's grants, and \`log\`, the newest fifty typed commands as tool calls \`{ at, tool: "bash", origin: "keeper", input, outcome }\`).`,
    authenticated: true,
    responses: { "200": "The workshop with its detail.", ...refusalResponses },
  },
  {
    method: "POST",
    path: "/workshops/{id}/start",
    operationId: "startWorkshop",
    summary:
      'Start a workshop and health-check it. An `sbx` workshop that comes up `running (not responding)` is stopped and started, then the `sbx` daemon is restarted, before the start is called failed. The first start also runs the spec\'s `setup`. `workshop.changed` fires with `change: "started"`.',
    authenticated: true,
    responses: {
      "200": "The workshop record, running.",
      "409": "The workshop cannot be started in its current state.",
      ...refusalResponses,
    },
  },
  {
    method: "POST",
    path: "/workshops/{id}/stop",
    operationId: "stopWorkshop",
    summary:
      'Stop a workshop with its disk kept (pause). Nothing in memory survives; work resumes from files and the journal. `workshop.changed` fires with `change: "stopped"`.',
    authenticated: true,
    responses: { "200": "The workshop record, stopped.", ...refusalResponses },
  },
  {
    method: "GET",
    path: "/workshops/{id}/health",
    operationId: "workshopHealth",
    summary:
      "`{ id, substrate, health, limitations }` where `health` is `up`, `starting`, `unresponsive` or `down`, read from the substrate itself (`sbx ls` for a microVM). `limitations` repeats what the workshop lacks, such as a bare host running commands unconfined.",
    authenticated: true,
    responses: { "200": "The health report.", ...refusalResponses },
  },
  {
    method: "POST",
    path: "/workshops/{id}/exec",
    operationId: "execInWorkshop",
    summary: `A typed terminal into one workshop: run \`command\` with the workshop's own shell from its workdir (or \`cwd\` inside it), through the same substrate exec the creature's \`bash\` tool uses, so it carries the same jail, the same broker sentinels and never a real credential, and answer \`{ workshop, code, stdout, stderr, timedOut }\`. A microVM workshop takes typed commands unless a keeper rule says otherwise; a bare host workshop runs them on this node itself, so it refuses with 403 until the keeper grants the rule \`{ action: "${terminalGrantAction}", resource: "<workshop id>" | "<creature>" | "*", effect: "allow" }\` in the workspace or user permissions; the last matching rule decides and an \`ask\` refuses, since a typed terminal cannot ask. Every command, run or refused, is logged as a keeper tool call in the workshop's terminal log; refusals also land in its refusal log. Output is answered, never stored.`,
    authenticated: true,
    requestBody: terminalBody,
    responses: {
      "200":
        "`{ workshop, code, stdout, stderr, timedOut }`; a non-zero `code` is the command's own.",
      "400": "The body is not `{ command, cwd?, timeoutMs? }`.",
      "403":
        "The keeper has not granted typed commands into this workshop; `error` says which rule would.",
      "409": "The workshop is not running.",
      ...refusalResponses,
    },
  },
  {
    method: "DELETE",
    path: "/workshops/{id}",
    operationId: "removeWorkshop",
    summary:
      'Remove a workshop. `?keepDisk=true` keeps its disk: an `sbx` sandbox is stopped and left in place, a host directory is moved to `workshops-kept/` under the node\'s state dir. Without it everything inside is deleted. `workshop.changed` fires with `change: "removed"`.',
    authenticated: true,
    responses: { "200": "`{ id, keptDisk }`.", ...refusalResponses },
  },
  {
    method: "GET",
    path: "/workshops/{id}/display",
    operationId: "streamWorkshopDisplay",
    summary:
      "The workshop's virtual display as a snapshot stream: server-sent `event: frame` with `data: { png, at }` once a second, `png` being a base64 PNG scaled to at most 1024x768. The stream ends with `event: ended` when the display goes away (no Xvfb in the workshop) and closes when the client leaves. View only; nothing here can type or click.",
    authenticated: true,
    responses: {
      "200": "An open text/event-stream of frames.",
      "503":
        "The workshop has no display (a bare host workshop never does), or no workshops are served.",
      "404": "No workshop has that id.",
    },
  },
] as const satisfies readonly RouteSpec[];

export function workshopFamily(
  workshopsOf: (host: SessionHost) => WorkshopsPort | undefined,
): RouteFamily<typeof workshopRoutes> {
  return {
    routes: workshopRoutes,
    handlers: (context) => {
      const served = servedBy(() => workshopsOf(context.host), "workshops");
      return {
        listWorkshops: served(async (port) => json(200, { workshops: await port.list() })),
        listWorkshopSubstrates: served(async (port) => json(200, await port.substrates())),
        createWorkshop: served(async (port, request) =>
          answered(await port.create(await bodyOf(request)), 201),
        ),
        readWorkshop: served(async (port, _request, { id = "" }) =>
          answered(await port.detail(id, await keeperGrants(context.host))),
        ),
        startWorkshop: served(async (port, _request, { id = "" }) =>
          answered(await port.start(id)),
        ),
        stopWorkshop: served(async (port, _request, { id = "" }) => answered(await port.stop(id))),
        workshopHealth: served(async (port, _request, { id = "" }) =>
          answered(await port.health(id)),
        ),
        execInWorkshop: served(async (port, request, { id = "" }) =>
          answered(await port.exec(id, await bodyOf(request), await keeperGrants(context.host))),
        ),
        removeWorkshop: served(async (port, request, { id = "" }) =>
          answered(await port.remove(id, keepsDisk(request))),
        ),
        streamWorkshopDisplay: served((port, request, { id = "" }) =>
          displayStream(port, request, id, context),
        ),
      };
    },
  };
}

const refusalStatus: Readonly<Record<WorkshopRefusalRecord["refused"], number>> = {
  invalid: 400,
  forbidden: 403,
  missing: 404,
  conflict: 409,
  deferred: 501,
  failed: 502,
  unavailable: 503,
};

function answered<Value>(answer: Value | WorkshopRefusalRecord, status = 200): Response {
  if (isRefused(answer)) return json(refusalStatus[answer.refused], answer);
  return json(status, answer);
}

async function keeperGrants(host: SessionHost): Promise<PermissionRule[]> {
  const { bundle, workspace } = await host.permissions();
  return [...bundle, ...workspace];
}

function keepsDisk(request: Request): boolean {
  return new URL(request.url).searchParams.get("keepDisk") === "true";
}

async function displayStream(
  port: WorkshopsPort,
  request: Request,
  id: string,
  context: RouteContext,
): Promise<Response> {
  const viewer = new AbortController();
  const frames = await port.display(id, viewer.signal);
  if (isRefused(frames)) return answered(frames);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const write = (text: string): void => {
        if (!viewer.signal.aborted) controller.enqueue(encoder.encode(text));
      };
      const leave = (): void => viewer.abort();
      request.signal.addEventListener("abort", leave, { once: true });
      const unregister = context.streams.add(leave);
      const finish = (ending: Readonly<Record<string, string>>): void => {
        write(`event: ended\ndata: ${JSON.stringify(ending)}\n\n`);
        unregister();
        request.signal.removeEventListener("abort", leave);
        viewer.abort();
        try {
          controller.close();
        } catch {}
      };
      write(": connected\n\n");
      void relayFrames(frames, write).then(
        () => finish({}),
        (cause: unknown) =>
          finish({ error: cause instanceof Error ? cause.message : String(cause) }),
      );
    },
    cancel: () => viewer.abort(),
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

async function relayFrames(
  frames: AsyncIterable<WorkshopFrame>,
  write: (text: string) => void,
): Promise<void> {
  for await (const frame of frames) {
    write(`event: frame\ndata: ${JSON.stringify({ png: frame.png, at: frame.at })}\n\n`);
  }
}
