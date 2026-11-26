import {
  type CreatureScene,
  type CreatureSceneChange,
  type SceneKeeping,
  type SceneKeepingInput,
  sceneKeepingInput,
  shownOf,
} from "@keywork/engine";
import { servedBy } from "./answers.ts";
import { bodyOf, json, type RouteFamily, type RouteSpec } from "./family.ts";

export interface SceneSetOutAnswer {
  out: number;
  missing: string[];
  asking: string[];
  stopped: string | null;
}

export interface CreatureScenesPort {
  list(slug: string): Promise<CreatureScene[] | undefined>;
  setOut(slug: string, name: string, visitor?: string): Promise<SceneSetOutAnswer | undefined>;
  keep?(slug: string, name: string, keeping: SceneKeepingInput): Promise<SceneKeeping | undefined>;
  forget(slug: string, name: string): Promise<boolean>;
  subscribe(listener: (change: CreatureSceneChange) => void): () => void;
}

const unservedScenes = "This host keeps no scenes.";

export const sceneRoutes = [
  {
    method: "GET",
    path: "/creatures/{slug}/scenes",
    operationId: "listCreatureScenes",
    summary:
      "The scenes a creature keeps, newest first: `{ scenes }`, each `{ creature, name, place, holds, keptAt }`. A scene is an arrangement the creature kept by name with its window tools (`arrange` with `keep`) and sets out again (`show` or `arrange` with `scene`): what it had out, and where each thing stood. `name` is as the creature gave it, trimmed and at most 40 characters, one per creature and name compared without regard to case. `place` is the place in the stead the scene belongs to, in the shape a setting's `place` has, or null: pressing that place sets the scene out. `holds` lists `{ kind, title }` for each thing in it, in order, for a list to print. A creature keeps at most 12; keeping a thirteenth is refused in words that name the limit. A console follows `creature.scenes` on the event stream after a cold start. Removing a creature drops its scenes. Since contract 1.40.",
    authenticated: true,
    responses: {
      "200": "`{ scenes }`, newest first.",
      "404": "No creature has that slug.",
      "503": unservedScenes,
    },
  },
  {
    method: "POST",
    path: "/creatures/{slug}/scenes/{name}/set-out",
    operationId: "setOutCreatureScene",
    summary:
      "Set a kept scene out now, at the keeper's press, as the creature's own panes in its conversation, each thing where it stood and rising from the place the scene belongs to. It passes the gate and the limits that setting each thing out by hand passes: each thing spends one of the creature's settings an hour and takes room among the twelve it may have outside, and the first thing refused stops the rest. A terminal or a screen acts on the keeper's machine, so it is not set out at once: the keeper is asked in the creature's conversation, as for any terminal or screen, and it is set out when they allow it. A scene the creature kept in a thread of a bound project is set out by that project's runtime, in that thread (or the creature's latest thread there when it is gone), where its files are; when that runtime does not answer nothing is set out and `stopped` says so. Answers `{ out, missing, asking, stopped }`: how many things were set out now; the titles of those that no longer exist (a file that is gone, a thread that was removed), which were left out while the rest went out; the titles waiting on the keeper's yes; and null, or the sentence saying why the rest were not set out. With `?visitor=<workspace>` a project's runtime sets out, in its own thread, a scene that creature of that workspace kept there; that form is for the creature's own server, not for display. Since contract 1.40.",
    authenticated: true,
    responses: {
      "200": "`{ out, missing, asking, stopped }`.",
      "404": "The creature keeps no scene by that name.",
      "503": unservedScenes,
    },
  },
  {
    method: "PUT",
    path: "/creatures/{slug}/scenes/{name}",
    operationId: "keepCreatureScene",
    summary:
      "Keep a scene for a creature that a bound project's runtime kept for it, as `arrange` with `keep` does in a thread there: the body is `{ place, things, keptIn }`, where `place` is the place the scene belongs to or null, `things` is what it sets out (`{ what, where, seat?, weight?, size? }` each) and `keptIn` is `{ workspace, session }`, the project and thread it was kept in. It counts against the same twelve as every scene of the creature, replaces a scene of the same name, and `creature.scenes` follows with `change: \"kept\"`. Answers `{ scene, replaced }`, or 409 with `{ error, scenes }` when the creature already keeps twelve. It is for the project's runtime, not for display, and grants nothing: setting the scene out passes the gate as before. Since contract 1.40.",
    authenticated: true,
    responses: {
      "200": "`{ scene, replaced }`.",
      "400": "The body is not a scene to keep.",
      "404": "No creature has that slug.",
      "409": "`{ error, scenes }`: the creature already keeps twelve scenes.",
      "503": unservedScenes,
    },
  },
  {
    method: "DELETE",
    path: "/creatures/{slug}/scenes/{name}",
    operationId: "forgetCreatureScene",
    summary:
      'Forget a scene a creature keeps, as the keeper\'s press. Nothing that is out moves; `creature.scenes` follows with `change: "forgotten"`. Since contract 1.40.',
    authenticated: true,
    responses: {
      "204": "The scene was forgotten.",
      "404": "The creature keeps no scene by that name.",
      "503": unservedScenes,
    },
  },
] as const satisfies readonly RouteSpec[];

export const sceneFamily = {
  routes: sceneRoutes,
  handlers: ({ host, log, streams }) => {
    if (host.scenes !== undefined) {
      streams.add(host.scenes.subscribe((change) => log.record("", "creature.scenes", change)));
    }
    const scenes = servedBy((): CreatureScenesPort | undefined => host.scenes, "scenes");
    return {
      listCreatureScenes: scenes(async (port, _request, { slug = "" }) => {
        const listed = await port.list(decodeURIComponent(slug));
        return listed === undefined
          ? json(404, { error: "no creature has that slug" })
          : json(200, { scenes: listed });
      }),
      setOutCreatureScene: scenes(async (port, request, { slug = "", name = "" }) => {
        const visitor = new URL(request.url).searchParams.get("visitor") ?? undefined;
        const answer = await port.setOut(
          decodeURIComponent(slug),
          decodeURIComponent(name),
          visitor,
        );
        return answer === undefined ? noSuchScene() : json(200, answer);
      }),
      keepCreatureScene: scenes(async (port, request, { slug = "", name = "" }) => {
        const keeping = sceneKeepingInput.safeParse(await bodyOf(request));
        if (!keeping.success || port.keep === undefined)
          return json(400, { error: "the body must be { place, things, keptIn }" });
        const kept = await port.keep(
          decodeURIComponent(slug),
          decodeURIComponent(name),
          keeping.data as SceneKeepingInput,
        );
        if (kept === undefined) return json(404, { error: "no creature has that slug" });
        if ("full" in kept)
          return json(409, {
            error: "the creature already keeps twelve scenes",
            scenes: kept.full,
          });
        return json(200, { scene: shownOf(kept.kept), replaced: kept.replaced });
      }),
      forgetCreatureScene: scenes(async (port, _request, { slug = "", name = "" }) => {
        const forgotten = await port.forget(decodeURIComponent(slug), decodeURIComponent(name));
        return forgotten
          ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
          : noSuchScene();
      }),
    };
  },
} satisfies RouteFamily<typeof sceneRoutes>;

function noSuchScene(): Response {
  return json(404, { error: "the creature keeps no scene by that name" });
}
