import { Agent, type Provider, type Tool, type ToolGuard } from "@keywork/engine";
import { AskQueue } from "./asks.ts";
import type { EventLog } from "./events.ts";
import type { SessionDetail, SessionHost, SessionSummary } from "./host.ts";

export interface SseFrame {
  id: string | undefined;
  event: string | undefined;
  data: string;
}

export interface SseReader {
  next(): Promise<SseFrame>;
  raw(): string;
  close(): Promise<void>;
}

export function sseReader(response: Response): SseReader {
  const body = response.body;
  if (body === null) throw new Error("the response has no body to read");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let seen = "";
  const nextChunk = async (): Promise<boolean> => {
    const { value, done } = await reader.read();
    if (done) return false;
    const text = decoder.decode(value, { stream: true });
    buffered += text;
    seen += text;
    return true;
  };
  return {
    next: async () => {
      for (;;) {
        const frame = takeFrame();
        if (frame !== undefined) return frame;
        if (!(await nextChunk())) throw new Error("the event stream ended before the next frame");
      }
    },
    raw: () => seen,
    close: () => reader.cancel(),
  };

  function takeFrame(): SseFrame | undefined {
    for (;;) {
      const end = buffered.indexOf("\n\n");
      if (end === -1) return undefined;
      const block = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      const frame = parseFrame(block);
      if (frame !== undefined) return frame;
    }
  }
}

export const headlessGuard: ToolGuard = { confirm: async () => false, gate: "headless" };

export interface MemoryHostOptions {
  log: EventLog;
  provider: Provider;
  tools?: readonly Tool[];
  now?: () => Date;
  asks?: "queue" | "headless";
  askTimeoutMs?: number;
}

export function memorySessionHost(options: MemoryHostOptions): SessionHost {
  const agents = new Map<string, Agent>();
  const detachers: Array<() => void> = [];
  const now = options.now ?? (() => new Date());
  const asks = new AskQueue({
    now,
    ...(options.askTimeoutMs !== undefined && { timeoutMs: options.askTimeoutMs }),
  });
  const summaryOf = (id: string, agent: Agent): SessionSummary => ({
    id,
    title: `session ${id}`,
    createdAt: now().toISOString(),
    lastActivityAt: now().toISOString(),
    messageCount: agent.history().length,
  });
  return {
    list: async () => [...agents].map(([id, agent]) => summaryOf(id, agent)),
    read: async (id) => {
      const agent = agents.get(id);
      if (agent === undefined) return undefined;
      const detail: SessionDetail = {
        ...summaryOf(id, agent),
        cwd: "/memory",
        live: true,
        messages: agent.history(),
        asOf: options.log.latestId(),
      };
      return detail;
    },
    create: async () => {
      const id = `s${agents.size + 1}`;
      const agent = new Agent({
        provider: options.provider,
        guard: options.asks === "queue" ? asks.guardFor(id) : headlessGuard,
        ...(options.tools !== undefined && { tools: options.tools }),
      });
      agents.set(id, agent);
      detachers.push(options.log.attach(agent.bus, id));
      return summaryOf(id, agent);
    },
    prompt: async (id, text) => {
      const agent = agents.get(id);
      if (agent === undefined) return "missing";
      agent.send(text).catch(() => undefined);
      return "accepted";
    },
    abort: async (id) => {
      const agent = agents.get(id);
      if (agent === undefined) return "missing";
      if (!agent.busy()) return "idle";
      agent.interrupt();
      return "aborted";
    },
    asks: async () => asks.list(),
    answerAsk: async (callId, verdict) => asks.answer(callId, verdict),
    close: async () => {
      asks.close();
      for (const agent of agents.values()) agent.interrupt();
      for (const detach of detachers) detach();
      agents.clear();
    },
  };
}

function parseFrame(block: string): SseFrame | undefined {
  const fields = block.split("\n").filter((line) => !line.startsWith(":"));
  if (fields.length === 0) return undefined;
  const frame: SseFrame = { id: undefined, event: undefined, data: "" };
  const data: string[] = [];
  for (const line of fields) {
    const separator = line.indexOf(":");
    const name = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (name === "id") frame.id = value;
    else if (name === "event") frame.event = value;
    else if (name === "data") data.push(value);
  }
  frame.data = data.join("\n");
  return frame;
}
