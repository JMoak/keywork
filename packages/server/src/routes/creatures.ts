import {
  type CreatureBody,
  type CreatureChores,
  type CreatureDraft,
  type CreaturePatch,
  type CreaturesPort,
  choresOver,
  demoteKeeperClass,
  type InboundPolicy,
  inboundPolicySchema,
  isRefused,
  MalformedCreatureError,
  type ModelClass,
  type ModelPolicy,
  type ModelPolicySlot,
  maxNamedSenders,
  modelClasses,
  noChores,
  nodeStateOfLedger,
  overturnKeeperDecision,
  promoteKeeperClass,
  RatchetUnreachableError,
  type Refused,
  type RemovalChoice,
  raiseCreature,
  ShadowReportUnserved,
  type SubstrateKind,
  seedLimit,
  slugOf,
  substrateKinds,
} from "@keywork/engine";
import type { SessionHost } from "../host.ts";
import { servedBy, unserved } from "./answers.ts";
import {
  bodyOf,
  fieldsOf,
  type JsonSchema,
  json,
  nonBlank,
  type RouteFamily,
  type RouteSpec,
} from "./family.ts";
import type { WorkshopsPort } from "./workshops.ts";

export type {
  CreatureChange,
  CreatureChanged,
  CreatureDetail,
  CreatureDraft,
  CreaturePatch,
  CreaturePause,
  CreatureRemoval,
  CreatureReport,
  CreatureSummary,
  CreaturesPort,
  CreatureThread,
  DayUsage,
  RemovalChoice,
  RoutineRunAhead,
  ThreadState,
} from "@keywork/engine";

const skinId = /^[a-z][a-z0-9-]*$/;

const modelChoice: JsonSchema = {
  oneOf: [
    { type: "string", const: "inherit" },
    {
      type: "object",
      required: ["provider", "model"],
      properties: {
        provider: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
  ],
};

const creatureBody: JsonSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 64 },
    skin: { type: "string", pattern: skinId.source },
    workshop: { type: "string", minLength: 1 },
    substrate: { enum: [...substrateKinds] },
    models: {
      type: "object",
      properties: Object.fromEntries(modelClasses.map((modelClass) => [modelClass, modelChoice])),
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const policyBody: JsonSchema = {
  type: "object",
  properties: Object.fromEntries(modelClasses.map((modelClass) => [modelClass, modelChoice])),
  additionalProperties: false,
};

const patchBody: JsonSchema = {
  type: "object",
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 64 },
    body: {
      type: "object",
      minProperties: 1,
      properties: {
        skin: { type: "string", pattern: skinId.source },
        seed: { type: "integer", minimum: 0, maximum: seedLimit },
      },
      additionalProperties: false,
    },
    models: policyBody,
    cloudFallback: { type: "boolean" },
    inbound: {
      oneOf: [
        { enum: ["nobody", "paired"] },
        {
          type: "object",
          required: ["named"],
          properties: {
            named: {
              type: "array",
              items: { type: "string", minLength: 1 },
              minItems: 1,
              maxItems: maxNamedSenders,
            },
          },
          additionalProperties: false,
        },
      ],
    },
  },
  additionalProperties: false,
};

const draftShape =
  'the body must be { name: string, skin?: string, workshop?: string, substrate?: "sbx" | "compose" | "host", models?: { strong | loop | decide | vision: "inherit" | { provider, model } } }, naming a workshop or a substrate, not both';

const patchShape =
  'the body must change at least one of { name?: string, body?: { skin?: string, seed?: integer }, models?: { strong | loop | decide | vision: "inherit" | { provider, model } }, cloudFallback?: boolean, inbound?: "nobody" | "paired" | { named: string[] } }';

const removalShape = "the query takes confirmed=true and keepWorkshop=true|false only";

