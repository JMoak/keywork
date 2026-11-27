import {
  bindForClass,
  bindingCapabilities,
  type CapabilityCache,
  type CapabilityName,
  type CapabilityRecord,
  type CreatureHost,
  type CreaturePatch,
  type CreatureRegistry,
  capabilityNames,
  catalogOf,
  creatureTagOf,
  formatReference,
  type InferenceBinding,
  ledgerConversationOf,
  localityOf,
  type ModelClass,
  type ModelNeed,
  type ModelReference,
  type PolicyEnvironment,
  type Provider,
  type ProviderRegistration,
  ResolutionError,
  resolvePolicy,
  type SessionStore,
  SilentServerError,
  serverRootOf,
  type TalkingChoice,
  UnusableModelError,
} from "@keywork/engine";
import type { ModelsPort, SessionInference } from "@keywork/server";
import {
  type AskingTheServer,
  type ConversationModel,
  conversationModel,
  conversationProvider,
} from "./serve-conversation-model.ts";

export interface CreatureModelOptions {
  registry: Pick<CreatureRegistry, "read">;
  inference: SessionInference | undefined;
  policy: Pick<PolicyEnvironment, "capabilityOf" | "refusalOf">;
  registrations?: (() => readonly ProviderRegistration[]) | undefined;
  inherit?: (() => ModelReference | undefined) | undefined;
  projectWork?: ((store: SessionStore) => boolean) | undefined;
  ask?: AskingTheServer | undefined;
  reach?: AskingTheServer | undefined;
}

export interface ConfiguredModelsOptions {
  registrations?: (() => readonly ProviderRegistration[]) | undefined;
  conversation?: (() => ConversationModel) | undefined;
  capabilities?: Pick<CapabilityCache, "recordsFor" | "record" | "store"> | undefined;
  headersFor?:
    | ((registration: ProviderRegistration) => Record<string, string> | undefined)
    | undefined;
  toolsKnown?: ((registration: ProviderRegistration, model: string) => boolean) | undefined;
  answers?:
    | ((endpoint: string, headers: Record<string, string> | undefined) => Promise<boolean>)
    | undefined;
}

export interface ConfiguredModels {
  models: ModelsPort;
  ask: AskingTheServer;
  reach: AskingTheServer;
}

export function configuredModels(
  models: ModelsPort,
  options: ConfiguredModelsOptions,
): ConfiguredModels {
  const atEndpoint = serializedEndpoints();
  const headersOf = (registration: ProviderRegistration) =>
    options.headersFor?.(registration) ?? undefined;
  const ask: AskingTheServer = async (binding) => {
    const { registration, reference } = binding;
    if (localityOf(registration.endpoint) !== "local") return;
    if (options.toolsKnown?.(registration, reference.model) === true) return;
    const endpoint = serverRootOf(registration.endpoint);
    const headers = headersOf(registration);
    const report = await atEndpoint(endpoint, () =>
      models.probe({
        endpoint,
        model: reference.model,
        behaviour: true,
        ...(headers !== undefined && { headers }),
      }),
    ).catch(() => undefined);
    if (statusOf(report) === "unreachable")
      throw new SilentServerError(registration.name, endpoint);
  };
  const reach: AskingTheServer = async ({ registration }) => {
    const answers = options.answers;
    if (answers === undefined || localityOf(registration.endpoint) !== "local") return;
    const endpoint = serverRootOf(registration.endpoint);
    if (!(await answers(endpoint, headersOf(registration))))
      throw new SilentServerError(registration.name, endpoint);
  };
  return {
    ask,
    reach,
    models: {
      ...models,
      probe: (request) => atEndpoint(serverRootOf(request.endpoint), () => models.probe(request)),
      list: async (filter) => {
        if (filter.node === undefined) {
          await Promise.all(
            localConnections(options.registrations?.() ?? []).map(({ endpoint, registrations }) =>
              atEndpoint(endpoint, () =>
                refreshMetadata(models, endpoint, registrations, {
                  cache: options.capabilities,
                  headers: registrations.map(headersOf).find((found) => found !== undefined),
                  toolsKnown: options.toolsKnown,
                }),
              ),
            ),
          );
        }
        const report = await models.list(filter);
        return filter.node === undefined && options.conversation !== undefined
          ? { ...report, conversation: options.conversation() }
          : report;
      },
    },
  };
}

function statusOf(report: object | undefined): unknown {
  return report !== undefined && "status" in report ? report.status : undefined;
}

