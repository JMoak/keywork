import {
  keeperOpeningJsonSchema,
  keeperOpeningOf,
  placementsReportJsonSchema,
  placementsReportOf,
  type SetOut,
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

export type ShowPort = Pick<
  SettingStore,
  "open" | "answer" | "keeperOpens" | "placed" | "clearSignal"
>;

const answerBody: JsonSchema = {
  type: "object",
  required: ["outcome"],
  properties: { outcome: { enum: [...settingAnswers] } },
};

const settingRow =
  "`{ id, creature, sessionId, what: { kind, ref, title }, rung, why, at, until, state, from, origin, replaces, place, size, where, seat, weight, mood, agent, mark, markTone, signal }`";

const unserved = "This host serves no settings.";

export const showRoutes = [
  {
    method: "GET",
    path: "/show",
    operationId: "listSettings",
    summary: `Every setting still out for the keeper, oldest first: \`{ settings }\`, each ${settingRow}. A setting is one thing set out for the keeper to see: by the model working a session, with the \`show\` tool every served session carries (a plain conversation, a creature's conversation, a child, a chore run), or by the keeper's own hand, opening something from inside a setting or a thread (\`POST /show\`). It is IDE control: it arranges the console's own space, never the computer, so it asks no permission. \`creature\` is the creature's slug, or null for a session with no creature. \`what.kind\` is \`file\`, \`diff\`, \`report\`, \`thread\`, \`chore\`, \`url\` or \`note\`, and \`what.ref\` the workspace path, change-set id, report id, session id, chore id, url or the note's own words; \`title\` is absent when none was given. \`rung\` is what was proposed (\`lantern\`, \`card\`, \`unfold\` or \`stage\`); the console decides the rung it uses, through its yard. \`why\` is the one sentence for the card (empty for the keeper's own openings and when the session gave none), \`at\` when it was set out, \`until\` when it goes (\`seen\`, \`rests\` or an ISO time) and \`state\` \`live\` or \`pinned\`. \`from\` is the id of the setting or the session it grew from, or null for one that starts a trail of its own; withdrawing or answering a setting never touches the settings that grew from it, so a console that folds them does so itself. \`origin\` is \`creature\` for what the model working a session set out, with or without a creature, and \`keeper\` for the keeper's own openings. \`replaces\` is the id of the setting this one replaced and withdrew (the same owner and the same thing, whoever set either out), or null, so a console moves what grew from the old id onto the new one. \`size\` is the size the session proposed it opens at, \`card\`, \`readable\` or \`working\`, and is absent when none was named; a console honours it the first time the setting opens and may still show less, a replacement keeps it unless it names another, and the keeper's own openings carry none. A console seats these on a cold start, as \`GET /sessions\` seats threads, then follows \`show.proposed\` and \`show.settled\` on the event stream. The server keeps them for the workspace under the node's state, saved on every change, so they outlive a console reconnecting, a server restart and a workspace re-trust exactly as they were, ids, times and lineage included; nothing settled is kept. When the server starts, a live setting whose time passed while it was stopped, a live \`rests\` setting (a stopped server is a rested thread) and a live setting whose session no longer exists are withdrawn with no \`show.settled\`, a pinned setting always comes back, and the hourly limit still counts what was set out before the stop. Since contract 1.27; \`from\`, \`origin\` and \`replaces\` since 1.28, and a console reading an older server takes their absence as \`from: null\`, \`origin: "creature"\` and \`replaces: null\`; \`size\` since 1.29, and an older server sends none. \`where\` is \`beside\` (beside the conversation, which is also what its absence means) or \`outside\` (a pane of its own outside the console window); \`seat\` is \`{ x, y, w, h }\`, a rectangle on the 12 by 12 lattice of the stage the console gives a session's panes, present only with \`outside\` and absent when the console chooses; \`weight\` is \`lead\`, \`support\` or \`aside\`; \`mood\` is \`calm\`, \`brisk\`, \`eager\`, \`playful\`, \`urgent\`, \`decisive\` or \`tentative\`, how it arrives. The four are what the session last asked, through \`show\` or an arrangement (\`show.arranged\`), never where the keeper has since put the pane, which the console reports through \`PUT /sessions/{sessionId}/settings/placements\`. The four, and \`card\` as a size, since 1.33; an older server sends none of them. \`agent\` is \`{ name?, color? }\`, present when an agent outside the session set the thing out through a creature's MCP server, with the name its client gave when it gave one and the colour the engine keeps for that agent (\`cyan\`, \`magenta\`, \`green\`, \`yellow\` or \`blue\`, never the red of an error); the setting stays the creature's, and a console marks it as the agent's with a square of that colour. \`mark\` is a word or two, at most 24 characters, that the session asked the keeper to read on the setting while it is out, absent when it has none; \`show.changed\` follows a change to it (both since 1.33). \`signal\` is \`needs-you\` or \`critical\`, absent when it has none: how much the setting wants the keeper, which a console draws as an outline (amber while it needs them, red when it is critical, and nothing else in its chrome red). The session raises and lowers it with \`show\` and \`arrange\`; \`critical\` comes with a \`why\` the session had to give, at most one at a time for the creature or thread and for each agent, and holds the setting out until the keeper has seen it (its \`until\` becomes \`seen\`); only the one who set the setting out, or the keeper through \`DELETE /show/{id}/signal\`, lowers it. A replacement keeps it unless it names another, and \`show.changed\` follows a change (since 1.35; an older server sends none). \`place\` is where in the stead the setting rises from and goes back to: \`{ kind: "workshop", creature }\`, \`{ kind: "porch" }\`, \`{ kind: "store" }\`, \`{ kind: "mill" }\` or \`{ kind: "project", creature, directory }\`; the creature's own workshop unless the session named another, the porch for a session with no creature and for an agent over a creature's MCP server. \`markTone\` is \`good\`, \`caution\` or \`bad\` when the mark has a tone, absent when it is neutral. A \`pane\` may also be \`workshop\`, \`mills\`, \`parcels\`, \`bots\`, \`campaigns\`, \`themes\`, \`posture\`, \`stead\`, \`terminal\` or \`screen\`, and a session's \`show\` of a terminal or a screen asks the keeper every time (both since 1.38; an older server sends no \`place\`, which a console reads as the creature's workshop).`,
    authenticated: true,
    responses: { "200": "`{ settings }`.", "503": unserved },
  },
  {
    method: "POST",
    path: "/show",
    operationId: "openSetting",
    summary: `Set out what the keeper opened from inside a setting or a thread (a file from a diff, a test from a file, a link), so every surface agrees on the trail. \`what\` is the thing, in the shape the \`show\` tool takes; \`from\` is the id of the setting still out, or of the session, it was opened from; \`rung\` is \`unfold\`, and may be left out. The keeper's own hand passes no gate and spends no budget: it never counts toward a creature's or a thread's hourly limit. The setting takes the thread and the creature of what it grew from (a setting's \`sessionId\` and \`creature\`, or the session itself and the creature it belongs to), with \`why\` empty, \`until\` \`seen\`, \`from\` as given and \`origin\` \`keeper\`, and \`show.proposed\` fires on that thread as for any setting. Opening the same thing again for the same owner replaces the earlier setting, which settles \`withdrawn\` by \`keeper\` first, and the new setting names it in \`replaces\`. Since contract 1.28.`,
    authenticated: true,
    requestBody: keeperOpeningJsonSchema,
    responses: {
      "201": "`{ setting }` as it was set out.",
      "400": "The body is not `{ what: { kind, ref, title? }, from, rung? }` with `rung` `unfold`.",
      "404": "No setting still out and no session has the id in `from`.",
      "503": unserved,
    },
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
  {
    method: "DELETE",
    path: "/show/{id}/signal",
    operationId: "clearSignal",
    summary:
      "The keeper clears a setting's signal: its outline goes, the setting stays out exactly as it was, and `show.changed` fires on the thread that set it out with the setting as it now stands. The session hears at the start of its next request that the keeper cleared it. This is how a `critical` is dealt with without putting the setting away; the keeper may clear a `needs-you` the same way. A console clears nothing locally. Since contract 1.35.",
    authenticated: true,
    responses: {
      "200": "`{ setting }` as it stands after the signal was cleared.",
      "404": "No setting still out has that id.",
      "409": "The setting carries no signal.",
      "503": unserved,
    },
  },
  {
    method: "PUT",
    path: "/sessions/{sessionId}/settings/placements",
    operationId: "reportPlacements",
    summary:
      "The console reports where a session's settings stand, so the session's `show`, `shown` and `arrange` tools can say it in words and the session hears what the keeper moved. The body is the whole current picture for that session and replaces the last one: `stage` is `{ room, cardsAcross, cardsDown, consoleMaximised }` (`room` is `beside` the console, `over` its far side, or the whole `display`; the two counts are how many card-size panes fit side by side and one above another); `placements` lists `{ id, where, seat?, by }` for each setting, with `where` `beside`, `outside` or `inside` (the keeper brought the pane into the console), `seat` its `{ x, y, w, h }` on the stage's 12 by 12 lattice when it is outside, and `by` who put it there last: `creature`, `keeper` or `console`; `arrangement`, `{ id, said }`, is present when the report answers a `show.arranged`, and `said` is one or two plain sentences telling what was done and what was corrected, which the waiting `arrange` tool passes on. A console sends it after an arrangement has played, after a session's pane arrives or leaves, and after the keeper moves, resizes, re-deals, brings inside or sends outside one of them, coalesced so a drag does not flood the server. The server keeps the latest report of each session in memory only, drops it with the session, and fires no event. Unknown fields are ignored. Since contract 1.33.",
    authenticated: true,
    requestBody: placementsReportJsonSchema,
    responses: {
      "204": "The report was kept.",
      "400":
        "The body is not `{ stage, placements, arrangement? }`, or a seat does not fit the lattice.",
      "404": "No session has that id.",
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
        openSetting: served(async (port, request) => {
          const opening = keeperOpeningOf(await bodyOf(request));
          if (opening === undefined) return json(400, { error: unreadableOpening });
          return opened(await port.keeperOpens(opening));
        }),
        answerSetting: served(async (port, request, { id = "" }) => {
          const outcome = answerOf(await bodyOf(request));
          if (outcome === undefined) return json(400, { error: unreadableAnswer });
          return answered(port.answer(id, outcome));
        }),
        clearSignal: served(async (port, _request, { id = "" }) => answered(port.clearSignal(id))),
        reportPlacements: served(async (port, request, { sessionId = "" }) => {
          const report = placementsReportOf(await bodyOf(request));
          if (report === undefined) return json(400, { error: unreadableReport });
          const refusal = await port.placed(sessionId, report);
          return refusal === undefined ? kept() : json(showRefusalStatus[refusal.refused], refusal);
        }),
      };
    },
  };
}

export function recordedShowEvents(log: Pick<EventLog, "record">): ShowEventSink {
  return <Type extends ShowEventType>(sessionId: string, type: Type, payload: ShowEvents[Type]) =>
    void log.record(sessionId, type, payload as WirePayload<Type>);
}

const unreadableOpening =
  "the body is { what: { kind, ref, title? }, from, rung? } with rung unfold";

const unreadableAnswer = "the body is { outcome } with seen, pinned, unpinned or dismissed";

const unreadableReport =
  "the body is { stage: { room, cardsAcross, cardsDown, consoleMaximised }, placements: [{ id, where, seat?, by }], arrangement?: { id, said } }, with every seat { x, y, w, h } inside the 12 by 12 lattice";

function kept(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

function answerOf(body: unknown): SettingAnswer | undefined {
  const outcome = fieldsOf<{ outcome: unknown }>(body)?.outcome;
  return settingAnswers.find((answer) => answer === outcome);
}

function opened(outcome: SetOut | ShowRefusal): Response {
  if ("refused" in outcome) return json(showRefusalStatus[outcome.refused], outcome);
  return json(201, { setting: outcome.setting });
}

function answered(answer: Setting | ShowRefusal): Response {
  if ("refused" in answer) return json(showRefusalStatus[answer.refused], answer);
  return json(200, { setting: answer });
}
