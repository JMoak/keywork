import type { ServePosture } from "../transport/serve-config.ts";

export const minimumServeVersion = "1.104.4";

export class FunnelEnabledError extends Error {
  override readonly name = "FunnelEnabledError";

  constructor(readonly funnel: readonly string[]) {
    super(
      `Tailscale Funnel is on for ${funnel.join(", ")}; the mesh listener refuses to run while ` +
        "anything on this node is public. Turn it off with `tailscale funnel reset`.",
    );
  }
}

export function assertFunnelOff(posture: ServePosture): void {
  if (posture.funnel.length > 0) throw new FunnelEnabledError(posture.funnel);
}

export function serveVersionWarning(version: string, posture: ServePosture): string | null {
  if (!posture.serving || !olderThan(version, minimumServeVersion)) return null;
  return (
    `Tailscale ${releaseOf(version)} runs Serve on this node without the Serve security ` +
    `fixes released in ${minimumServeVersion}; update Tailscale.`
  );
}

function olderThan(version: string, minimum: string): boolean {
  const have = numbersOf(version);
  const need = numbersOf(minimum);
  for (let index = 0; index < need.length; index += 1) {
    const difference = (have[index] ?? 0) - (need[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

function releaseOf(version: string): string {
  return version.split("-")[0] ?? version;
}

function numbersOf(version: string): number[] {
  return releaseOf(version)
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isNaN(part) ? 0 : part));
}
