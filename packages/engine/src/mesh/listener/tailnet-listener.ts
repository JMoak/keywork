import type { Server } from "node:http";
import type { Tailnet } from "../transport/tailnet.ts";
import { type Admission, type DenyReason, identifyCaller, type MeshCaller } from "./admission.ts";
import {
  assertTailnetBindable,
  type IdleReason,
  listenOnTailnet,
  localInterfaceAddresses,
  planBinds,
} from "./bind.ts";
import { createMeshServer, type MeshHandler } from "./mesh-server.ts";
import { defaultMeshPort } from "./ports.ts";
import { assertFunnelOff, serveVersionWarning } from "./serve-posture.ts";

export interface TailnetListenerOptions {
  tailnet: Tailnet;
  handle: MeshHandler;
  port?: number | undefined;
  pollMs?: number | undefined;
  maxBodyBytes?: number | undefined;
  localAddresses?: (() => readonly string[]) | undefined;
  listen?: TailnetBinder | undefined;
  onEvent?: ((event: MeshListenerEvent) => void) | undefined;
}

export type TailnetBinder = (server: Server, address: string, port: number) => Promise<number>;

export interface TailnetListener {
  bound(): BoundAddress[];
  refresh(): Promise<void>;
  close(): Promise<void>;
}

export interface BoundAddress {
  address: string;
  port: number;
}

export type ListenerIdleReason = IdleReason | "funnel-enabled";
export type UnbindReason = ListenerIdleReason | "address-gone" | "closed";

export type MeshListenerEvent =
  | { type: "mesh.listener.bound"; address: string; port: number }
  | { type: "mesh.listener.unbound"; address: string; reason: UnbindReason }
  | { type: "mesh.listener.bind-failed"; address: string; error: string }
  | { type: "mesh.listener.idle"; reason: ListenerIdleReason }
  | { type: "mesh.listener.status-failed"; error: string }
  | { type: "mesh.listener.serve-warning"; message: string }
  | { type: "mesh.caller.admitted"; caller: MeshCaller }
  | { type: "mesh.caller.denied"; address: string; reason: DenyReason; detail: string };

export const defaultPollMs = 5_000;

export async function startTailnetListener(
  options: TailnetListenerOptions,
): Promise<TailnetListener> {
  const startup = await observeServe(options.tailnet);
  if ("posture" in startup) assertFunnelOff(startup.posture);
  else options.onEvent?.({ type: "mesh.listener.status-failed", error: startup.error });
  const listener = tailnetListener(options);
  await listener.refresh();
  const pollMs = options.pollMs ?? defaultPollMs;
  const timer = pollMs > 0 ? setInterval(() => void listener.refresh(), pollMs) : null;
  timer?.unref();
  return {
    bound: listener.bound,
    refresh: listener.refresh,
    close: async () => {
      if (timer !== null) clearInterval(timer);
      await listener.close();
    },
  };
}

interface BoundServer {
  server: Server;
  port: number;
}

function tailnetListener(options: TailnetListenerOptions): TailnetListener {
  const { tailnet } = options;
  const emit = (event: MeshListenerEvent) => options.onEvent?.(event);
  const listen = options.listen ?? listenOnTailnet;
  const localAddresses = options.localAddresses ?? localInterfaceAddresses;
  const servers = new Map<string, BoundServer>();
  let idle: ListenerIdleReason | null = null;
  let warned: string | null = null;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();

  const settleIdle = (next: ListenerIdleReason | null) => {
    if (next !== null && next !== idle) emit({ type: "mesh.listener.idle", reason: next });
    idle = next;
  };

  const warnOnce = (message: string | null) => {
    if (message !== null && message !== warned) {
      emit({ type: "mesh.listener.serve-warning", message });
    }
    warned = message;
  };

  const bind = async (address: string) => {
    const server = createMeshServer({
      identify: (remoteAddress) => identifyCaller(tailnet, remoteAddress),
      handle: options.handle,
      onAdmission: (admission) => emit(admissionEvent(admission)),
      maxBodyBytes: options.maxBodyBytes,
    });
    try {
      assertTailnetBindable(address);
      const port = await listen(server, address, options.port ?? defaultMeshPort);
      servers.set(address, { server, port });
      emit({ type: "mesh.listener.bound", address, port });
    } catch (cause) {
      server.close();
      emit({ type: "mesh.listener.bind-failed", address, error: messageOf(cause) });
    }
  };

  const unbind = async (address: string, reason: UnbindReason) => {
    const bound = servers.get(address);
    if (bound === undefined) return;
    servers.delete(address);
    await closeServer(bound.server);
    emit({ type: "mesh.listener.unbound", address, reason });
  };

  const unbindAll = async (reason: UnbindReason) => {
    for (const address of [...servers.keys()]) await unbind(address, reason);
  };

  const reconcile = async () => {
    if (closed) return;
    const observed = await observe(tailnet);
    if ("error" in observed) {
      emit({ type: "mesh.listener.status-failed", error: observed.error });
      return;
    }
    const { status, posture } = observed;
    if (posture.funnel.length > 0) {
      await unbindAll("funnel-enabled");
      settleIdle("funnel-enabled");
      return;
    }
    warnOnce(serveVersionWarning(status.version, posture));
    const plan = planBinds(status, localAddresses());
    for (const address of [...servers.keys()]) {
      if (!plan.addresses.includes(address)) await unbind(address, plan.idle ?? "address-gone");
    }
    for (const address of plan.addresses) {
      if (!servers.has(address)) await bind(address);
    }
    settleIdle(plan.idle);
  };

  return {
    bound: () => [...servers].map(([address, { port }]) => ({ address, port })),
    refresh: () => {
      queue = queue.then(reconcile).catch((cause: unknown) => {
        emit({ type: "mesh.listener.status-failed", error: messageOf(cause) });
      });
      return queue;
    },
    close: async () => {
      closed = true;
      await queue;
      await unbindAll("closed");
    },
  };
}

async function observeServe(tailnet: Tailnet) {
  try {
    return { posture: await tailnet.serve() };
  } catch (cause) {
    return { error: messageOf(cause) };
  }
}

async function observe(tailnet: Tailnet) {
  try {
    const [status, posture] = await Promise.all([tailnet.status(), tailnet.serve()]);
    return { status, posture };
  } catch (cause) {
    return { error: messageOf(cause) };
  }
}

function admissionEvent(admission: Admission): MeshListenerEvent {
  if (admission.admitted) return { type: "mesh.caller.admitted", caller: admission.caller };
  const { address, reason, detail } = admission;
  return { type: "mesh.caller.denied", address, reason, detail };
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
