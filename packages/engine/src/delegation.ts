import { z } from "zod";
import { type Agent, NestedRefusalError, type ToolGuard } from "./agent.ts";
import {
  type ChildFinished,
  type ChildOutcome,
  type ChildStarted,
  type EngineEvents,
  EventBus,
  type RefusedCall,
} from "./bus.ts";
import { type Message, messageText, type ToolCallPart, type Usage } from "./messages.ts";
import { knownCostNanos } from "./pricing.ts";
import { childDepthOf, childSessionFile } from "./session/children.ts";
import { tapJournal } from "./session/journal.ts";
import { SessionStore } from "./session/store.ts";
import { defineTool } from "./tools/define.ts";
import type { Tool } from "./tools.ts";

export const delegateToolName = "delegate";
export const maxChildDepth = 1;
export const childSlotLimit = 4;

export interface BotChoice {
  name: string;
  description?: string | undefined;
}

export interface ChildSpec {
  bot: string | undefined;
  bus: EventBus<EngineEvents>;
  store: SessionStore | undefined;
}

export interface ChildHost {
  forge(spec: ChildSpec): Agent;
  attach?(child: SessionStore): void;
  release?(childId: string): void;
}

export interface DelegationSeams {
  host: ChildHost;
  slots: ChildSlots;
  bots: readonly BotChoice[];
  parentBot: string | undefined;
  refusalEndsRun: boolean;
  parentStore(): SessionStore | undefined;
  parentCall(): ToolCallPart | undefined;
  parentBus(): EventBus<EngineEvents> | undefined;
  reportActivity(line: string): void;
  newSessionFileName(): string;
}

export interface ChildProvenance {
  sessionId: string | undefined;
  bot: string | undefined;
  outcome: ChildOutcome;
}

export function delegateTool(seams: DelegationSeams): Tool {
  return defineTool({
    name: delegateToolName,
    description: delegationDescription(seams.bots),
    schema: delegateArguments,
    run: (request, signal) => delegate(seams, request, signal),
  });
}

export function childGuardOf(parent: ToolGuard): ToolGuard {
  const { confirm, beforeMutation } = parent;
  return {
    ...(confirm !== undefined && { confirm: (call: ToolCallPart) => confirm.call(parent, call) }),
    ...(parent.gate !== undefined && { gate: parent.gate }),
    ...(parent.declineEndsRun !== undefined && { declineEndsRun: parent.declineEndsRun }),
    ...(beforeMutation !== undefined && { beforeMutation: () => beforeMutation.call(parent) }),
  };
}

export class ChildSlots {
  private taken = 0;

  constructor(readonly limit = childSlotLimit) {}

  take(): (() => void) | undefined {
    if (this.taken >= this.limit) return undefined;
    this.taken += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.taken -= 1;
    };
  }

  running(): number {
    return this.taken;
  }
}

export function childResult(provenance: ChildProvenance, answer: string): string {
  const parts = [
    `${provenanceMark} ${provenance.sessionId ?? unsavedChild}`,
    ...(provenance.bot === undefined ? [] : [provenance.bot]),
    provenance.outcome,
  ];
  return `${parts.join(" · ")}\n\n${answer}`;
}

export function childTitleOf(raw: string): string {
  const printable = [...raw].map((character) => (isControl(character) ? " " : character)).join("");
  const flat = printable.replace(/\s+/g, " ").trim();
  return flat.length > titleLimit ? `${flat.slice(0, titleLimit - 1)}…` : flat;
}

export function childProvenanceOf(output: string): ChildProvenance | undefined {
  const match = provenanceLine.exec(output.split("\n", 1)[0] ?? "");
  if (match === null) return undefined;
  const [, sessionId, bot, outcome] = match;
  return {
    sessionId: sessionId === unsavedChild ? undefined : sessionId,
    bot,
    outcome: outcome as ChildOutcome,
  };
}

const titleLimit = 60;
const provenanceMark = "↳ child";
const unsavedChild = "unsaved";
const provenanceLine =
  /^↳ child (\S+)(?: · ([a-z0-9][a-z0-9-]*))? · (completed|interrupted|failed|denied)$/;

const delegateArguments = z.object({
  title: z.string().min(1).describe("a few words naming the work, shown on screen"),
  prompt: z
    .string()
    .min(1)
    .describe("the whole task: what to do, what to hand back, and anything the child must know"),
  bot: z
    .string()
    .min(1)
    .optional()
    .describe("run the child as this bot; leave it out to use the bot you run as"),
});

type DelegateRequest = z.infer<typeof delegateArguments>;

interface OpenedChild {
  callId: string;
  title: string;
  bot: string | undefined;
  store: SessionStore | undefined;
  bus: EventBus<EngineEvents>;
  agent: Agent;
}

type ChildEnding = { message: Message } | { error: Error };

