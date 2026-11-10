import {
  bindForClass,
  blankRecord,
  type CapabilityRecord,
  declaredFingerprint,
  formatReference,
  type InferenceBinding,
  type InheritRefusal,
  isLoopbackEndpoint,
  type ModelReference,
  type PolicyEnvironment,
  type Provider,
  ResolutionError,
  type ResolutionFailure,
  resolvePolicy,
  strongContextFloor,
} from "@keywork/engine";

export type ConversationModel =
  | (ModelReference & { mode: "chat" | "tools"; projectCheck?: ProjectCheck })
  | InheritRefusal;

interface ProjectCheck {
  endpoint: string;
  model: string;
}

export function conversationModel(
  reference: ModelReference | undefined,
  environment: PolicyEnvironment,
): ConversationModel {
  if (reference === undefined) {
    return { refused: "unconfigured", detail: "Choose a starting model for conversation." };
  }
  const resolved = resolveConversation(reference, environment);
  return resolved.ok
    ? {
        ...resolved.binding.reference,
        mode: resolved.mode,
        ...(resolved.projectCheck !== undefined && { projectCheck: resolved.projectCheck }),
      }
    : { refused: resolved.failure.code, detail: resolved.failure.message };
}

export function conversationProvider(
  reference: ModelReference,
  environment: PolicyEnvironment,
  open: (binding: InferenceBinding) => Provider,
): Provider {
  const resolved = resolveConversation(reference, environment);
  if (!resolved.ok) throw new ResolutionError(resolved.failure);
  const provider = open(resolved.binding);
  return resolved.mode === "tools" ? provider : withoutTools(provider);
}

export function conversationOnly(provider: Provider): boolean {
  return chatProviders.has(provider);
}

export function requireProjectModel(provider: Provider): void {
  if (conversationOnly(provider)) {
    throw new Error(
      "This model is ready for conversation only. Choose a model with tool support and enough context before assigning project work.",
    );
  }
}

const chatProviders = new WeakSet<Provider>();
const conversationScope =
  "This conversation cannot execute tools or perform project actions. You can discuss and explain; when work requires those actions, explain that it needs a model with verified tool support and sufficient context.";

type ConversationResolution =
  | { ok: true; binding: InferenceBinding; mode: "chat" | "tools"; projectCheck?: ProjectCheck }
  | { ok: false; failure: ResolutionFailure };

function resolveConversation(
  reference: ModelReference,
  environment: PolicyEnvironment,
): ConversationResolution {
  const bound = bindForClass(reference, "strong", environment.registrations);
  if (!bound.ok) return bound;
  const { binding } = bound;
  const capabilities =
    environment.capabilityOf?.(binding) ??
    blankRecord(
      binding.registration.endpoint,
      reference.model,
      declaredFingerprint(binding),
      (environment.now?.() ?? new Date()).toISOString(),
    );
  const refused = environment.refusalOf?.(binding, capabilities);
  if (refused !== undefined) return { ok: false, failure: refused };
  if (capabilities.modalities.known && !capabilities.modalities.value.output.includes("text")) {
    return {
      ok: false,
      failure: {
        code: "missing-capability",
        reference: formatReference(reference),
        model: reference.model,
        capability: "text-output",
        message: `${formatReference(reference)} does not report text output for conversation`,
      },
    };
  }
  const strong = resolvePolicy(
    { modelClass: "strong", levels: { creature: { strong: reference } } },
    environment,
  );
  if (strong.ok) return { ok: true, binding, mode: "tools" };
  if (
    strong.failure.code !== "missing-capability" ||
    !["tools", "contextAllocated"].includes(strong.failure.capability)
  ) {
    return { ok: false, failure: strong.failure };
  }
  const projectCheck = projectCheckFor(binding, capabilities);
  return { ok: true, binding, mode: "chat", ...(projectCheck !== undefined && { projectCheck }) };
}

function projectCheckFor(
  binding: InferenceBinding,
  capabilities: CapabilityRecord,
): ProjectCheck | undefined {
  const { tools, contextAllocated } = capabilities;
  const canCheckTools =
    !tools.known || (!tools.value && tools.evidence.source === "behaviour-probe");
  return isLoopbackEndpoint(binding.registration.endpoint) &&
    contextAllocated.known &&
    contextAllocated.value >= strongContextFloor &&
    canCheckTools
    ? { endpoint: binding.registration.endpoint, model: binding.reference.model }
    : undefined;
}

function withoutTools(provider: Provider): Provider {
  const chat: Provider = {
    name: provider.name,
    modelId: provider.modelId,
    capabilities: { input: ["text"], ...provider.capabilities, toolCalls: false },
    requestSupport: provider.requestSupport,
    async *stream(request) {
      for await (const delta of provider.stream({
        ...request,
        systemPrompt: `${request.systemPrompt}\n\n${conversationScope}`,
        tools: [],
        toolAdditions: [],
      })) {
        if (delta.type === "tool-call") {
          throw new Error(
            "This model is connected for conversation only; tool calls are disabled.",
          );
        }
        yield delta;
      }
    },
  };
  chatProviders.add(chat);
  return chat;
}
