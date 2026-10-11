import type { FlavorsPort } from "../host.ts";
import { servedBy } from "./answers.ts";
import { json, type RouteFamily, type RouteSpec } from "./family.ts";

export const flavorRoutes = [
  {
    method: "GET",
    path: "/flavors",
    operationId: "listFlavors",
    summary:
      "The colour flavors this installation knows, each a complete palette (`tokens`: ground, panel, text inks, accent ramp, outcome colours), its `appearance` (`dark` or `light`), how density maps onto inks and its chrome taste (`gap`, `chromeWeight`, `instruments`), as validated records a client can paint from directly. `keywork-night` is always present and the user's `theme` overrides are already laid over the flavor they wear. `active` is the configured flavor name; the terminal-derived `system` flavor is never listed because it is read from the terminal's own colours, so a client whose `active` is `system` derives its palette from its host instead.",
    authenticated: true,
    responses: { "200": "The flavors.", "503": "This host serves no flavors." },
  },
] as const satisfies readonly RouteSpec[];

export const flavorFamily = {
  routes: flavorRoutes,
  handlers: ({ host }) => {
    const flavors = servedBy((): FlavorsPort | undefined => host.flavors, "flavors");
    return { listFlavors: flavors(async (port) => json(200, await port.list())) };
  },
} satisfies RouteFamily<typeof flavorRoutes>;
