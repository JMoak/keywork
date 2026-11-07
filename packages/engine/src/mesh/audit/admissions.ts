import type { MeshCaller } from "../listener/admission.ts";
import type { MeshListenerEvent } from "../listener/tailnet-listener.ts";
import type { AuditActor, AuditLog } from "./log.ts";

export const unidentifiedActor = "unidentified";

export function auditDeniedCallers(
  audit: AuditLog,
  self: () => string,
  onFailure: (error: unknown) => void,
): (event: MeshListenerEvent) => void {
  return (event) => {
    if (event.type !== "mesh.caller.denied") return;
    void audit
      .append({
        actor: { stableId: unidentifiedActor, userId: null, tags: [] },
        target: self(),
        capability: "connect",
        request: { address: event.address },
        decision: "deny",
        reason: `${event.reason}: ${event.detail}`,
      })
      .catch(onFailure);
  };
}

export function actorOf(caller: MeshCaller): AuditActor {
  return {
    stableId: caller.node.stableId,
    userId: caller.human?.userId ?? null,
    tags: caller.node.tags,
  };
}
