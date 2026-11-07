import type { AwakeWhileLive } from "./activity.ts";
import { type ReconcilePorts, reconcileLines, reconcileOnStart } from "./reconcile.ts";

export interface MeshHandle {
  bound(): readonly { address: string; port: number }[];
  close(): Promise<void>;
}

export interface CoreServices {
  reconcile: ReconcilePorts;
  mesh?: (() => Promise<MeshHandle>) | undefined;
  activity: Pick<AwakeWhileLive, "start" | "stop">;
  close?: (() => Promise<void>) | undefined;
}

export interface CoreOptions {
  services: CoreServices;
  signal: AbortSignal;
  say: (line: string) => void;
}

export async function runNodeCore(options: CoreOptions): Promise<number> {
  const { services, say } = options;
  say("node core: starting");
  const mesh = await openMesh(services.mesh, say);
  for (const line of reconcileLines(await reconcileOnStart(services.reconcile))) say(line);
  services.activity.start();
  say("node core: running");
  await untilAborted(options.signal);
  services.activity.stop();
  await mesh?.close();
  await services.close?.();
  say("node core: stopped");
  return 0;
}

async function openMesh(
  open: (() => Promise<MeshHandle>) | undefined,
  say: (line: string) => void,
): Promise<MeshHandle | undefined> {
  if (open === undefined) {
    say("mesh: the tailnet listener is off in the node config");
    return undefined;
  }
  try {
    const mesh = await open();
    const bound = mesh.bound().map(endpointText);
    say(
      bound.length === 0
        ? "mesh: listener waiting for Tailscale to be running"
        : `mesh: listening on ${bound.join(", ")}`,
    );
    return mesh;
  } catch (cause) {
    say(
      `mesh: the tailnet listener did not start: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return undefined;
  }
}

function endpointText(entry: { address: string; port: number }): string {
  return entry.address.includes(":")
    ? `[${entry.address}]:${entry.port}`
    : `${entry.address}:${entry.port}`;
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}