const ruleClassBody: JsonSchema = {
  type: "object",
  required: ["ruleClass"],
  properties: { ruleClass: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

const ruleClassShape =
  "the body must be { ruleClass: string }, one rule class as the report names it";

const recordIdBody: JsonSchema = {
  type: "object",
  required: ["recordId"],
  properties: { recordId: { type: "string", minLength: 1 } },
  additionalProperties: false,
};

const recordIdShape =
  "the body must be { recordId: string }, the ledger id of a call decided for you";

export const creatureRoutes = [
  {
    method: "GET",
    path: "/creatures",
    operationId: "listCreatures",
    summary:
      "Every creature in this workspace: a bot (`GET /bots`) whose directory also holds a `creature.json`. Each row carries the bot's `slug` and `sigil`, the keeper's `name` for it, when it was `created`, its body (`skin`, `seed`) for the habitat, its `workshop` (`host` for the bare node, else a workshop id), its model policy `models` (`strong`, `loop`, `decide`, `vision`, each `inherit` or `{ provider, model }`), the id of its `conversation` once one exists (`null` before the first `GET /creatures/{slug}` opens it) how many live `threads` it has, and `paused`, when the keeper paused it (`POST /creatures/{slug}/pause`) or `null` while it runs. A bot without a `creature.json` is not listed; a creature with the host workshop and `inherit` everywhere behaves exactly as that bot would.",
    authenticated: true,
    responses: { "200": "The creatures.", "503": "This host serves no creatures." },
  },
  {
    method: "POST",
    path: "/creatures",
    operationId: "createCreature",
    summary:
      'Make a creature: writes `.keywork/bots/<slug>/bot.md` byte for byte as `POST /bots` would (so the creature is a bot first) and `creature.json` beside it, with the slug derived from `name` (REQ-003: the name stays editable in the file, the slug is its handle). `skin` defaults to the stead\'s first skin, every model class to `inherit`; the seed is drawn here. Where it works: `workshop` names an existing workshop id or `host` (the bare node, the default), or `substrate` (`sbx`, `compose` or `host`, as `GET /workshops/substrates` lists them) raises a new workshop for it first, exactly as `POST /workshops` would, records its id, then starts it as `POST /workshops/{id}/start` would, so the workshop reads `running` before the creature\'s first turn; the two are exclusive. A workshop that will not start leaves the creature made: its first tool call starts it (one line in that tool\'s output says so), and when it still cannot, the tool answers why in words and the creature tells the keeper. A substrate this node does not support is refused before anything is written, and a workshop raised for a creature that then cannot be written is removed again. The creature composes its one introduction sentence at creation and keeps it in `creature.json`, where the keeper can edit it. Needs a trusted workspace, as project bots do. Nothing is opened yet: the conversation is created lazily by the first `GET /creatures/{slug}`. A `creature.changed` event with `change: "created"` follows, after `workshop.changed` when one was raised and before its `change: "started"`.',
    authenticated: true,
    requestBody: creatureBody,
    responses: {
      "201": "The new creature's summary, as `GET /creatures` lists it.",
      "400": "The body is not a creature draft, or the name makes no slug.",
      "409": "A bot already has that slug, or the workspace is not trusted.",
      "502":
        "The substrate's own command failed while raising the workshop; `error` says what it said.",
      "503":
        "This host serves no creatures, serves no workshops while a substrate was named, or does not support that substrate (`error` says why).",
    },
  },
  {
    method: "GET",
    path: "/creatures/{slug}",
    operationId: "readCreature",
    summary:
      'One creature with what a console opened mid-day needs before the first event: the summary row, its `introduction`, the `conversation` id (opened now, bound to the bot and tagged `kind: conversation`, when the creature had none; it is never trashed while the creature exists), its live `threads` newest first, each `{ id, kind: thread | routine, title, state, children, lastActivityAt }` with `state` one of `working`, `waiting` (an ask is pending), `back`, `blocked` or `paused` and `children` the sub-agents rolled up into it, the `nextRun` of its routines (`{ routineId, at }` or `null`), today\'s `usage` (`{ date, sessions, costNanos }`, `costNanos` `null` when no ledger has priced it, never 0) and the `routines` directory under the creature. Live state afterward rides the session events on /events; thread summaries reach the conversation as prompts whose `origin` is `{ kind: "creature", creature, thread }`.',
    authenticated: true,
    responses: {
      "200": "The creature.",
      "404": "No creature has that slug.",
      "503": "This host serves no creatures.",
    },
  },
  {
    method: "PATCH",
    path: "/creatures/{slug}",
    operationId: "updateCreature",
    summary:
      'Change what the keeper may change about a creature in `creature.json`: its `name` (the slug stays its handle; an introduction still in the words it was composed with follows the new name, one the keeper edited is kept), its `body` (`skin`, `seed`), its model policy `models` (only the classes named change; `inherit` hands a class back to the workspace and user policy), `cloudFallback` and `inbound`, who may message it over the mesh (`nobody`, `paired` for creatures on this machine or a paired one, or `{ named: [...] }`, creature slugs optionally pinned with `@machine`; every summary carries it, `paired` when never set; see `POST /mesh/messages`). The file is validated as a whole before it is written. Answers the summary as `GET /creatures` lists it; a `creature.changed` event with `change: "updated"` follows.',
    authenticated: true,
    requestBody: patchBody,
    responses: {
      "200": "The creature's summary after the change.",
      "400": "The body changes nothing or is not a creature patch.",
      "404": "No creature has that slug.",
      "503": "This host serves no creatures.",
    },
  },
  {
    method: "GET",
    path: "/creatures/{slug}/report",
    operationId: "readCreatureReport",
    summary:
      'The keeper-would-approve report for this creature, as `keywork creatures report --json` prints it for the whole node but counted over the ledger rows tagged with this creature: `{ creature, gateId, mode: "shadow" | "enforce", enforced, ledgerPath, evidenceVersion?, rows, earlierRows, classes, gate?, auditRate, calibration, promotions, pendingReviews }`. Each class is `{ ruleClass, model?, rows, labelled, answered, agreement?, brier?, wouldAct, wrongActs, oneWayDoor, grade, gradeWord, gradeText }`. `calibration` holds one entry per model and rule class, `{ model, ruleClass, state, labelled, fitRows, heldOutRows, bar?, fitActs?, acts, sampleSize, agreement?, interval?, errors?, lowerBound?, review }`: the bar is fitted on the first 50 labelled answers and judged on the calls after them, `state` is `fitting`, `no-bar`, `collecting`, `awaiting-labels`, `accepted` or `rejected`, agreement and its 95% interval stay sealed until the planned sample is complete, and `review` counts the blind review (`drawn`, `answered`, `agreedWithGate`, `agreedWithMoment`, `deniedAtBar`) that samples answered asks at `auditRate`. `promotions` lists the rule classes the keeper handed over that cover this creature; with none, `mode` is `shadow`, `enforced` is false and every ask waits for the keeper. A one-way door is never promoted. A creature with no answered asks yet has `rows: 0` and no classes.',
    authenticated: true,
    responses: {
      "200": "The creature's shadow report.",
      "404": "No creature has that slug.",
      "503":
        "This host serves no creatures, knows no node state directory, or cannot load ratchet to grade the rows.",
    },
  },
  {
    method: "POST",
    path: "/creatures/{slug}/promote",
    operationId: "promoteCreatureClass",
    summary:
      "The keeper hands one rule class of this creature's asks to `keeper.would-approve`. The body is `{ ruleClass }`, exactly one class as the report names it. The promotion is accepted only when that class's calibration for the model answering it now is `accepted`: the bar was fitted on the first 50 labelled answers, then the planned sample of the first 149 distinct held-out calls above it (at most 10 from one session) were each approved, so the exact one-sided 95% lower bound reaches the promised 98%, and the blind review denied no call above the bar. A one-way door, `all classes`, a class already promoted, or one short of its evidence is refused with a `sentence` saying what it needs. The promotion is a reversible record scoped to this creature, `{ ruleClass, model, evidenceVersion, bar, creature, sampleSize, errors, lowerBound, by: \"keeper\", at }`. Decided calls still log, still show as decided for you and can be overturned, a blind review still samples them at the audit rate, and `POST /creatures/{slug}/demote` hands the class back. Nothing is ever promoted without this call.",
    authenticated: true,
    requestBody: ruleClassBody,
    responses: {
      "200": "`{ promoted: true, promotion, sentence }`.",
      "400": "The body is not `{ ruleClass: string }`.",
      "404": "No creature has that slug.",
      "409":
        "`{ promoted: false, refusal, sentence, calibration? }`, with `refusal` one of `one-way-door`, `every-class`, `promoted`, `unanswered`, `uncalibrated` or `blind-review`.",
      "503":
        "This host serves no creatures, knows no node state directory, or cannot load ratchet to grade the rows.",
    },
  },
  {
    method: "POST",
    path: "/creatures/{slug}/demote",
    operationId: "demoteCreatureClass",
    summary:
      'Hand a promoted rule class back to the keeper. The body is `{ ruleClass }`. Every promotion of that class covering this creature (its own, or one made for the whole node) ends with a demotion record `{ ruleClass, creature, by: "keeper", reason, at }`; every ask in the class waits for the keeper again, and promoting it again needs a fresh planned sample after this point. Answers `{ demoted: true, demotion, promotions, sentence }`, or `{ demoted: false, sentence }` when nothing was promoted.',
    authenticated: true,
    requestBody: ruleClassBody,
    responses: {
      "200": "`{ demoted, sentence }`, with the `demotion` and the `promotions` it ended.",
      "400": "The body is not `{ ruleClass: string }`.",
      "404": "No creature has that slug.",
      "503":
        "This host serves no creatures, knows no node state directory, or cannot load ratchet to grade the rows.",
    },
  },
  {
    method: "POST",
    path: "/creatures/{slug}/overturn",
    operationId: "overturnCreatureDecision",
    summary:
      'The keeper overturns one call a promoted class decided for them. The body is `{ recordId }`, the ledger id the "decided for you" notice carried (`extension.notice` from the `keeper` extension, `detail.recordId`). The row is labelled wrong with the source `keywork:overturn`, and every promotion of its rule class that covers this creature ends with a demotion `{ by: "overturn" }`, so every ask in that class waits for the keeper again until a fresh planned sample promotes it. Answers `{ overturned: true, recordId, ruleClass, demoted }` with the promotions it ended, or 409 `{ overturned: false, reason }` with `not-decided-for-you` (the id names no call a promoted class decided) or `already-overturned`. Since contract 1.23.',
    authenticated: true,
    requestBody: recordIdBody,
    responses: {
      "200": "`{ overturned: true, recordId, ruleClass, demoted }`.",
      "400": recordIdShape,
      "404": "No creature has that slug.",
      "409": "`{ overturned: false, reason }`.",
      "503":
        "This host serves no creatures, knows no node state directory, or cannot load ratchet.",
    },
  },
  {
    method: "POST",
    path: "/creatures/{slug}/pause",
    operationId: "pauseCreature",
    summary:
      'Pause a creature: every routine of it that is enabled is switched off through the routine verbs (`PUT /creatures/{slug}/routines/{id}` with `enabled: false`), and `creature.json` records `paused` with when and exactly which routines the pause switched off. Live threads finish; nothing is cancelled or lost, and stopping work stays its own verb. Pausing a paused creature changes nothing. Answers `{ slug, paused: true, since, chores }`; a `creature.changed` event with `change: "paused"` follows.',
    authenticated: true,
    responses: {
      "200": "`{ slug, paused, since, chores }` with the routines the pause switched off.",
      "404": "No creature has that slug.",
      "503": "This host serves no creatures.",
    },
  },
  {
    method: "POST",
    path: "/creatures/{slug}/resume",
    operationId: "resumeCreature",
    summary:
      'Resume a paused creature: the routines its pause switched off are switched back on (ones removed since are skipped, ones the keeper had off before stay off) and `paused` leaves `creature.json`. Resuming a creature that runs changes nothing. Answers `{ slug, paused: false, since: null, chores }` with the routines switched back on; a `creature.changed` event with `change: "resumed"` follows.',
    authenticated: true,
    responses: {
      "200": "`{ slug, paused, since, chores }` with the routines switched back on.",
      "404": "No creature has that slug.",
      "503": "This host serves no creatures.",
    },
  },
  {
    method: "DELETE",
    path: "/creatures/{slug}",
    operationId: "removeCreature",
    summary:
      'Remove a creature in two steps, as REQ-090 asks. Without `?confirmed=true` nothing changes: the answer is 409 carrying `removal`, what `goes` (its `definition` directory with `bot.md` and `creature.json`, its `conversation` and `threads`, which move to the trash as `DELETE /sessions/{id}` would, how many of its `notes` are retired from its memory layer, how many `routines` files go with the directory, and its `workshop` unless `?keepWorkshop=true`) and what `stays` (the `workspace` with the keeper\'s own notes, and the kept `workshop`). With `?confirmed=true` the same listing is carried out in that order, threads first, the conversation last, the definition after them, and the answer is 200 with `removed: true` and the `removal` that happened. A `creature.changed` event with `change: "removed"` follows; the trashed sessions fire `session.removed` each.',
    authenticated: true,
    responses: {
      "200":
        "`{ removed: true, removal }`: the creature is gone and `removal` says what went and what stayed.",
      "400": "The query is not `confirmed=true` and optionally `keepWorkshop=true|false`.",
      "404": "No creature has that slug.",
      "409": "Not confirmed: `removal` lists what `goes` and what `stays` when it is.",
      "503": "This host serves no creatures.",
    },
  },
] as const satisfies readonly RouteSpec[];

export const creatureFamily = {
  routes: creatureRoutes,
  handlers: ({ host, log, streams }) => {
    if (host.creatures !== undefined) {
      streams.add(host.creatures.subscribe((change) => log.record("", "creature.changed", change)));
    }
    const creatures = servedBy((): CreaturesPort | undefined => host.creatures, "creatures");
    return {
      listCreatures: creatures(async (port) => json(200, { creatures: await port.list() })),
      createCreature: creatures(async (port, request) => {
        const draft = creatureDraftOf(await bodyOf(request));
        if (draft === undefined) return json(400, { error: draftShape });
        const { substrate, ...creature } = draft;
        if (substrate === undefined) return json(201, await port.create(creature));
        if (host.workshops === undefined) return unserved("workshops");
        return created(await raisedOnAFreeName(port, host.workshops, creature, substrate));
      }),
      readCreature: creatures(async (port, _request, { slug }) => {
        const creature = await port.read(slug ?? "");
        return creature === undefined ? missingCreature() : json(200, creature);
      }),
      updateCreature: creatures(async (port, request, { slug }) => {
        const patch = creaturePatchOf(await bodyOf(request));
        if (patch === undefined) return json(400, { error: patchShape });
        try {
          const updated = await port.update(slug ?? "", patch);
          return updated === undefined ? missingCreature() : json(200, updated);
        } catch (cause) {
          if (cause instanceof MalformedCreatureError) return json(400, { error: cause.message });
          throw cause;
        }
      }),
      readCreatureReport: creatures(async (port, _request, { slug }) => {
        try {
          const report = await port.report(slug ?? "");
          return report === undefined ? missingCreature() : json(200, report);
        } catch (cause) {
          if (cause instanceof ShadowReportUnserved || cause instanceof RatchetUnreachableError) {
            return json(503, { error: cause.message });
          }
          throw cause;
        }
      }),
      promoteCreatureClass: creatures(async (port, request, { slug }) => {
        const ruleClass = ruleClassOf(await bodyOf(request));
        if (ruleClass === undefined) return json(400, { error: ruleClassShape });
        return inKeeperLedger(port, slug ?? "", async (nodeState) => {
          const outcome = await promoteKeeperClass({ nodeState, ruleClass, creature: slug });
          return json(outcome.promoted ? 200 : 409, outcome);
        });
      }),
      demoteCreatureClass: creatures(async (port, request, { slug }) => {
        const ruleClass = ruleClassOf(await bodyOf(request));
        if (ruleClass === undefined) return json(400, { error: ruleClassShape });
        return inKeeperLedger(port, slug ?? "", async (nodeState) =>
          json(200, await demoteKeeperClass({ nodeState, ruleClass, creature: slug })),
        );
      }),
      overturnCreatureDecision: creatures(async (port, request, { slug }) => {
        const recordId = recordIdOf(await bodyOf(request));
        if (recordId === undefined) return json(400, { error: recordIdShape });
        return inKeeperLedger(port, slug ?? "", async (nodeState) => {
          const outcome = await overturnKeeperDecision({ nodeState, recordId });
          return json(outcome.overturned ? 200 : 409, outcome);
        });
      }),
      pauseCreature: creatures(async (port, _request, { slug }) => {
        const pause = await port.pause(slug ?? "", choresOf(host));
        return pause === undefined ? missingCreature() : json(200, pause);
      }),
      resumeCreature: creatures(async (port, _request, { slug }) => {
        const pause = await port.resume(slug ?? "", choresOf(host));
        return pause === undefined ? missingCreature() : json(200, pause);
      }),
      removeCreature: creatures(async (port, request, { slug }) => {
        const choice = removalChoiceOf(new URL(request.url).searchParams);
        if (choice === undefined) return json(400, { error: removalShape });
        if (!choice.confirmed) {
          const removal = await port.removal(slug ?? "", choice);
          return removal === undefined
            ? missingCreature()
            : json(409, { error: `removing ${slug} needs confirmed=true`, removal });
        }
        const removal = await port.remove(slug ?? "", choice);
        return removal === undefined ? missingCreature() : json(200, { removed: true, removal });
      }),
    };
  },
} satisfies RouteFamily<typeof creatureRoutes>;

export type CreatureRequest = CreatureDraft & { substrate?: SubstrateKind };

export function creatureDraftOf(body: unknown): CreatureRequest | undefined {
  const fields = fieldsOf<{
    name: unknown;
    skin: unknown;
    workshop: unknown;
    substrate: unknown;
    models: unknown;
  }>(body);
  if (
    fields === undefined ||
    !onlyKeys(fields, ["name", "skin", "workshop", "substrate", "models"])
  ) {
    return undefined;
  }
  const name = nonBlank(fields.name);
  const skin = optionalString(fields.skin, (value) => skinId.test(value));
  const workshop = optionalString(fields.workshop, (value) => value.trim() !== "");
  const substrate = optionalString(fields.substrate, isSubstrateKind);
  const models = modelsOf(fields.models);
  if (name === undefined || name.length > 64) return undefined;
  if (skin === null || workshop === null || substrate === null || models === null) return undefined;
  if (workshop !== undefined && substrate !== undefined) return undefined;
  return {
    name,
    ...(skin !== undefined && { skin }),
    ...(workshop !== undefined && { workshop }),
    ...(substrate !== undefined && { substrate: substrate as SubstrateKind }),
    ...(models !== undefined && { models }),
  };
}

export function creaturePatchOf(body: unknown): CreaturePatch | undefined {
  const fields = fieldsOf<{
    name: unknown;
    body: unknown;
    models: unknown;
    cloudFallback: unknown;
    inbound: unknown;
  }>(body);
  const keys = ["name", "body", "models", "cloudFallback", "inbound"] as const;
  if (fields === undefined || !onlyKeys(fields, keys)) return undefined;
  if (!keys.some((key) => fields[key] !== undefined)) return undefined;
  const name = fields.name === undefined ? undefined : nonBlank(fields.name);
  const creatureBody = bodyPatchOf(fields.body);
  const models = modelsOf(fields.models);
  const cloudFallback = fields.cloudFallback;
  if (fields.name !== undefined && (name === undefined || name.length > 64)) return undefined;
  if (creatureBody === null || models === null) return undefined;
  if (cloudFallback !== undefined && typeof cloudFallback !== "boolean") return undefined;
  const inbound = inboundPatchOf(fields.inbound);
  if (inbound === null) return undefined;
  return {
    ...(name !== undefined && { name }),
    ...(creatureBody !== undefined && { body: creatureBody }),
    ...(models !== undefined && { models }),
    ...(cloudFallback !== undefined && { cloudFallback }),
    ...(inbound !== undefined && { inbound }),
  };
}

function inboundPatchOf(value: unknown): InboundPolicy | undefined | null {
  if (value === undefined) return undefined;
  const parsed = inboundPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function removalChoiceOf(
  query: URLSearchParams,
): (RemovalChoice & { confirmed: boolean }) | undefined {
  const confirmed = query.get("confirmed");
  const keepWorkshop = query.get("keepWorkshop");
  if (confirmed !== null && confirmed !== "true") return undefined;
  if (keepWorkshop !== null && keepWorkshop !== "true" && keepWorkshop !== "false") {
    return undefined;
  }
  return {
    confirmed: confirmed === "true",
    ...(keepWorkshop !== null && { keepWorkshop: keepWorkshop === "true" }),
  };
}

function missingCreature(): Response {
  return json(404, { error: "no creature has that slug" });
}

export function ruleClassOf(body: unknown): string | undefined {
  const fields = fieldsOf<{ ruleClass: unknown }>(body);
  if (fields === undefined || !onlyKeys(fields, ["ruleClass"])) return undefined;
  return nonBlank(fields.ruleClass)?.trim();
}

export function recordIdOf(body: unknown): string | undefined {
  const fields = fieldsOf<{ recordId: unknown }>(body);
  if (fields === undefined || !onlyKeys(fields, ["recordId"])) return undefined;
  return nonBlank(fields.recordId)?.trim();
}

async function inKeeperLedger(
  port: CreaturesPort,
  slug: string,
  act: (nodeState: string) => Promise<Response>,
): Promise<Response> {
  try {
    const report = await port.report(slug);
    return report === undefined
      ? missingCreature()
      : await act(nodeStateOfLedger(report.ledgerPath));
  } catch (cause) {
    if (cause instanceof ShadowReportUnserved || cause instanceof RatchetUnreachableError) {
      return json(503, { error: cause.message });
    }
    throw cause;
  }
}

function choresOf(host: SessionHost): CreatureChores {
  return host.routines === undefined ? noChores : choresOver(host.routines);
}

const raiseRefusalStatus: Readonly<Record<Refused["refused"], number>> = {
  invalid: 400,
  forbidden: 403,
  missing: 404,
  conflict: 409,
  deferred: 501,
  failed: 502,
  unavailable: 503,
};

type Raised = Awaited<ReturnType<typeof raiseCreature>>;

function created(outcome: Raised): Response {
  return isRefused(outcome)
    ? json(raiseRefusalStatus[outcome.refused], outcome)
    : json(201, outcome);
}

export function nameTakenOnNodeLine(slug: string, workshop: string): string {
  return `the name ${slug} is taken on this node: workshop ${workshop} belongs to a creature made in another workspace, and two creatures never share one · choose another name, or remove that workshop first (DELETE /workshops/${workshop})`;
}

async function raisedOnAFreeName(
  port: CreaturesPort,
  workshops: WorkshopsPort,
  creature: CreatureDraft,
  substrate: SubstrateKind,
): Promise<Raised> {
  const slug = slugOf(creature.name);
  const held = await workshopHeldElsewhere(port, workshops, slug);
  return held === undefined
    ? raiseCreature(port, workshops, creature, substrate)
    : { refused: "conflict", error: nameTakenOnNodeLine(slug, held) };
}

async function workshopHeldElsewhere(
  port: Pick<CreaturesPort, "list">,
  workshops: Pick<WorkshopsPort, "list">,
  slug: string,
): Promise<string | undefined> {
  const workshop = (await workshops.list()).find((each) => each.creature === slug);
  if (workshop === undefined) return undefined;
  const livesHere = (await port.list()).some((each) => each.slug === slug);
  return livesHere ? undefined : workshop.id;
}

function isSubstrateKind(value: string): boolean {
  return (substrateKinds as readonly string[]).includes(value);
}

function bodyPatchOf(value: unknown): Partial<CreatureBody> | undefined | null {
  if (value === undefined) return undefined;
  const fields = fieldsOf<{ skin: unknown; seed: unknown }>(value);
  if (fields === undefined || !onlyKeys(fields, ["skin", "seed"])) return null;
  const skin = optionalString(fields.skin, (candidate) => skinId.test(candidate));
  const seed = fields.seed;
  if (skin === null || (skin === undefined && seed === undefined)) return null;
  if (seed !== undefined && !isSeed(seed)) return null;
  return {
    ...(skin !== undefined && { skin }),
    ...(typeof seed === "number" && { seed }),
  };
}

function isSeed(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= seedLimit;
}

function optionalString(
  value: unknown,
  valid: (value: string) => boolean,
): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && valid(value) ? value : null;
}

function modelsOf(value: unknown): Partial<ModelPolicy> | undefined | null {
  if (value === undefined) return undefined;
  const fields = fieldsOf<Record<ModelClass, unknown>>(value);
  if (fields === undefined || !onlyKeys(fields, modelClasses)) return null;
  const models: Partial<ModelPolicy> = {};
  for (const modelClass of modelClasses) {
    const choice = fields[modelClass];
    if (choice === undefined) continue;
    if (!isModelChoice(choice)) return null;
    models[modelClass] = choice;
  }
  return models;
}

function isModelChoice(value: unknown): value is ModelPolicySlot {
  if (value === "inherit") return true;
  const fields = fieldsOf<{ provider: unknown; model: unknown }>(value);
  if (fields === undefined || !onlyKeys(fields, ["provider", "model"])) return false;
  return nonBlank(fields.provider) !== undefined && nonBlank(fields.model) !== undefined;
}

function onlyKeys(fields: object, allowed: readonly string[]): boolean {
  return Object.keys(fields).every((key) => allowed.includes(key));
}
