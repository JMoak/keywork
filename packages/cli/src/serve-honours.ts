import type { CreatureHonours, HonouredWork } from "@keywork/engine";
import type { EventLog, WirePayload } from "@keywork/server";
import type { WorksiteSessionFacts } from "./serve-worksites.ts";

export function followHonours(
  log: Pick<EventLog, "subscribe">,
  honours: Pick<CreatureHonours, "began" | "finished" | "used">,
  sessionOf: (id: string) => WorksiteSessionFacts | undefined,
): () => void {
  const underway = new Map<string, string>();
  return log.subscribe(({ sessionId, type, payload, ts }) => {
    if (replayed(payload)) return;
    switch (type) {
      case "turn.started": {
        const facts = sessionOf(sessionId);
        if (facts !== undefined) honours.began(workOf(sessionId, facts), ts);
        return;
      }
      case "turn.completed": {
        const facts = sessionOf(sessionId);
        if (facts !== undefined) honours.finished(workOf(sessionId, facts), ts);
        return;
      }
      case "tool.started": {
        const { call } = payload as WirePayload<"tool.started">;
        if (sessionOf(sessionId) !== undefined)
          underway.set(callKeyOf(sessionId, call.callId), call.name);
        return;
      }
      case "tool.finished": {
        const { callId, isError } = payload as WirePayload<"tool.finished">;
        const key = callKeyOf(sessionId, callId);
        const tool = underway.get(key);
        underway.delete(key);
        const facts = tool === undefined || isError ? undefined : sessionOf(sessionId);
        if (tool !== undefined && facts !== undefined)
          honours.used(workOf(sessionId, facts), tool, ts);
        return;
      }
    }
  });
}

function workOf(sessionId: string, facts: WorksiteSessionFacts): HonouredWork {
  return {
    creature: facts.creature,
    conversation: facts.parent ?? sessionId,
    ...(facts.visitor !== undefined && { visitor: facts.visitor }),
  };
}

function callKeyOf(sessionId: string, callId: string): string {
  return `${sessionId} ${callId}`;
}

function replayed(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { replay?: unknown }).replay === true
  );
}
