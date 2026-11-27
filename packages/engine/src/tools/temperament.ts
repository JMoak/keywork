import type { ToolFact } from "../messages.ts";
import type { Mood } from "../show/setting.ts";
import { moodWords } from "../show/vocabularies.ts";
import { listed } from "../show/words.ts";

export interface Temperaments {
  favourite: Mood;
  range: readonly Mood[];
  manner: Mood;
}

export interface TemperamentSeat {
  read(): Promise<Temperaments | undefined>;
  take(temperament: Mood): Promise<Temperaments | undefined>;
}

export async function temperamentTakenWords(
  seat: TemperamentSeat | undefined,
  said: string,
  told?: (fact: ToolFact) => void,
): Promise<string> {
  const own = await seat?.read();
  if (seat === undefined || own === undefined) return noTemperament;
  const asked = moodWords.understood(said);
  if (asked === undefined || !own.range.includes(asked))
    return refusedWords(asked ?? JSON.stringify(said.trim().slice(0, 40)), asked, own.range);
  const taken = await seat.take(asked);
  if (taken === undefined) return noTemperament;
  told?.({ kind: "temperament", manner: taken.manner, favourite: taken.favourite });
  return taken.manner === taken.favourite
    ? `You are ${taken.favourite}, your favourite.`
    : `You are ${taken.manner} now, and settle back to ${taken.favourite} by yourself once you have rested a while.`;
}

export const temperamentAlone =
  "Not arranged: temperament goes alone; ask for it in a call of its own.";

const noTemperament = "Not changed: only a creature has a temperament, and you are not one here.";

function refusedWords(named: string, asked: Mood | undefined, range: readonly Mood[]): string {
  const yours = `yours are ${listed(range, "and")}`;
  return asked === "urgent"
    ? `Not changed: urgent is a mood for one call, never a temperament; ${yours}.`
    : `Not changed: ${named} is not one of your temperaments; ${yours}.`;
}
