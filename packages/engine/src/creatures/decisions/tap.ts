import type { EngineEvents, EventBus } from "../../bus.ts";
import type { PermissionAsk } from "../../session/journal.ts";
import { type AnsweredAsk, isKeeperVerdict, type KeeperOutcome } from "./record.ts";
import type { KeeperContext } from "./state.ts";

export interface KeeperTapOptions {
  session: () => string;
  context: () => KeeperContext;
  record: (answered: AnsweredAsk) => Promise<KeeperOutcome>;
  cwd?: string | undefined;
  now?: (() => Date) | undefined;
}

export interface KeeperTap {
  flush(): Promise<void>;
  stop(): void;
}

export function tapKeeperVerdicts(
  bus: EventBus<EngineEvents>,
  options: KeeperTapOptions,
): KeeperTap {
  const asked = new Map<string, PermissionAsk>();
  const now = options.now ?? (() => new Date());
  let pending: Promise<unknown> = Promise.resolve();
  const stops = [
    bus.on("gate.ask", ({ ask }) => {
      asked.set(ask.callId, ask);
    }),
    bus.on("gate.permission", ({ decision, replay }) => {
      const ask = asked.get(decision.callId);
      asked.delete(decision.callId);
      if (replay === true || ask === undefined || !isKeeperVerdict(decision)) return;
      const answered: AnsweredAsk = {
        ask,
        decision,
        session: options.session(),
        context: options.context(),
        answeredAt: now().toISOString(),
        cwd: options.cwd,
      };
      pending = pending.then(() => options.record(answered)).catch(() => undefined);
    }),
  ];
  return {
    flush: async () => {
      await pending;
    },
    stop: () => {
      for (const stop of stops) stop();
    },
  };
}
