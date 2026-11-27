import { connectionNamePattern } from "@keywork/shared";
import { isTailnetAddress } from "../mesh/transport/tailnet-address.ts";
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

export function connectionDraftProblem(draft: {
  name: string;
  endpoint: string;
  credential: string;
  insecureTransport: boolean;
}): string | undefined {
  const name = draft.name.trim();
  if (name === "") return "a connection needs a name";
  if (!connectionNamePattern.test(name)) return "names are lowercase letters, digits, . _ -";
  const endpoint = draft.endpoint.trim();
  const scheme = endpointScheme(endpoint);
  if ((scheme !== "http" && scheme !== "https") || !/^https?:\/\/\S+$/i.test(endpoint))
    return "endpoint must be an http(s) URL";
  if (draft.credential === "env:") return "name the environment variable";
  if (scheme === "http" && !isPrivateEndpoint(endpoint) && !draft.insecureTransport)
    return plainHttpRefusal;
  return undefined;
}

export const plainHttpRefusal = "plain http off loopback is refused until you allow it";

export function isTailnetEndpoint(endpoint: string): boolean {
  const host = hostOf(endpoint)
    ?.replace(/^\[|\]$/g, "")
    .toLowerCase();
  return host !== undefined && (host.endsWith(".ts.net") || isTailnetAddress(host));
}

export function isPrivateEndpoint(endpoint: string): boolean {
  return isLoopbackEndpoint(endpoint) || isTailnetEndpoint(endpoint);
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