interface ChildWatch {
  readonly refused: readonly RefusedCall[];
  interrupted(): boolean;
  settle(): Promise<void>;
}

function delegationDescription(bots: readonly BotChoice[]): string {
  const roster = bots.length === 0 ? "" : ` Bots here: ${bots.map(describeBot).join("; ")}.`;
  return [
    "Hand a self-contained piece of work to a child session and get its final answer back as this result.",
    "The child starts with a fresh context, so the prompt must carry everything it needs.",
    "It runs under your permissions and cannot delegate further.",
    `Good for searches and investigations whose raw output would crowd your context.${roster}`,
  ].join(" ");
}

function describeBot(bot: BotChoice): string {
  return bot.description === undefined ? bot.name : `${bot.name} (${bot.description})`;
}

async function delegate(
  seams: DelegationSeams,
  request: DelegateRequest,
  signal: AbortSignal | undefined,
): Promise<string> {
  const call = seams.parentCall();
  if (call === undefined) throw new Error("delegate runs only as a tool call");
  refuseBeyondDepth(seams.parentStore());
  const bot = chosenBot(seams, request.bot);
  const release = seams.slots.take();
  if (release === undefined) throw new Error(slotsFullMessage(seams.slots.limit));
  try {
    const child = await openChild(seams, call.callId, titleFor(request), bot);
    try {
      return await superviseChild(seams, child, request.prompt, signal);
    } finally {
      if (child.store !== undefined) seams.host.release?.(child.store.header.id);
    }
  } finally {
    release();
  }
}

function titleFor(request: DelegateRequest): string {
  return childTitleOf(request.title) || childTitleOf(request.prompt);
}

function refuseBeyondDepth(parent: SessionStore | undefined): void {
  if (parent === undefined || childDepthOf(parent.file) < maxChildDepth) return;
  throw new Error("this session is itself a child, and children don't delegate · do the work here");
}

function chosenBot(seams: DelegationSeams, requested: string | undefined): string | undefined {
  if (requested === undefined) return seams.parentBot;
  if (seams.bots.some((bot) => bot.name === requested)) return requested;
  const known = seams.bots.map((bot) => bot.name);
  const roster = known.length === 0 ? "no bots are defined here" : `bots here: ${known.join(", ")}`;
  throw new Error(`no bot named ${requested} · ${roster}`);
}

function slotsFullMessage(limit: number): string {
  return `${limit} children are already running · wait for one to finish or do this here`;
}

async function openChild(
  seams: DelegationSeams,
  callId: string,
  title: string,
  bot: string | undefined,
): Promise<OpenedChild> {
  const store = await childStoreUnder(seams, callId, title, bot);
  const bus = new EventBus<EngineEvents>();
  const agent = seams.host.forge({ bot, bus, store });
  await recordModel(store, agent);
  if (store !== undefined) seams.host.attach?.(store);
  return { callId, title, bot, store, bus, agent };
}

async function childStoreUnder(
  seams: DelegationSeams,
  callId: string,
  title: string,
  bot: string | undefined,
): Promise<SessionStore | undefined> {
  const parent = seams.parentStore();
  if (parent === undefined) return undefined;
  const store = SessionStore.createChild(
    childSessionFile(parent.file, seams.newSessionFileName()),
    parent.header.cwd,
    { sessionId: parent.header.id, callId },
  );
  await store.setName(title);
  const arc = parent.arcBinding();
  if (arc !== undefined || bot !== undefined) {
    await store.appendBinding({
      ...(arc !== undefined && { arc }),
      ...(bot !== undefined && { bot }),
    });
  }
  return store;
}

async function recordModel(store: SessionStore | undefined, agent: Agent): Promise<void> {
  const modelId = agent.provider.modelId;
  if (store === undefined || modelId === undefined) return;
  await store.appendModelChange(agent.provider.name, modelId);
}

async function superviseChild(
  seams: DelegationSeams,
  child: OpenedChild,
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const watch = watchChild(child, seams.reportActivity);
  seams.parentBus()?.emit("child.started", startedOf(child));
  const ending = await runToEnd(child.agent, prompt, signal);
  await watch.settle();
  const outcome = outcomeOf(ending, watch, seams.refusalEndsRun);
  seams.parentBus()?.emit("child.finished", finishedOf(child, outcome, watch.refused));
  return answerFor(child, outcome, ending, watch.refused);
}

