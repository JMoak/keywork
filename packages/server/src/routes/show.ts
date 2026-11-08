import {
  type Setting,
  type SettingAnswer,
  type SettingStore,
  type ShowEventSink,
  type ShowEvents,
  type ShowEventType,
  type ShowRefusal,
  settingAnswers,
  showRefusalStatus,
} from "@keywork/engine";
import type { EventLog, WirePayload } from "../events.ts";
import type { SessionHost } from "../host.ts";
import { servedBy } from "./answers.ts";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";

export type ShowPort = Pick<SettingStore, "open" | "answer">;

const answerBody: JsonSchema = {
  type: "object",
  required: ["outcome"],
  properties: { outcome: { enum: [...settingAnswers] } },
};

const settingRow =
  "`{ id, creature, sessionId, what: { kind, ref, title }, rung, why, at, until, state }`";

const unserved = "This host serves no settings.";

export const showRoutes = [
  {
    method: "GET",
    path: "/show",
    operationId: "listSettings",
    summary: `Every setting still out for the keeper, oldest first: \`{ settings }\`, each ${settingRow}. A setting is one thing the model working a session set out with the \`show\` tool, which every served session carries (a plain conversation, a creature's conversation, a child, a chore run). It is IDE control: it arranges the console's own space, never the computer, so it asks no permission. \`creature\` is the creature's slug, or null for a session with no creature. \`what.kind\` is \`file\`, \`diff\`, \`report\`, \`thread\`, \`chore\`, \`url\` or \`note\`, and \`what.ref\` the workspace path, change-set id, report id, session id, chore id, url or the note's own words; \`title\` is absent when none was given. \`rung\` is what the session proposed (\`lantern\`, \`card\`, \`unfold\` or \`stage\`); the console decides the rung it uses, through its yard. \`why\` is the one sentence for the card, \`at\` when it was set out, \`until\` when it goes (\`seen\`, \`rests\` or an ISO time) and \`state\` \`live\` or \`pinned\`. A console seats these on a cold start, as \`GET /sessions\` seats threads, then follows \`show.proposed\` and \`show.settled\` on the event stream. The server holds them in memory, so they outlive a console reconnecting but not the server. Since contract 1.27.`,
    authenticated: true,
    responses: { "200": "`{ settings }`.", "503": unserved },
  },
  {
    method: "POST",
    path: "/show/{id}/answer",
    operationId: "answerSetting",
    summary:
      'Record the keeper\'s answer to a setting and fire `show.settled` with `by: "keeper"` on the thread that set it out. `outcome` is `seen` (the keeper looked; it leaves the yard), `pinned` (it stays out, and the engine no longer withdraws it), `unpinned` (a pinned setting leaves, settled as seen) or `dismissed` (it leaves unread). Every keeper action on a setting posts here; a console settles nothing locally. Since contract 1.27.',
    authenticated: true,
    requestBody: answerBody,
    responses: {
      "200": "`{ setting }` as it stands after the answer.",
      "400": "The body is not `{ outcome }` with `seen`, `pinned`, `unpinned` or `dismissed`.",
      "404": "No setting still out has that id.",
      "409":
        "The answer moves nothing: `unpinned` on a setting that is not pinned, or `seen` or `pinned` on one that is.",
      "503": unserved,
    },
  },
] as const satisfies readonly RouteSpec[];

export function showFamily(
  showOf: (host: SessionHost) => ShowPort | undefined,
): RouteFamily<typeof showRoutes> {
  return {
    routes: showRoutes,
    handlers: (context) => {
      const served = servedBy(() => showOf(context.host), "settings");
      return {
        listSettings: served(async (port) => json(200, { settings: port.open() })),
        answerSetting: served(async (port, request, { id = "" }) => {
          const outcome = answerOf(await bodyOf(request));
          if (outcome === undefined) return json(400, { error: unreadableAnswer });
          return answered(port.answer(id, outcome));
        }),
      };
    },
  };
}

export function recordedShowEvents(log: Pick<EventLog, "record">): ShowEventSink {
  return <Type extends ShowEventType>(sessionId: string, type: Type, payload: ShowEvents[Type]) =>
    void log.record(sessionId, type, payload as WirePayload<Type>);
}

const unreadableAnswer = "the body is { outcome } with seen, pinned, unpinned or dismissed";

function answerOf(body: unknown): SettingAnswer | undefined {
  const outcome = fieldsOf<{ outcome: unknown }>(body)?.outcome;
  return settingAnswers.find((answer) => answer === outcome);
}

function answered(answer: Setting | ShowRefusal): Response {
  if ("refused" in answer) return json(showRefusalStatus[answer.refused], answer);
  return json(200, { setting: answer });
}
