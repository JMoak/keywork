import type { Provider, ProviderRequest } from "./provider.ts";

export type InputModality = "text" | "image";

export interface ModelCapabilities {
  input: readonly InputModality[];
  toolCalls: boolean;
  contextWindow?: number;
}

export interface ModelCapabilityDeclaration {
  input?: readonly InputModality[] | undefined;
  toolCalls?: boolean | undefined;
  contextWindow?: number | undefined;
}

export const undeclaredCapabilities: ModelCapabilities = { input: ["text"], toolCalls: true };

export class UndeclaredCapabilityError extends Error {
  constructor(
    readonly declaration: string,
    message: string,
  ) {
    super(message);
    this.name = "UndeclaredCapabilityError";
  }
}

export function declaredCapabilitiesFor(
  declarations: Readonly<Record<string, ModelCapabilityDeclaration>> | undefined,
  modelId: string | undefined,
): ModelCapabilities {
  const declared = mostSpecificDeclaration(declarations, modelId);
  return declared === undefined
    ? undeclaredCapabilities
    : {
        input: declared.input ?? undeclaredCapabilities.input,
        toolCalls: declared.toolCalls ?? undeclaredCapabilities.toolCalls,
        ...(declared.contextWindow !== undefined && { contextWindow: declared.contextWindow }),
      };
}

export function withDeclaredCapabilities(
  provider: Provider,
  capabilities: ModelCapabilities = undeclaredCapabilities,
): Provider {
  return {
    name: provider.name,
    modelId: provider.modelId,
    capabilities,
    stream: (request) => {
      assertRequestWithinDeclarations(request, capabilities, provider.modelId ?? provider.name);
      return provider.stream(request);
    },
  };
}

function assertRequestWithinDeclarations(
  request: ProviderRequest,
  capabilities: ModelCapabilities,
  modelId: string,
): void {
  if (requestCarriesImages(request) && !capabilities.input.includes("image")) {
    throw new UndeclaredCapabilityError(
      `models["${modelId}"].input`,
      `model "${modelId}" is declared text-only; add "image" to models["${modelId}"].input in keywork.json before sending images`,
    );
  }
  if (request.tools.length > 0 && !capabilities.toolCalls) {
    throw new UndeclaredCapabilityError(
      `models["${modelId}"].toolCalls`,
      `model "${modelId}" is declared without tool-call support; set models["${modelId}"].toolCalls to true in keywork.json before mounting tools`,
    );
  }
}

function requestCarriesImages(request: ProviderRequest): boolean {
  return request.messages.some((message) => message.parts.some((part) => part.type === "image"));
}

function mostSpecificDeclaration(
  declarations: Readonly<Record<string, ModelCapabilityDeclaration>> | undefined,
  modelId: string | undefined,
): ModelCapabilityDeclaration | undefined {
  if (declarations === undefined || modelId === undefined) return undefined;
  return Object.entries(declarations)
    .filter(([pattern]) => globMatches(pattern, modelId))
    .sort(([a], [b]) => literalLength(b) - literalLength(a))[0]?.[1];
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[/\\^$+?.()|[\]{}]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function literalLength(pattern: string): number {
  return pattern.replaceAll("*", "").length;
}
