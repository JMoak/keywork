import { joinUrl } from "../http.ts";
import { arrayAt, numberAt } from "../json.ts";
import type { ServerProbe } from "../types.ts";
import { sameModel } from "./names.ts";

export type ContextCheck =
  | { kind: "ok"; allocated: number }
  | { kind: "short"; allocated: number; floor: number; remedy: ContextVariant }
  | { kind: "not-loaded"; remedy: ContextVariant };

export interface ContextVariant {
  name: string;
  request: { model: string; from: string; parameters: { num_ctx: number } };
}

export async function verifyContext(
  probe: ServerProbe,
  model: string,
  floor: number,
): Promise<ContextCheck> {
  const running = await probe.http.get(joinUrl(probe.root, "/api/ps"));
  const entry = arrayAt(running.body, "models").find((loaded) => sameModel(loaded, model));
  const allocated = numberAt(entry, "context_length");
  const remedy = contextVariant(model, floor);
  if (allocated === undefined) return { kind: "not-loaded", remedy };
  if (allocated >= floor) return { kind: "ok", allocated };
  return { kind: "short", allocated, floor, remedy };
}

export function contextVariant(model: string, numCtx: number): ContextVariant {
  const [name, tag = "latest"] = model.split(":");
  const variant = `${name}:${tag}-ctx${Math.round(numCtx / 1024)}k`;
  return {
    name: variant,
    request: { model: variant, from: model, parameters: { num_ctx: numCtx } },
  };
}

export async function createContextVariant(
  probe: ServerProbe,
  variant: ContextVariant,
): Promise<void> {
  const reply = await probe.http.post(joinUrl(probe.root, "/api/create"), {
    ...variant.request,
    stream: false,
  });
  if (!reply.ok) {
    throw new Error(`ollama refused to create ${variant.name} (${reply.status}): ${reply.text}`);
  }
}

export async function pinResident(probe: ServerProbe, model: string): Promise<void> {
  const reply = await probe.http.post(joinUrl(probe.root, "/api/generate"), {
    model,
    keep_alive: -1,
  });
  if (!reply.ok) {
    throw new Error(`ollama refused to pin ${model} (${reply.status}): ${reply.text}`);
  }
}
