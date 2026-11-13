import {
  type CapabilityCache,
  type CreatureRegistry,
  creatureTagOf,
  formatReference,
  type InferenceBinding,
  isLoopbackEndpoint,
  type ModelReference,
  type PolicyEnvironment,
  type Provider,
  type ProviderRegistration,
  ResolutionError,
  resolvePolicy,
  type SessionStore,
  serverRootOf,
} from "@keywork/engine";
import type { ModelsPort, SessionInference } from "@keywork/server";
import { type ConversationModel, conversationProvider } from "./serve-conversation-model.ts";

export interface CreatureModelOptions {
  registry: Pick<CreatureRegistry, "read">;
  inference: SessionInference | undefined;
  policy: Pick<PolicyEnvironment, "capabilityOf" | "refusalOf">;
  registrations?: (() => readonly ProviderRegistration[]) | undefined;
  inherit?: (() => ModelReference | undefined) | undefined;
  projectWork?: ((store: SessionStore) => boolean) | undefined;
}

export interface ConfiguredModelsOptions {
  registrations?: (() => readonly ProviderRegistration[]) | undefined;
  conversation?: (() => ConversationModel) | undefined;
  capabilities?: Pick<CapabilityCache, "recordsFor" | "record" | "store"> | undefined;
}

export function configuredLoopbackModels(
  models: ModelsPort,
  options: ConfiguredModelsOptions,
): ModelsPort {
  const atEndpoint = serializedEndpoints();
  return {
    ...models,
    probe: (request) => atEndpoint(serverRootOf(request.endpoint), () => models.probe(request)),
    list: async (filter) => {
      if (filter.node === undefined) {
        const endpoints = new Set(
          (options.registrations?.() ?? [])
            .filter(
              (registration) => registration.enabled && isLoopbackEndpoint(registration.endpoint),
            )
            .map((registration) => serverRootOf(registration.endpoint)),
        );
        await Promise.all(
          [...endpoints].map((endpoint) =>
            atEndpoint(endpoint, () => refreshMetadata(models, endpoint, options.capabilities)),
          ),
        );
      }
      const report = await models.list(filter);
      return filter.node === undefined && options.conversation !== undefined
        ? { ...report, conversation: options.conversation() }
        : report;
    },
  };
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
    const tag = creatureTagOf(store.entries());
    const projectWork = options.projectWork?.(store) === true;
    if (tag === undefined && !projectWork) return undefined;
    const creature = tag === undefined ? undefined : await options.registry.read(tag.creature);
    const modelClass = projectWork || tag?.kind === "conversation" ? "strong" : "loop";
    const slot = projectWork ? "inherit" : creature?.file.models[modelClass];
    if (slot === undefined) return undefined;
    const choice = slot === "inherit" ? options.inherit?.() : slot;
    if (choice === undefined) return undefined;
    const inference = options.inference;
    if (inference === undefined) {
      throw new Error(`the model ${formatReference(choice)} has no inference registry`);
    }
    const bound = inference.bind(formatReference(choice));
    if (!bound.ok) throw new ResolutionError(bound.failure);
    return selectedCreatureProvider(options)(store, bound.binding);
  };
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
    if (tag?.kind === "conversation" && !projectWork) {
      return conversationProvider(binding.reference, environment, (candidate) =>
        inference.provider(candidate),
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

export function unavailableSelectedProvider(model: ModelReference, message: string): Provider {
  return {
    name: model.provider,
    modelId: model.model,
    stream() {
      throw new Error(message);
    },
  };
}

async function refreshMetadata(
  models: Pick<ModelsPort, "probe">,
  endpoint: string,
  cache: ConfiguredModelsOptions["capabilities"],
): Promise<void> {
  const before = cache?.recordsFor(endpoint) ?? [];
  await models.probe({ endpoint, refresh: true });
  if (cache === undefined) return;
  for (const previous of before) {
    if (!previous.tools.known || previous.tools.evidence.source !== "behaviour-probe") continue;
    const refreshed = cache.record(endpoint, previous.model);
    if (
      refreshed === undefined ||
      refreshed.server.id !== previous.server.id ||
      refreshed.tools.known
    )
      continue;
    cache.store({ ...refreshed, tools: previous.tools });
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
