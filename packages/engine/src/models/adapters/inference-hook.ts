import type { ModelCapabilities } from "../../capabilities.ts";
import type { InferenceBinding, ProviderRegistration } from "../../inference/types.ts";
import { isTailnetAddress } from "../../mesh/transport/tailnet-address.ts";
import type { Provider } from "../../provider.ts";
import type { AuthHeaders, FetchLike } from "../../providers/transport.ts";
import type { CapabilityRecord, ServerKind } from "../capabilities/types.ts";
import { joinUrl, serverRootOf } from "./http.ts";
import { adapterFor } from "./registry.ts";
import type { FieldMemory, ServerInventory, TurnUsageReport } from "./types.ts";

export interface LocalServerDirectory {
  kindOf(root: string): ServerKind | undefined;
  record(root: string, model: string): CapabilityRecord | undefined;
  fieldMemory(root: string, model: string): FieldMemory;
}

export interface LocalServerProviderOptions {
  directory: LocalServerDirectory;
  authHeaders?: AuthHeaders | undefined;
  fetchFn?: FetchLike | undefined;
  onUsage?: ((binding: InferenceBinding, report: TurnUsageReport) => void) | undefined;
}

export function localServerProvider(
  binding: InferenceBinding,
  options: LocalServerProviderOptions,
): Provider | undefined {
  if (binding.protocol !== "chat-completions") return undefined;
  const root = serverRootOf(binding.registration.endpoint);
  const kind = options.directory.kindOf(root);
  const adapter = kind === undefined ? undefined : adapterFor(kind);
  if (adapter === undefined) return undefined;
  const model = binding.reference.model;
  const replay = options.directory.record(root, model)?.reasoningReplay;
  return adapter.chat({
    name: binding.registration.name,
    root,
    model,
    authHeaders: options.authHeaders,
    fetchFn: options.fetchFn,
    replayReasoning: replay?.known === true && replay.value,
    fieldMemory: options.directory.fieldMemory(root, model),
    onUsage: (report) => options.onUsage?.(binding, report),
  });
}

export function registrationFor(
  name: string,
  root: string,
  inventory: ServerInventory,
  records: readonly CapabilityRecord[],
): ProviderRegistration {
  return {
    name,
    protocol: "chat-completions",
    endpoint: joinUrl(root, "/v1"),
    credential: { kind: "none" },
    models: inventory.installed.map((installed) => ({
      id: installed.id,
      origin: "reported",
      capabilities: capabilitiesOf(records.find((record) => record.model === installed.id)),
    })),
    openCatalog: false,
    enabled: true,
    insecureTransport: isTailnetEndpoint(root),
  };
}

export function isTailnetEndpoint(endpoint: string): boolean {
  const host = hostnameOf(endpoint);
  return host !== undefined && (host.endsWith(".ts.net") || isTailnetAddress(host));
}

function capabilitiesOf(record: CapabilityRecord | undefined): ModelCapabilities {
  if (record === undefined) return { input: ["text"], toolCalls: false };
  const images = record.imageInput.known && record.imageInput.value !== "none";
  return {
    input: images ? ["text", "image"] : ["text"],
    toolCalls: record.tools.known && record.tools.value,
    ...(record.contextAllocated.known && { contextWindow: record.contextAllocated.value }),
  };
}

function hostnameOf(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}
