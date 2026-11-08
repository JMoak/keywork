import { type Clock, SettingStore } from "@keywork/engine";
import { type BusEnvelope, type EventLog, recordedShowEvents } from "@keywork/server";

export interface ServedSettings {
  settings: SettingStore;
  close(): void;
}

export function servedSettings(
  log: Pick<EventLog, "record" | "subscribe">,
  clock?: Clock,
): ServedSettings {
  const settings = new SettingStore({ emit: recordedShowEvents(log), clock });
  const unfollow = log.subscribe((envelope) => {
    const removed = removedSessionOf(envelope);
    if (removed !== undefined) settings.removed(removed);
  });
  return {
    settings,
    close: () => {
      unfollow();
      settings.close();
    },
  };
}

function removedSessionOf(envelope: BusEnvelope): string | undefined {
  if (envelope.type !== "session.removed") return undefined;
  const { sessionId } = envelope.payload as { sessionId: string };
  return sessionId;
}
