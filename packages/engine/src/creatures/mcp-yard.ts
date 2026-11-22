import { z } from "zod";
import { neutralizeRecalled } from "../memory/neutralize.ts";
import { minuteMs } from "../routines/clock.ts";
import { quotedNameOf } from "../show/naming.ts";
import { agentNameLength, type Setting, type SettingAgent } from "../show/setting.ts";
import type { ShowSettings, ShowTarget } from "../tools/show.ts";
import { yardRefused, yardToolNames, yardTools } from "../tools/yard.ts";
import { findTool } from "../tools.ts";

export const creatureYardTools = yardToolNames;

export type CreatureYardTool = (typeof creatureYardTools)[number];

export const yardNoticeEveryMs = 10 * minuteMs;

export interface CreatureYard {
  settings: ShowSettings;
  now(): number;
  toldAt: Map<string, number>;
}

export interface YardListing {
  name: CreatureYardTool;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type YardMade = Record<string, unknown>;

export type YardAnswer =
  | { said: string; refused: boolean; made: YardMade | undefined; critical: string | undefined }
  | { invalid: z.ZodError };

export function creatureYard(settings: ShowSettings, now: () => number = Date.now): CreatureYard {
  return { settings, now, toldAt: new Map() };
}

export function yardListingsFor(slug: string): YardListing[] {
  return yardTools(nobodysSeat).map(({ name, description, parameters }) => ({
    name: name as CreatureYardTool,
    description: `${actingAs(slug)} ${forAnOutsider(description)}`,
    inputSchema: parameters as Record<string, unknown>,
  }));
}

export interface YardSeat {
  slug: string;
  conversation: string;
  agent: SettingAgent;
}

export const clientInfoKey = "io.modelcontextprotocol/clientInfo";

export function agentNamedIn(message: unknown): SettingAgent {
  const given = recordOf(recordOf(recordOf(recordOf(message).params)._meta)[clientInfoKey]).name;
  if (typeof given !== "string") return {};
  const name = neutralizeRecalled(given).replace(/\s+/g, " ").trim().slice(0, agentNameLength);
  return name === "" ? {} : { name };
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function answeredInItsName(
  yard: CreatureYard,
  seat: YardSeat,
  name: CreatureYardTool,
  args: Record<string, unknown>,
): Promise<YardAnswer> {
  const made: YardMade = {};
  const raised: Setting[] = [];
  const tool = findTool(yardTools(seatOf(yard, seat, { made, raised })), name);
  try {
    const said = await tool.execute(args);
    const refused = yardRefused(said);
    return {
      said,
      refused,
      made: refused || Object.keys(made).length === 0 ? undefined : made,
      critical: raised.length === 0 ? undefined : raisedWords(raised),
    };
  } catch (error) {
    if (error instanceof z.ZodError) return { invalid: error };
    throw error;
  }
}

export function tellsNow(yard: CreatureYard, slug: string): boolean {
  const now = yard.now();
  const last = yard.toldAt.get(slug);
  if (last !== undefined && now - last < yardNoticeEveryMs) return false;
  yard.toldAt.set(slug, now);
  return true;
}

export function yardLine(name: CreatureYardTool): string {
  return `Over MCP on this machine, an agent is setting out windows through you; it began with ${name}. The keeper sees them marked as the agent's, each agent with a square of its own colour. They count against your limits and are yours to take back: shown lists what stands and names the agent on each, and withdraw takes back what you do not want.`;
}

export function yardInstructions(slug: string): string {
  return `On this machine you may also set out windows through it: show, arrange, shown and withdraw set things out beside ${slug}'s conversation or in windows of their own. The tools were written for ${slug} and are lent to you as they are, so read their "you", "yours", "this conversation" and "this thread" as ${slug} and everything out through it, what you set out included. On the keeper's screen each thing you set out carries a small square in one colour kept for your client's name, and that name, never ${slug}'s. The tools move only the console's own windows, never take focus, count against ${slug}'s limits, and ${slug} and its keeper are told. In the tools' words the keeper is the person ${slug} works with, the console is the keeper's app, the yard is the space around ${slug}'s conversation there, a setting is one thing set out, a mark is a word or two the keeper reads on it, a signal outlines it when it needs the keeper (needs-you, amber) or when something is broken (critical, red, with a reason, one at a time, and written to the keeper's audit), and the stage is the room the console gives windows outside, a 12 by 12 lattice. One show sets out several things when what is a list, and titles name things everywhere an id does.`;
}

export function yardReason(
  name: CreatureYardTool,
  slug: string,
  machine: string,
  critical?: string,
): string {
  const deed = `an agent on ${machine} ${yardDeeds[name]} ${slug}`;
  return critical === undefined ? deed : `${deed}, and raised critical on ${critical}`;
}

const yardDeeds: Readonly<Record<CreatureYardTool, string>> = {
  show: "set something out through",
  shown: "read what is out for",
  arrange: "arranged the windows of",
  withdraw: "withdrew a setting of",
};

const nobodysSeat: ShowTarget = { creature: null, sessionId: "", settings: () => undefined };

function forAnOutsider(description: string): string {
  return description
    .replace(/ This is IDE control[^.]*\./, "")
    .replace(
      "agent is there when an agent outside this conversation set the thing out through you, and names it,",
      "agent names the agent that set the thing out, your client or another,",
    );
}

function actingAs(slug: string): string {
  return `Here "you" is ${slug}, the creature you work through.`;
}

interface Witnessed {
  made: YardMade;
  raised: Setting[];
}

function seatOf(
  yard: CreatureYard,
  { slug, conversation, agent }: YardSeat,
  witnessed: Witnessed,
): ShowTarget {
  const settings = forAnother(yard.settings, witnessed);
  return { creature: slug, sessionId: conversation, agent, settings: () => settings };
}

function raisedWords(raised: readonly Setting[]): string {
  return raised
    .map(
      (setting) => `${quotedNameOf(setting.what)} (${setting.id}): ${JSON.stringify(setting.why)}`,
    )
    .join("; ");
}

function forAnother(settings: ShowSettings, { made, raised }: Witnessed): ShowSettings {
  const tookBack: string[] = [];
  const setOut: string[] = [];
  return {
    propose: (proposal) => {
      const outcome = settings.propose(proposal);
      if ("refused" in outcome) return outcome;
      setOut.push(outcome.setting.id);
      made.id = outcome.setting.id;
      if (setOut.length > 1) made.setOut = [...setOut];
      if (outcome.setting.signal === "critical" && outcome.replaced?.signal !== "critical")
        raised.push(outcome.setting);
      return outcome;
    },
    takeBack: (caller, id, mood) => {
      const taken = settings.takeBack(caller, id, mood);
      if ("refused" in taken) return taken;
      tookBack.push(taken.id);
      made.id = taken.id;
      if (tookBack.length > 1) made.withdrawn = [...tookBack];
      return taken;
    },
    arrange: (caller, ask) => {
      const arrangement = settings.arrange(caller, ask);
      if (!("refused" in arrangement)) {
        made.arrangement = arrangement.id;
        made.panes = [...arrangement.panes];
      }
      return arrangement;
    },
    mark: (caller, marks, spends) => {
      const marked = settings.mark(caller, marks, spends);
      if (!("refused" in marked)) made.marked = marked.map(({ id }) => id);
      return marked;
    },
    signal: (caller, signals, why, spends) => {
      const signalled = settings.signal(caller, signals, why, spends);
      if ("refused" in signalled) return signalled;
      made.signalled = signalled.map(({ setting }) => setting.id);
      for (const { setting, before } of signalled)
        if (setting.signal === "critical" && before !== "critical") raised.push(setting);
      return signalled;
    },
    canGrowFrom: (caller, from) => settings.canGrowFrom(caller, from),
    takeHeardBy: () => undefined,
    standingFor: (caller) => settings.standingFor(caller, "another"),
    reportNaming: (names) => settings.reportNaming(names),
  };
}
