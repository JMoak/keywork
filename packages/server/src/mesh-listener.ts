import {
  buildManifest,
  createTailnet,
  defaultTransport,
  type ManifestSources,
  type MeshListenerEvent,
  meshHello,
  type NodeCapability,
  type NodeManifest,
  type NodeRole,
  type PairingState,
  startTailnetListener,
  type Tailnet,
  type TailnetBinder,
  type TailnetListener,
} from "./mesh/engine-mesh.ts";
import { type MeshRoute, meshRouter } from "./mesh/router.ts";
import {
  helloRoute,
  type ManifestReader,
  manifestRoute,
  unpairedReadsNothing,
} from "./mesh/routes.ts";

export interface MeshListenerOptions {
  version: string;
  tailnet?: Tailnet | undefined;
  port?: number | undefined;
  pollMs?: number | undefined;
  pairing?: (() => PairingState) | undefined;
  roles?: readonly NodeRole[] | undefined;
  capabilities?: readonly NodeCapability[] | undefined;
  manifest?: (() => Promise<NodeManifest>) | undefined;
  inventory?: ManifestInventory | undefined;
  mayReadManifest?: ManifestReader | undefined;
  routes?: readonly MeshRoute[] | undefined;
  onEvent?: ((event: MeshListenerEvent) => void) | undefined;
  listen?: TailnetBinder | undefined;
  localAddresses?: (() => readonly string[]) | undefined;
}

export type ManifestInventory = Pick<ManifestSources, "substrates" | "gpus" | "modelServers">;

export const defaultNodeRoles: readonly NodeRole[] = ["reachable"];

export async function registerMeshListener(options: MeshListenerOptions): Promise<TailnetListener> {
  const tailnet = options.tailnet ?? createTailnet(defaultTransport());
  return startTailnetListener({
    tailnet,
    handle: meshRouter(meshRoutes(options, tailnet)),
    port: options.port,
    pollMs: options.pollMs,
    onEvent: options.onEvent,
    listen: options.listen,
    localAddresses: options.localAddresses,
  });
}

export function meshRoutes(options: MeshListenerOptions, tailnet: Tailnet): MeshRoute[] {
  const pairing = options.pairing ?? (() => "unclaimed" as const);
  const manifest =
    options.manifest ??
    (async () =>
      buildManifest({
        ...options.inventory,
        version: options.version,
        roles: options.roles ?? defaultNodeRoles,
        capabilities: options.capabilities ?? [],
        status: await tailnet.status(),
      }));
  return [
    helloRoute(() => meshHello(options.version, pairing())),
    manifestRoute(manifest, options.mayReadManifest ?? unpairedReadsNothing),
    ...(options.routes ?? []),
  ];
}
