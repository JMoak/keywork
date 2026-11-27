import {
  bindForClass,
  bindingCapabilities,
  type CapabilityRecord,
  formatReference,
  type InferenceBinding,
  isLoopbackEndpoint,
  type ModelNeed,
  type ModelReference,
  namesItsTools,
  type PolicyEnvironment,
  type Provider,
  type ProviderRequest,
  ResolutionError,
  type ResolutionFailure,
  resolvePolicy,
  strongContextFloor,
  type TalkingModel,
  type ToolCheck,
  type TurnDelta,
  toolGuidance,
  withoutPanes,
  workingManner,
  yardPrompt,
} from "@keywork/engine";
import { workshopLineOpening } from "./serve-creatures.ts";

export type ConversationModel = TalkingModel;

export type AskingTheServer = (binding: InferenceBinding, need?: ModelNeed) => Promise<void>;

export function conversationModel(
  reference: ModelReference | undefined,
  environment: PolicyEnvironment,
): ConversationModel {
  if (reference === undefined) {
    return { refused: "unconfigured", detail: "Choose a starting model for conversation." };
  }
  const resolved = resolveConversation(reference, environment);
  if (!resolved.ok) return { refused: resolved.failure.code, detail: resolved.failure.message };
  return {
    ...resolved.binding.reference,
    mode: resolved.mode,
    ...(resolved.mode === "chat" && { detail: chatDetail(reference, resolved.capabilities) }),
    ...(resolved.projectCheck !== undefined && { projectCheck: resolved.projectCheck }),
  };
}

export function conversationProvider(
  reference: ModelReference,
  environment: PolicyEnvironment,
  open: (binding: InferenceBinding) => Provider,
  ask: AskingTheServer = async () => undefined,
  need?: ModelNeed,
): Provider {
  const opened = resolveConversation(reference, environment);
  if (!opened.ok) throw new ResolutionError(opened.failure);
  const provider = open(opened.binding);
  const current = async (): Promise<ResolvedConversation> => {
    await ask(opened.binding, need);
    const resolved = resolveConversation(reference, environment);
    if (!resolved.ok) throw new ResolutionError(resolved.failure);
    return resolved;
  };
  const conversation: Provider = {
    name: provider.name,
    modelId: provider.modelId,
    capabilities: provider.capabilities,
    requestSupport: provider.requestSupport,
    async *stream(request) {
      const resolved = await current();
      if (resolved.mode === "tools") {
        yield* provider.stream(request);
        return;
      }
      yield* chatOnly(provider, request, chatDetail(reference, resolved.capabilities));
    },
  };
  modes.set(conversation, async () => (await current()).mode);
  return conversation;
}

export async function requireProjectModel(provider: Provider): Promise<void> {
  if ((await modes.get(provider)?.()) === "chat") {
    throw new Error(
      "This model is ready for conversation only. Choose a model with tool support and enough context before assigning project work.",
    );
  }
}

const modes = new WeakMap<Provider, () => Promise<"chat" | "tools">>();

const noToolsNow =
  "You have no tools in this conversation: you can talk, explain and plan, but you cannot read or change files or run anything. When the keeper asks for work that needs a tool, say so plainly, and never claim to have done it.";

type ResolvedConversation = {
  ok: true;
  binding: InferenceBinding;
  capabilities: CapabilityRecord;
  mode: "chat" | "tools";
  projectCheck?: ToolCheck;
};

type ConversationResolution = ResolvedConversation | { ok: false; failure: ResolutionFailure };

function resolveConversation(
  reference: ModelReference,
  environment: PolicyEnvironment,
): ConversationResolution {
  const bound = bindForClass(reference, "strong", environment.registrations);
  if (!bound.ok) return bound;
  const { binding } = bound;
  const capabilities = bindingCapabilities(binding, environment);
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
  if (strong.ok) return { ok: true, binding, capabilities, mode: "tools" };
  if (strong.failure.code !== "missing-capability") return { ok: false, failure: strong.failure };
  if (strong.failure.capability === "contextAllocated") {
    return { ok: true, binding, capabilities, mode: "tools" };
  }
  if (strong.failure.capability !== "tools") return { ok: false, failure: strong.failure };
  const projectCheck = projectCheckFor(binding, capabilities);
  return {
    ok: true,
    binding,
    capabilities,
    mode: "chat",
    ...(projectCheck !== undefined && { projectCheck }),
  };
}

function chatDetail(reference: ModelReference, capabilities: CapabilityRecord): string {
  return `${formatReference(reference)} ${whyNoTools(capabilities)}, so it can talk but cannot use tools.`;
}

function whyNoTools({ tools }: CapabilityRecord): string {
  if (!tools.known) return "could not be asked whether it calls tools";
  switch (tools.evidence.source) {
    case "behaviour-probe":
      return "answered without calling a tool when it was asked to";
    case "rejected-field":
      return `refused a request that offered it tools (${tools.evidence.status})`;
    case "declared":
      return "is declared without tool calls in keywork.json";
    default:
      return "reports that it does not call tools";
  }
}

async function* chatOnly(
  provider: Provider,
  request: ProviderRequest,
  detail: string,
): AsyncGenerator<TurnDelta> {
  for await (const delta of provider.stream({
    ...request,
    systemPrompt: chatPrompt(request.systemPrompt, detail),
    tools: [],
    toolAdditions: [],
  })) {
    if (delta.type === "tool-call") {
      throw new Error("This model is connected for conversation only; tool calls are disabled.");
    }
    yield delta;
  }
}

function chatPrompt(systemPrompt: string, detail: string): string {
  const kept = systemPrompt
    .split("\n\n")
    .filter((paragraph) => !namesTools(paragraph))
    .map(withoutPanes);
  return [...kept, `${detail} ${noToolsNow}`].join("\n\n");
}

const yardParagraphs = new Set(yardPrompt.split("\n\n"));

function namesTools(paragraph: string): boolean {
  return (
    paragraph === toolGuidance ||
    paragraph === workingManner ||
    yardParagraphs.has(paragraph) ||
    namesItsTools(paragraph) ||
    paragraph.startsWith(workshopLineOpening)
  );
}

function projectCheckFor(
  binding: InferenceBinding,
  capabilities: CapabilityRecord,
): ToolCheck | undefined {
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