function watchChild(child: OpenedChild, report: (line: string) => void): ChildWatch {
  const refused: RefusedCall[] = [];
  let interrupted = false;
  const recorder =
    child.store === undefined ? undefined : recordMessages(child.agent, child.store, child.bus);
  const journal = child.store === undefined ? undefined : tapJournal(child.bus, child.store);
  const stops = [
    child.bus.on("tool.started", ({ call }) => report(activityOf(call.name, call.arguments))),
    child.bus.on("gate.ask", ({ ask }) =>
      report(`needs you · ${activityOf(ask.tool, ask.arguments)}`),
    ),
    child.bus.on("gate.permission", ({ decision }) => {
      if (decision.gate === "headless" && decision.verdict === "denied") {
        refused.push({ tool: decision.tool, callId: decision.callId });
      }
    }),
    child.bus.on("turn.interrupted", () => {
      interrupted = true;
    }),
  ];
  return {
    refused,
    interrupted: () => interrupted,
    settle: async () => {
      for (const stop of stops) stop();
      await recorder?.finish();
      journal?.stop();
      await journal?.flush();
    },
  };
}

function recordMessages(
  agent: Agent,
  store: SessionStore,
  bus: EventBus<EngineEvents>,
): { finish(): Promise<void> } {
  let persisted = agent.history().length;
  const usages: Usage[] = [];
  let writes: Promise<void> = Promise.resolve();
  const stopUsage = bus.on("turn.delta", ({ delta, replay }) => {
    if (replay !== true && delta.type === "done") usages.push(delta.usage);
  });
  const persist = (): Promise<void> => {
    writes = writes.then(async () => {
      for (const message of agent.history().slice(persisted)) {
        await store.append(message, message.role === "assistant" ? usages.shift() : undefined);
        persisted += 1;
      }
    });
    return writes;
  };
  agent.settleToolBatchesWith(async () => {
    await persist();
    return undefined;
  });
  agent.settleTurnsWith(persist);
  return {
    finish: async () => {
      await persist();
      stopUsage();
      agent.settleTurnsWith(undefined);
      agent.settleToolBatchesWith(undefined);
    },
  };
}

async function runToEnd(
  agent: Agent,
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<ChildEnding> {
  try {
    return { message: await agent.send(prompt, signal === undefined ? {} : { signal }) };
  } catch (cause) {
    return { error: cause instanceof Error ? cause : new Error(String(cause)) };
  }
}

function outcomeOf(ending: ChildEnding, watch: ChildWatch, refusalEndsRun: boolean): ChildOutcome {
  if ("error" in ending) return "failed";
  if (watch.interrupted()) return "interrupted";
  if (refusalEndsRun && watch.refused.length > 0) return "denied";
  return "completed";
}

function startedOf(child: OpenedChild): ChildStarted {
  const sessionId = child.store?.header.id;
  return {
    callId: child.callId,
    ...(sessionId !== undefined && { sessionId }),
    title: child.title,
    ...(child.bot !== undefined && { bot: child.bot }),
  };
}

function finishedOf(
  child: OpenedChild,
  outcome: ChildOutcome,
  refused: readonly RefusedCall[],
): ChildFinished {
  const sessionId = child.store?.header.id;
  const costNanos = knownCostNanos(child.agent.cost());
  return {
    callId: child.callId,
    ...(sessionId !== undefined && { sessionId }),
    outcome,
    usage: child.agent.usage(),
    ...(costNanos !== undefined && { costNanos }),
    ...(refused.length > 0 && { refused: [...refused] }),
  };
}

function answerFor(
  child: OpenedChild,
  outcome: ChildOutcome,
  ending: ChildEnding,
  refused: readonly RefusedCall[],
): string {
  const provenance = { sessionId: child.store?.header.id, bot: child.bot, outcome };
  if ("error" in ending) throw new Error(childResult(provenance, ending.error.message));
  const answer = messageText(ending.message).trim();
  switch (outcome) {
    case "completed":
      return childResult(provenance, answer === "" ? emptyAnswer : answer);
    case "interrupted":
      throw new Error(childResult(provenance, answer === "" ? stoppedEarly : answer));
    case "denied":
      throw new NestedRefusalError(childResult(provenance, refusalNote(refused)));
    case "failed":
      throw new Error(childResult(provenance, answer));
  }
}

const emptyAnswer = "the child finished without writing an answer";
const stoppedEarly = "the child was stopped before it finished";

function refusalNote(refused: readonly RefusedCall[]): string {
  const tools = [...new Set(refused.map((call) => call.tool))].join(", ");
  return `the child stopped at a call no one could approve: ${tools}`;
}

const favoredSubjects = ["path", "command", "query", "pattern", "url", "name"];

function activityOf(tool: string, args: unknown): string {
  const subject = subjectOf(args);
  return subject === "" ? tool : `${tool} ${subject}`;
}

function isControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < 32 || code === 127;
}

function subjectOf(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const record = args as Record<string, unknown>;
  const key =
    favoredSubjects.find((candidate) => typeof record[candidate] === "string") ??
    Object.keys(record).find((candidate) => typeof record[candidate] === "string");
  const value = key === undefined ? undefined : record[key];
  if (typeof value !== "string") return "";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}
