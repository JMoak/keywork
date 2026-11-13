import type { PromptOrigin, SendBehavior } from "@keywork/engine";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  missingSession,
  nonBlank,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

const promptBody: JsonSchema = {
  type: "object",
  required: ["text"],
  properties: {
    text: { type: "string", minLength: 1 },
    behavior: { type: "string", enum: ["steer", "queue", "now"], default: "queue" },
  },
  additionalProperties: false,
};

export type PromptBehavior = SendBehavior | "now";

const promptBehaviors: readonly PromptBehavior[] = ["steer", "queue", "now"];

const clientName = /^[A-Za-z0-9._-]{1,64}$/;

const injectBody: JsonSchema = {
  type: "object",
  required: ["text", "client"],
  properties: {
    text: { type: "string", minLength: 1 },
    client: { type: "string", pattern: clientName.source },
    frame: {
      type: "object",
      required: ["creature"],
      properties: { creature: { type: "string", pattern: clientName.source } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const sessionRoutes = [
  {
    method: "GET",
    path: "/sessions",
    operationId: "listSessions",
    summary:
      "Session summaries, newest first, each carrying what a desk needs to say working, needs-you or back for a session no client has opened, from what this server already holds: `live` is true when the session is open in this server process (its agent loaded), as on `GET /sessions/{id}`; `working` is true while a turn runs, settles or has a prompt waiting in its queue here; `waiting` counts the asks pending on the session (`asks`) and names the tools they are for (`tools`); `changes`, present once a mutating call of the session has been announced on `changes.updated`, sums that listing as `{ files, added, deleted }` against the session-start baseline.",
    authenticated: true,
    responses: { "200": "The summaries." },
  },
  {
    method: "POST",
    path: "/sessions",
    operationId: "createSession",
    summary: "Create an empty session in this workspace.",
    authenticated: true,
    responses: { "201": "The new session's summary." },
  },
  {
    method: "GET",
    path: "/sessions/{id}",
    operationId: "readSession",
    summary:
      "One session with its messages. `asOf` is the latest /events id the messages already reflect, so a client that opened the stream first can drop buffered envelopes with `id <= asOf`. `summaries` marks the messages that are not prompts but folded history, each `{ index, entryId, kind }` with `index` into `messages` and `kind` either `compaction` or `branch_summary`, so a client draws a summary as a summary rather than as something the person typed. `flushes` marks the memory flushes the same way, each `{ index, entryId, facts }`: `messages[index]` is the prompt keywork sent to ask what was worth keeping (not a turn, never counted among the prompts `POST /sessions/{id}/restore` numbers), `messages[index + 1]` the model's reply, and `facts` the lines the reply kept, empty when nothing was worth keeping. `edits` says where the context edits of `POST /sessions/{id}/forget` sit, each `{ index, entryId, role, kind, text }`: `entryId` and `role` name the edited message, `kind` is `forgotten` (the message left `messages`, and `index` is where it sat, before the message that now follows it) or `rewritten` (it is `messages[index]`, carrying its replacement), and `text` is its own text before the edit (empty for a tool result). `reports` lists the one-line summaries a creature's finished threads sent to this conversation (`keywork.creature.report` entries: never prompts, never in the model context), each `{ index, entryId, at, text, origin, kind? }` with `index` the position in `messages` the entry was written before and `origin` the `{ kind: creature, creature, thread }` the live `extension.notice` carried, so a transcript draws the line after a reload exactly as it drew it live (since contract 1.10); `kind: frame` says `messages[index]` is the prompt an inject with `frame` wrote right after it, which a transcript draws as the creature line and never as a keeper prompt (since contract 1.11). `outcomes` says how each turn ended, each `{ index, entryId, outcome, error? }` with `messages[index]` the turn's prompt: `completed`, `interrupted` (stopped by an abort or a steer), `failed` (with `error`, the message the turn failed on), or `shutdown` (the engine stopped while the turn ran: a server that shut down mid-turn records it, and a turn the engine died in, its prompt with no reply and no `turn_facts`, reads as one when the session is next read). Whatever text the turn had produced stays in `messages` after its prompt. A turn still running, a turn whose prompt was compacted away, and a turn settled before outcomes were kept carry no mark (since contract 1.32). `live` is true when the session is open in this server process, or is a child its parent's `delegate` call is running.",
    authenticated: true,
    responses: { "200": "The session.", "404": "No session has that id." },
  },
  {
    method: "POST",
    path: "/sessions/{id}/prompt",
    operationId: "promptSession",
    summary:
      "Append a user prompt and run a turn. `behavior` defaults to `queue`: when a turn is already running the prompt waits behind it, which is what Enter does in the terminal composer. `steer` interrupts the running turn and runs this prompt before anything queued. `now` is the terminal's ctrl+enter: every prompt waiting in the queue is set aside (dropped from the queue and handed back in `setAside`, so a client can offer them again) and this one steers. When the policy would ask, a `gate.ask` event names the call and the turn waits on POST /asks/{callId}; an unanswered ask times out as a headless denial. Progress arrives on /events and a `session.state` envelope follows acceptance.",
    authenticated: true,
    requestBody: promptBody,
    responses: {
      "202":
        'The prompt was accepted; `queued` says whether it waits behind a running turn, and with `behavior: "now"`, `setAside` lists the prompts taken off the queue as `queue.changed` carried them. Watch /events for the turn.',
      "400": 'The body is not `{ text, behavior?: "steer" | "queue" | "now" }`.',
      "404": "No session has that id.",
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/inject",
    operationId: "injectPrompt",
    summary:
      'Submit a prompt from a client outside keywork, such as a voice assistant or another LLM window. It runs exactly like a typed prompt: it starts a turn when the session is idle and joins the back of the queue when a turn is running. `turn.started` and `queue.changed` carry `origin: { kind: "external", client }`, the turn answers to the same permission policy and ask queue, and any memory note it proposes is staged with provenance `untrusted`. With `frame: { creature }` the text is a frame the creature answers, never a keeper prompt (since contract 1.11): the origin is `{ kind: "creature", creature, thread }` with `thread` this session, a `keywork.creature.report` entry with `kind: frame` is written before the prompt so `GET /sessions/{id}` marks it under `reports` with the prompt at `messages[index]`, the live `extension.notice` carries `detail.kind: frame`, and the session takes the creature name as its title until the first reply of the creature titles it.',
    authenticated: true,
    requestBody: injectBody,
    responses: {
      "202": "The prompt was accepted; `queued` is true when it waits behind a running turn.",
      "400": "The body is not `{ text, client, frame?: { creature } }`.",
      "404": "No session has that id.",
    },
  },
  {
    method: "POST",
    path: "/sessions/{id}/abort",
    operationId: "abortSession",
    summary: "Interrupt the session's running turn, if any.",
    authenticated: true,
    responses: {
      "200": "Whether a turn was interrupted.",
      "404": "No session has that id.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const sessionFamily = {
  routes: sessionRoutes,
  handlers: ({ host }) => ({
    listSessions: async () => json(200, { sessions: await host.list() }),
    createSession: async () => json(201, await host.create()),
    readSession: async (_request, { id }) => {
      const session = await host.read(id ?? "");
      return session === undefined ? missingSession() : json(200, session);
    },
    promptSession: async (request, { id }) => {
      const prompt = promptOf(await bodyOf(request));
      if (prompt === undefined) {
        return json(400, {
          error: 'the body must be { text: string, behavior?: "steer" | "queue" | "now" }',
        });
      }
      const setAside = prompt.behavior === "now" ? await host.queue.setAside(id ?? "") : undefined;
      if (setAside === "missing") return missingSession();
      const outcome = await host.prompt(id ?? "", prompt.text, sendBehaviorOf(prompt.behavior));
      return outcome === "missing"
        ? missingSession()
        : json(202, {
            sessionId: id,
            accepted: true,
            queued: outcome === "queued",
            behavior: prompt.behavior,
            ...(setAside !== undefined && { setAside }),
          });
    },
    injectPrompt: async (request, { id }) => {
      const injection = injectionOf(await bodyOf(request));
      if (injection === undefined) {
        return json(400, {
          error: "the body must be { text: string, client: string, frame?: { creature: string } }",
        });
      }
      const outcome = await host.inject(id ?? "", injection.text, originOf(injection, id ?? ""));
      return outcome === "missing"
        ? missingSession()
        : json(202, { sessionId: id, accepted: true, queued: outcome === "queued" });
    },
    abortSession: async (_request, { id }) => {
      const outcome = await host.abort(id ?? "");
      return outcome === "missing"
        ? missingSession()
        : json(200, { sessionId: id, interrupted: outcome === "aborted" });
    },
  }),
} satisfies RouteFamily<typeof sessionRoutes>;

function promptOf(body: unknown): { text: string; behavior: PromptBehavior } | undefined {
  const fields = fieldsOf<{ text: unknown; behavior: unknown }>(body);
  const text = nonBlank(fields?.text);
  const behavior = fields?.behavior ?? "queue";
  if (text === undefined || !isPromptBehavior(behavior)) return undefined;
  return { text, behavior };
}

function isPromptBehavior(value: unknown): value is PromptBehavior {
  return (promptBehaviors as readonly unknown[]).includes(value);
}

function sendBehaviorOf(behavior: PromptBehavior): SendBehavior {
  return behavior === "now" ? "steer" : behavior;
}

interface Injection {
  text: string;
  client: string;
  creature?: string;
}

function injectionOf(body: unknown): Injection | undefined {
  const fields = fieldsOf<{ text: unknown; client: unknown; frame: unknown }>(body);
  const text = nonBlank(fields?.text);
  const client = fields?.client;
  if (text === undefined || typeof client !== "string" || !clientName.test(client))
    return undefined;
  if (fields?.frame === undefined) return { text, client };
  const creature = fieldsOf<{ creature: unknown }>(fields.frame)?.creature;
  if (typeof creature !== "string" || !clientName.test(creature)) return undefined;
  return { text, client, creature };
}

function originOf(injection: Injection, thread: string): PromptOrigin {
  return injection.creature === undefined
    ? { kind: "external", client: injection.client }
    : { kind: "creature", creature: injection.creature, thread };
}
