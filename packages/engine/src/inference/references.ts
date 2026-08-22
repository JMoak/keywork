import type { ModelReference } from "./types.ts";

export function formatReference(reference: ModelReference): string {
  return `${reference.provider}/${reference.model}`;
}

export function parseReference(text: string): ModelReference | undefined {
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) return undefined;
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
}

export function sameReference(left: ModelReference, right: ModelReference): boolean {
  return left.provider === right.provider && left.model === right.model;
}

export function isLoopbackEndpoint(endpoint: string): boolean {
  const host = hostOf(endpoint);
  return host !== undefined && loopbackHost(host);
}

export function endpointScheme(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).protocol.replace(/:$/, "");
  } catch {
    return undefined;
  }
}

function hostOf(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return undefined;
  }
}

function loopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  return (
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    bare === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(bare)
  );
}