interface LocalConnection {
  endpoint: string;
  registrations: ProviderRegistration[];
}

function localConnections(registrations: readonly ProviderRegistration[]): LocalConnection[] {
  const byEndpoint = new Map<string, ProviderRegistration[]>();
  for (const registration of registrations) {
    if (!registration.enabled || localityOf(registration.endpoint) !== "local") continue;
    const endpoint = serverRootOf(registration.endpoint);
    byEndpoint.set(endpoint, [...(byEndpoint.get(endpoint) ?? []), registration]);
  }
  return [...byEndpoint].map(([endpoint, grouped]) => ({ endpoint, registrations: grouped }));
}

export function refreshableModels(
  models: ModelsPort,
  reload: (() => Promise<void>) | undefined,
): ModelsPort {
  if (reload === undefined) return models;
  let pending: Promise<object> | undefined;
  return {
    ...models,
    refresh: () => {
      pending ??= reload()
        .then(() => models.list({}))
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}

export function creatureInitialProvider(
  options: CreatureModelOptions,
): (store: SessionStore) => Promise<Provider | undefined> {
  return async (store) => {
    const choice = await creatureChoiceFor(options, store);
    if (choice === undefined) return undefined;
    const inference = options.inference;
    if (inference === undefined) {
      throw new Error(`the model ${formatReference(choice.reference)} has no inference registry`);
    }
    const bound = inference.bind(formatReference(choice.reference));
    if (!bound.ok) throw new ResolutionError(bound.failure);
    await options.ask?.(bound.binding, choice.need);
    await options.reach?.(bound.binding, choice.need);
    return selectedCreatureProvider(options)(store, bound.binding);
  };
}

export function creatureTalkingChoice(
  options: CreatureModelOptions,
): (store: SessionStore) => Promise<TalkingChoice | undefined> {
  return async (store) => {
    const tag = creatureTagOf(store.entries());
    if (tag === undefined || !talksWithTheKeeper(store)) return undefined;
    return (await options.registry.read(tag.creature))?.file.models.strong;
  };
}

export function creatureModelReach(
  options: CreatureModelOptions,
): (store: SessionStore, reference: ModelReference) => Promise<void> {
  return async (store, reference) => {
    const tag = creatureTagOf(store.entries());
    if (tag === undefined && options.projectWork?.(store) !== true) return;
    const bound = options.inference?.bind(formatReference(reference));
    if (bound?.ok !== true) return;
    await options.reach?.(
      bound.binding,
      tag === undefined ? undefined : { creature: tag.creature, work: workOfSession(store) },
    );
  };
}

interface CreatureChoice {
  reference: ModelReference;
  need: ModelNeed | undefined;
}

async function creatureChoiceFor(
  options: CreatureModelOptions,
  store: SessionStore,
): Promise<CreatureChoice | undefined> {
  const tag = creatureTagOf(store.entries());
  const projectWork = options.projectWork?.(store) === true;
  if (tag === undefined && !projectWork) return undefined;
  const creature = tag === undefined ? undefined : await options.registry.read(tag.creature);
  const modelClass = projectWork || talksWithTheKeeper(store) ? "strong" : "loop";
  const slot = projectWork ? "inherit" : creature?.file.models[modelClass];
  if (slot === undefined) return undefined;
  const reference = slot === "inherit" ? options.inherit?.() : slot;
  if (reference === undefined) return undefined;
  return {
    reference,
    need: tag === undefined ? undefined : { creature: tag.creature, work: workOfSession(store) },
  };
}

function workOfSession(store: SessionStore): ModelNeed["work"] {
  return talksWithTheKeeper(store) ? "conversation" : "chore";
}

export function selectedCreatureProvider(
  options: CreatureModelOptions,
): (store: SessionStore, binding: InferenceBinding) => Provider {
  return (store, binding) => {
    const inference = options.inference;
    if (inference === undefined) throw new Error("No inference registry is available.");
    const tag = creatureTagOf(store.entries());
    const projectWork = options.projectWork?.(store) === true;
    const environment = {
      registrations: options.registrations?.() ?? [binding.registration],
      ...options.policy,
    };
    if (talksWithTheKeeper(store) && !projectWork) {
      return conversationProvider(
        binding.reference,
        environment,
        (candidate) => inference.provider(candidate),
        options.ask,
        tag === undefined ? undefined : { creature: tag.creature, work: "conversation" },
      );
    }
    if (tag === undefined && !projectWork) return inference.provider(binding);
    const modelClass = projectWork ? "strong" : "loop";
    const resolved = resolvePolicy(
      { modelClass, levels: { creature: { [modelClass]: binding.reference } } },
      environment,
    );
    if (!resolved.ok) throw new ResolutionError(resolved.failure);
    if (resolved.kind === "inherit") return inference.provider(binding);
    return inference.provider(resolved.plan.candidates[0].binding);
  };
}

function talksWithTheKeeper(store: SessionStore): boolean {
  const entries = store.entries();
  return (
    creatureTagOf(entries)?.kind === "conversation" || ledgerConversationOf(entries) !== undefined
  );
}

export interface ModelChoiceCheck {
  refusalOf(modelClass: ModelClass, reference: ModelReference): ModelRefusal | undefined;
  usableFor(modelClass: ModelClass, reported?: readonly ModelReference[]): ModelReference[];
}

export interface ModelRefusal {
  code: string;
  message: string;
}

export function modelChoiceCheck(environment: () => PolicyEnvironment): ModelChoiceCheck {
  const refusalOf = (
    modelClass: ModelClass,
    reference: ModelReference,
  ): ModelRefusal | undefined => {
    const current = environment();
    if (modelClass === "strong") {
      const conversation = conversationModel(reference, current);
      return "refused" in conversation
        ? { code: conversation.refused, message: conversation.detail }
        : undefined;
    }
    const bound = bindForClass(reference, modelClass, current.registrations);
    if (!bound.ok) return bound.failure;
    const resolved = resolvePolicy(
      { modelClass, levels: { creature: { [modelClass]: reference } } },
      current,
    );
    if (resolved.ok) return undefined;
    const { failure } = resolved;
    if (failure.code !== "missing-capability") return failure;
    const record = bindingCapabilities(bound.binding, current);
    return isKnown(record, failure.capability) ? failure : undefined;
  };
  return {
    refusalOf,
    usableFor: (modelClass, reported) =>
      distinctReferences([
        ...catalogOf(environment().registrations)
          .filter((entry) => entry.available)
          .filter(
            (entry) =>
              reported === undefined || localityOf(entry.registration.endpoint) !== "local",
          )
          .map((entry) => entry.reference),
        ...(reported ?? []),
      ]).filter((reference) => refusalOf(modelClass, reference) === undefined),
  };
}

export async function modelsReported(
  models: Pick<ModelsPort, "probe">,
  registrations: readonly ProviderRegistration[],
  headersFor?: ConfiguredModelsOptions["headersFor"],
): Promise<ModelReference[]> {
  const listed = await Promise.all(
    localConnections(registrations).map(async ({ endpoint, registrations: named }) => {
      const headers = named.map((each) => headersFor?.(each)).find((found) => found !== undefined);
      const report = await models
        .probe({ endpoint, ...(headers !== undefined && { headers }) })
        .catch(() => undefined);
      const ids = modelIdsIn(report);
      return named.flatMap(({ name }) => ids.map((model) => ({ provider: name, model })));
    }),
  );
  return listed.flat();
}

function modelIdsIn(report: object | undefined): string[] {
  if (report === undefined || statusOf(report) === "unreachable") return [];
  const { records, listedOnly } = report as {
    records?: readonly { model: string }[];
    listedOnly?: readonly string[];
  };
  return [...new Set([...(records ?? []).map(({ model }) => model), ...(listedOnly ?? [])])];
}

function distinctReferences(references: readonly ModelReference[]): ModelReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = formatReference(reference);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function modelCheckedCreatures<Host extends Pick<CreatureHost, "update">>(
  creatures: Host,
  check: ModelChoiceCheck | undefined,
  reported?: () => Promise<readonly ModelReference[]>,
): Host {
  if (check === undefined) return creatures;
  return {
    ...creatures,
    update: async (slug: string, patch: CreaturePatch) => {
      for (const [modelClass, slot] of Object.entries(patch.models ?? {})) {
        if (slot === undefined || slot === "inherit") continue;
        await refuseUnusable(check, modelClass as ModelClass, slot, reported);
      }
      return creatures.update(slug, patch);
    },
  };
}

async function refuseUnusable(
  check: ModelChoiceCheck,
  modelClass: ModelClass,
  reference: ModelReference,
  reported: (() => Promise<readonly ModelReference[]>) | undefined,
): Promise<void> {
  const refused = check.refusalOf(modelClass, reference);
  if (refused === undefined) return;
  const usable = check.usableFor(modelClass, await reported?.()).map(formatReference);
  const named = usable.slice(0, usableNamedAtMost).join(", ");
  const more = usable.length > usableNamedAtMost ? " and more" : "";
  const instead =
    usable.length === 0
      ? `No model connected here would answer ${purposeOf[modelClass]} yet: connect one first.`
      : `These would answer ${purposeOf[modelClass]}: ${named}${more}.`;
  throw new UnusableModelError(
    `${formatReference(reference)} cannot answer ${purposeOf[modelClass]}: ${reasonOf(refused, reference)}. ${instead}`,
    refused.code,
    usable,
  );
}

function reasonOf(refused: ModelRefusal, { provider, model }: ModelReference): string {
  switch (refused.code) {
    case "unavailable-credential":
      return `${provider} has no key on this machine`;
    case "unknown-provider":
      return `nothing connected here is named ${provider}`;
    case "unknown-model":
      return `${provider} has no model named ${model}`;
    case "disabled-provider":
      return `${provider} is turned off`;
    default:
      return withoutStop(refused.message);
  }
}

const usableNamedAtMost = 6;

const purposeOf: Readonly<Record<ModelClass, string>> = {
  strong: "when you talk with it",
  loop: "for its chores",
  decide: "for its decisions",
  vision: "for what it sees",
};

function withoutStop(text: string): string {
  return text.trim().replace(/[.?!\s]+$/, "");
}

function isKnown(record: CapabilityRecord, capability: string): boolean {
  return isCapabilityName(capability) && record[capability].known;
}

function isCapabilityName(name: string): name is CapabilityName {
  return (capabilityNames as readonly string[]).includes(name);
}

export function unavailableSelectedProvider(model: ModelReference, message: string): Provider {
  return {
    name: model.provider,
    modelId: model.model,
    stream() {
      throw new Error(message);
    },
  };
}

interface MetadataRefresh {
  cache: ConfiguredModelsOptions["capabilities"];
  headers: Record<string, string> | undefined;
  toolsKnown: ConfiguredModelsOptions["toolsKnown"];
}

async function refreshMetadata(
  models: Pick<ModelsPort, "probe">,
  endpoint: string,
  registrations: readonly ProviderRegistration[],
  { cache, headers, toolsKnown }: MetadataRefresh,
): Promise<void> {
  const before = cache?.recordsFor(endpoint) ?? [];
  await models.probe({ endpoint, refresh: true, ...(headers !== undefined && { headers }) });
  if (cache === undefined) return;
  keepLearnedInUse(cache, endpoint, before);
  const unasked = registrations.flatMap((registration) =>
    registration.models
      .map((spec) => spec.id)
      .filter((model) => cache.record(endpoint, model)?.tools.known === false)
      .filter((model) => toolsKnown?.(registration, model) !== true),
  );
  for (const model of new Set(unasked)) {
    await models.probe({
      endpoint,
      model,
      behaviour: true,
      ...(headers !== undefined && { headers }),
    });
  }
}

function keepLearnedInUse(
  cache: NonNullable<ConfiguredModelsOptions["capabilities"]>,
  endpoint: string,
  before: readonly CapabilityRecord[],
): void {
  for (const previous of before) {
    const refreshed = cache.record(endpoint, previous.model);
    if (refreshed === undefined || refreshed.server.id !== previous.server.id) continue;
    const asked =
      previous.tools.known &&
      previous.tools.evidence.source === "behaviour-probe" &&
      !refreshed.tools.known;
    const measured = previous.decodeTokensPerSecond.known && !refreshed.decodeTokensPerSecond.known;
    if (!asked && !measured) continue;
    cache.store({
      ...refreshed,
      ...(asked && { tools: previous.tools }),
      ...(measured && { decodeTokensPerSecond: previous.decodeTokensPerSecond }),
    });
  }
}

function serializedEndpoints(): <T>(endpoint: string, run: () => Promise<T>) => Promise<T> {
  const pending = new Map<string, Promise<unknown>>();
  return <T>(endpoint: string, run: () => Promise<T>): Promise<T> => {
    const previous = pending.get(endpoint) ?? Promise.resolve();
    const next: Promise<T> = previous
      .catch(() => undefined)
      .then(run)
      .finally(() => {
        if (pending.get(endpoint) === next) pending.delete(endpoint);
      });
    pending.set(endpoint, next);
    return next;
  };
}
