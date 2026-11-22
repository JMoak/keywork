import type { Arrangement } from "./arrangement.ts";
import type { Placement, PlacementsReport } from "./placements.ts";
import type { Seat } from "./seat.ts";
import type { Setting, ShowEventSink, ShowEventType } from "./setting.ts";
import type { SettingStore } from "./store.ts";

export interface AnsweringConsole {
  emit: ShowEventSink;
  events: { sessionId: string; type: ShowEventType }[];
  answerTo(settings: Pick<SettingStore, "placed">): void;
  keeperMoves(sessionId: string, id: string, seat: Seat): Promise<void>;
}

export function answeringConsole(): AnsweringConsole {
  const events: AnsweringConsole["events"] = [];
  const standing = new Map<string, Placement>();
  let settings: Pick<SettingStore, "placed"> | undefined;
  const reportOf = (arrangement?: PlacementsReport["arrangement"]): PlacementsReport => ({
    stage: { room: "beside", cardsAcross: 4, cardsDown: 3, consoleMaximised: false },
    placements: [...standing.values()],
    ...(arrangement !== undefined && { arrangement }),
  });
  const soon = (sessionId: string, arrangement?: PlacementsReport["arrangement"]) =>
    setTimeout(() => void settings?.placed(sessionId, reportOf(arrangement)), 0);
  const proposed = (sessionId: string, setting: Setting) => {
    if (setting.where !== "outside") return;
    standing.set(setting.id, seated(setting.id, setting.seat ?? rightHalf));
    soon(sessionId);
  };
  const arranged = (sessionId: string, { id, panes, seats }: Arrangement) => {
    for (const pane of panes) {
      const composed = seats?.find((seat) => seat.id === pane)?.seat;
      standing.set(pane, seated(pane, composed ?? standing.get(pane)?.seat ?? rightHalf));
    }
    soon(sessionId, { id, said: `${panes.length} panes now stand beside the console.` });
  };
  return {
    events,
    answerTo: (store) => {
      settings = store;
    },
    keeperMoves: async (sessionId, id, seat) => {
      standing.set(id, { id, where: "outside", seat, by: "keeper" });
      await settings?.placed(sessionId, reportOf());
    },
    emit: (sessionId, type, payload) => {
      events.push({ sessionId, type });
      const heard = payload as { setting?: Setting; arrangement?: Arrangement; id?: string };
      if (type === "show.proposed" && heard.setting !== undefined)
        proposed(sessionId, heard.setting);
      if (type === "show.arranged" && heard.arrangement !== undefined)
        arranged(sessionId, heard.arrangement);
      if (type === "show.settled" && heard.id !== undefined && standing.delete(heard.id))
        soon(sessionId);
    },
  };
}

const rightHalf: Seat = { x: 6, y: 0, w: 6, h: 12 };

function seated(id: string, seat: Seat): Placement {
  return { id, where: "outside", seat, by: "creature" };
}
