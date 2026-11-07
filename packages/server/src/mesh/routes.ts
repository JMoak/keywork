import { json } from "../routes/family.ts";
import {
  type MeshCaller,
  type MeshHello,
  meshHelloPath,
  meshManifestPath,
  type NodeManifest,
} from "./engine-mesh.ts";
import type { MeshRoute } from "./router.ts";

export const meshScreenSignalPath = "/mesh/screen/signal";

export type ManifestReader = (caller: MeshCaller) => boolean | Promise<boolean>;

export function helloRoute(hello: () => MeshHello): MeshRoute {
  return {
    method: "GET",
    path: meshHelloPath,
    handle: async () => json(200, hello()),
  };
}

export function manifestRoute(
  manifest: () => Promise<NodeManifest>,
  mayRead: ManifestReader,
): MeshRoute {
  return {
    method: "GET",
    path: meshManifestPath,
    handle: async (_request, caller) =>
      (await mayRead(caller)) ? json(200, await manifest()) : json(403, { error: "mesh.unpaired" }),
  };
}

export const unpairedReadsNothing: ManifestReader = () => false;
