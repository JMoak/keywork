import type { BusEnvelope, EventLog } from "./events.ts";

export function serializeEnvelope(envelope: BusEnvelope): string {
  return JSON.stringify(envelope, errorsAsPlainObjects);
}

export function sseFrame(envelope: BusEnvelope): string {
  return `id: ${envelope.id}\nevent: ${envelope.type}\ndata: ${serializeEnvelope(envelope)}\n\n`;
}

export function lastEventIdOf(request: Request): number | undefined {
  const header = request.headers.get("last-event-id");
  if (header === null || !/^\d+$/.test(header)) return undefined;
  return Number(header);
}

export interface StreamRegistry {
  add(close: () => void): () => void;
}

export type EnvelopeFilter = (envelope: BusEnvelope) => boolean;

export function sessionFilterOf(request: Request): EnvelopeFilter {
  const session = new URL(request.url).searchParams.get("session");
  if (session === null || session === "") return () => true;
  return (envelope) => envelope.sessionId === session || envelope.sessionId === "";
}

export function eventStreamResponse(
  log: EventLog,
  request: Request,
  streams: StreamRegistry,
): Response {
  let connection: SseConnection | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      connection = new SseConnection(controller, log, request, streams);
      connection.open(lastEventIdOf(request));
    },
    cancel() {
      connection?.close();
    },
  });
  return new Response(body, { headers: sseHeaders });
}

const sseHeaders = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  connection: "keep-alive",
};

class SseConnection {
  private readonly encoder = new TextEncoder();
  private readonly teardown: Array<() => void> = [];
  private readonly keep: EnvelopeFilter;
  private closed = false;

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    private readonly log: EventLog,
    private readonly request: Request,
    private readonly streams: StreamRegistry,
  ) {
    this.keep = sessionFilterOf(request);
  }

  open(resumeFrom: number | undefined): void {
    this.write(": connected\n\n");
    if (resumeFrom !== undefined) this.replay(resumeFrom);
    this.teardown.push(
      this.log.subscribe((envelope) => {
        if (this.keep(envelope)) this.write(sseFrame(envelope));
      }),
    );
    this.teardown.push(this.streams.add(() => this.close()));
    const onAbort = (): void => this.close();
    this.request.signal.addEventListener("abort", onAbort, { once: true });
    this.teardown.push(() => this.request.signal.removeEventListener("abort", onAbort));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const step of this.teardown.splice(0)) step();
    try {
      this.controller.close();
    } catch {}
  }

  private replay(resumeFrom: number): void {
    const oldest = this.log.oldestRetainedId();
    if (oldest !== undefined && resumeFrom + 1 < oldest) {
      this.write(`: resumed with a gap, events ${resumeFrom + 1} to ${oldest - 1} are gone\n\n`);
    }
    for (const envelope of this.log.since(resumeFrom).filter(this.keep)) {
      this.write(sseFrame(envelope));
    }
  }

  private write(text: string): void {
    if (this.closed) return;
    try {
      this.controller.enqueue(this.encoder.encode(text));
    } catch {
      this.close();
    }
  }
}

function errorsAsPlainObjects(_key: string, value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message } : value;
}
