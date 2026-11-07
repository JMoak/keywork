import { serverRootOf } from "../adapters/http.ts";
import type { CapabilityCache } from "../capabilities/cache.ts";
import type { PolicyEnvironment } from "./resolve.ts";

export type CapabilityLookup = NonNullable<PolicyEnvironment["capabilityOf"]>;

export function probedCapabilities(cache: Pick<CapabilityCache, "record">): CapabilityLookup {
  return (binding) =>
    cache.record(serverRootOf(binding.registration.endpoint), binding.reference.model);
}
