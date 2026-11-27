import type { KeeperNotifications } from "@keywork/engine";
import { servedBy } from "./answers.ts";
import { bodyOf, type JsonSchema, json, type RouteFamily, type RouteSpec } from "./family.ts";

const timeOfDay: JsonSchema = { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" };

const settingsChange: JsonSchema = {
  type: "object",
  properties: {
    quietHours: {
      type: "object",
      properties: { on: { type: "boolean" }, start: timeOfDay, end: timeOfDay },
      additionalProperties: false,
    },
    doNotDisturb: { type: "boolean" },
    tz: { type: ["string", "null"] },
  },
  additionalProperties: false,
};

export const notificationRoutes = [
  {
    method: "GET",
    path: "/notifications",
    operationId: "readNotifications",
    summary:
      'The keeper\'s notifications on this machine: `{ settings, quiet, held, digest }`. `settings` is `{ quietHours: { on, start, end }, doNotDisturb, tz }`: quiet hours a daily span of `HH:MM` times in `tz` (an IANA zone, or null for this machine\'s own) that may cross midnight, off by default with the span 22:00 to 07:00 ready; `doNotDisturb` a switch that holds until it is switched off. One set per machine, kept across restarts and shared by every workspace it serves. `quiet` is null, or `{ reason, since, until }` while nothing may interrupt: `reason` is `do-not-disturb` (it wins while both hold) or `quiet-hours`, `until` the end of quiet hours or null for do not disturb. While quiet holds creatures keep working, a question still waits in `GET /asks` and rings no bell, and a creature\'s panes do not rise (`show` sets them beside the conversation as cards). The engine decides the tier of everything that would notify, as a notice `{ id, tier, held, creature, session, title, at, about }`: `interrupt` for a question (`about.kind: "ask"`), a chore that needs the keeper (`chore`, with its `need`) and the memory inbox rising to three items (`inbox`); `digest` for a chore whose grant set waits with no run held on it, and for a finished run of a chore that notifies `always`; `log` for a finished run that needs nobody otherwise (`run`). A client rings for `tier: "interrupt"` with `held: false` and for nothing else. Outside quiet a `digest` notice arrives at once and rings nothing: it joins the unseen digest, which is made for it when none stands. `held` lists what quiet holds now, oldest first, of every tier but `log`; a notice that stops waiting (a question answered or lapsed, a chore need cleared) leaves it. When quiet ends everything held arrives as one digest. `digest` is the one unseen digest `{ id, at, reason, notices, folded, seenAt }` (`reason` `quiet-ended`, or `arrived` when a thing that can wait joined it outside quiet; interrupts first, then the rest, each oldest first, at most 50 listed and `folded` counting the rest), or null; a new digest carries the notices of an unseen one before it and replaces it, so at most one stands unseen. A console follows `notifications.notice`, `notifications.quiet`, `notifications.digest` and `notifications.settings` after a cold start. Since contract 1.41.',
    authenticated: true,
    responses: {
      "200": "`{ settings, quiet, held, digest }`.",
      "503": "This host keeps no notifications.",
    },
  },
  {
    method: "PATCH",
    path: "/notifications",
    operationId: "changeNotifications",
    summary:
      "Change the keeper's notification settings, any of `{ quietHours: { on?, start?, end? }, doNotDisturb, tz }`; what is left out stays. Answers the whole state as `GET /notifications` does. Fires `notifications.settings`, and `notifications.quiet` when the change began or ended quiet, with `notifications.digest` when ending it released what was held. Every workspace server of this machine follows the change within about a second. Since contract 1.41.",
    authenticated: true,
    requestBody: settingsChange,
    responses: {
      "200": "`{ settings, quiet, held, digest }` after the change.",
      "400":
        "A time that is not `HH:MM`, quiet hours that start and end at the same time, a zone that is not an IANA zone, or an unknown field; `error` says which.",
      "503": "This host keeps no notifications.",
    },
  },
  {
    method: "POST",
    path: "/notifications/digests/{id}/seen",
    operationId: "putDigestAway",
    summary:
      'The keeper has read the unseen digest: answers `{ digest }` with `seenAt` set and fires `notifications.digest` with `change: "seen"`; `GET /notifications` then has `digest: null`. Since contract 1.41.',
    authenticated: true,
    responses: {
      "200": "`{ digest }`, put away.",
      "404": "No unseen digest has that id.",
      "503": "This host keeps no notifications.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const notificationFamily = {
  routes: notificationRoutes,
  handlers: ({ host, log, streams }) => {
    if (host.notifications !== undefined) {
      streams.add(
        host.notifications.subscribe(({ type, payload }) => log.record("", type, payload)),
      );
    }
    const notifications = servedBy(
      (): KeeperNotifications | undefined => host.notifications,
      "notifications",
    );
    return {
      readNotifications: notifications(async (port) => json(200, port.state())),
      changeNotifications: notifications(async (port, request) => {
        const changed = port.change(await bodyOf(request));
        return "error" in changed ? json(400, changed) : json(200, changed);
      }),
      putDigestAway: notifications(async (port, _request, { id = "" }) => {
        const digest = port.seen(id);
        return digest === undefined
          ? json(404, { error: "no unseen digest has that id" })
          : json(200, { digest });
      }),
    };
  },
} satisfies RouteFamily<typeof notificationRoutes>;
