import { randomUUID } from "node:crypto";
import { z } from "zod";
import { neutralizeRecalled } from "../memory/neutralize.ts";
import type { ToolCallPart } from "../messages.ts";
import type { KeeperAway } from "../notices/quiet.ts";
import { minuteMs } from "../routines/clock.ts";
import { quotedNameOf } from "../show/naming.ts";
import type { PlaceBook } from "../show/places.ts";
import type { SceneShelf } from "../show/scenes.ts";
import {
  agentNameLength,
  type Mood,
  type Setting,
  type SettingAgent,
  type SteadPlace,
} from "../show/setting.ts";
import { machinePaneAsked, type ShowSettings, type ShowTarget } from "../tools/show.ts";
import type { TemperamentSeat } from "../tools/temperament.ts";
import { yardRefused, yardToolNames, yardTools } from "../tools/yard.ts";
import { findTool, type Tool } from "../tools.ts";

export const creatureYardTools = yardToolNames;

export type CreatureYardTool = (typeof creatureYardTools)[number];

export const yardNoticeEveryMs = 10 * minuteMs;

export interface CreatureYard {
  settings: ShowSettings;
  now(): number;
  toldAt: Map<string, number>;
  places?: PlaceBook | undefined;
  asksTheKeeper?: KeeperAsker | undefined;
  scenes?: SceneShelf | undefined;
  temperamentOf?: ((slug: string) => Promise<Mood | undefined>) | undefined;
  temperamentsOf?: ((slug: string) => TemperamentSeat) | undefined;
  away?: (() => KeeperAway | undefined) | undefined;
}

export type KeeperAsker = (conversation: string, call: ToolCallPart) => Promise<boolean>;

export interface CreatureYardSeams {
  now?: (() => number) | undefined;
  places?: PlaceBook | undefined;
  asksTheKeeper?: KeeperAsker | undefined;
  scenes?: SceneShelf | undefined;
  temperamentOf?: ((slug: string) => Promise<Mood | undefined>) | undefined;
  temperamentsOf?: ((slug: string) => TemperamentSeat) | undefined;
  away?: (() => KeeperAway | undefined) | undefined;
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

export function creatureYard(settings: ShowSettings, seams: CreatureYardSeams = {}): CreatureYard {
  const {
    now = Date.now,
    places,
    asksTheKeeper,
    scenes,
    temperamentOf,
    temperamentsOf,
    away,
  } = seams;
  return {
    settings,
    now,
    toldAt: new Map(),
    places,
    asksTheKeeper,
    scenes,
    temperamentOf,
    temperamentsOf,
    away,
  };
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
  const target = seatOf(yard, seat, { made, raised });
  const tool = findTool(yardTools(target), name);
  try {
    const declined = await declinedByTheKeeper(yard, seat, tool, args, target);
    if (declined !== undefined) return declined;
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

async function declinedByTheKeeper(
  yard: CreatureYard,
  seat: YardSeat,
  tool: Tool,
  args: Record<string, unknown>,
  target: ShowTarget,
): Promise<YardAnswer | undefined> {
  const pane = machinePaneAsked(target, args);
  if (tool.alwaysAsks?.(args) !== true || pane === undefined) return undefined;
  const call: ToolCallPart = {
    type: "tool-call",
    callId: randomUUID(),
    name: tool.name,
    arguments: args,
  };
  const approved = (await yard.asksTheKeeper?.(seat.conversation, call)) ?? false;
  if (approved) return undefined;
  const said =
    yard.asksTheKeeper === undefined
      ? `Not set out: a ${pane} acts on the keeper's machine, so the keeper says yes each time, and nobody here can ask them.`
      : `Not set out: the keeper did not allow the ${pane}.`;
  return { said, refused: true, made: undefined, critical: undefined };
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
  return `On this machine you may also open things for the keeper through it: show, shown, arrange and withdraw set things out beside ${slug}'s conversation or in windows of their own in the keeper's app. The tools were written for ${slug} and are lent to you as they are, so read their "you", "yours" and "your conversation" as ${slug}. What you open rises from the porch unless you name another place, carries a small square in a colour kept for your client's name, and counts against ${slug}'s limits; ${slug} and the keeper are told. The keeper is the person ${slug} works with. A terminal or a screen acts on the keeper's machine, so the keeper is asked each time.`;
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
  return {
    creature: slug,
    sessionId: conversation,
    agent,
    home: atThePorch,
    places: yard.places,
    scenes: yard.scenes,
    temperament: async () => yard.temperamentOf?.(slug),
    temperaments: yard.temperamentsOf?.(slug),
    away: yard.away,
    settings: () => settings,
  };
}

const atThePorch: SteadPlace = { kind: "porch" };

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
