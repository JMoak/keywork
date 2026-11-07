import type { CreatureSessionTag } from "./sessions.ts";
import type { CreatureOrigin, CreatureSessions, InjectOutcome, TaggedSession } from "./threads.ts";

export interface RecordedInjection {
  sessionId: string;
  text: string;
  origin: CreatureOrigin;
}

export class FakeCreatureSessions implements CreatureSessions {
  readonly sessions: TaggedSession[] = [];
  readonly opened: CreatureSessionTag[] = [];
  readonly injections: RecordedInjection[] = [];
  readonly trashed: string[] = [];
  readonly transcripts = new Map<string, string[]>();
  private readonly busy = new Set<string>();
  private readonly turns = new Map<string, number>();
  private clock = 0;

  constructor(private readonly now: () => Date = () => new Date("2026-11-05T09:00:00.000Z")) {}

  async list(): Promise<readonly TaggedSession[]> {
    return [...this.sessions];
  }

  async open(tag: CreatureSessionTag): Promise<string> {
    this.opened.push(tag);
    return this.add(tag).id;
  }

  async inject(sessionId: string, text: string, origin: CreatureOrigin): Promise<InjectOutcome> {
    if (!this.transcripts.has(sessionId)) return "missing";
    this.injections.push({ sessionId, text, origin });
    this.transcripts.get(sessionId)?.push(text);
    return "noted";
  }

  turnsStarted(sessionId: string): number {
    return this.turns.get(sessionId) ?? 0;
  }

  async trash(sessionId: string): Promise<void> {
    this.trashed.push(sessionId);
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    if (index !== -1) this.sessions.splice(index, 1);
    this.transcripts.delete(sessionId);
  }

  add(tag: CreatureSessionTag, facts: Partial<Omit<TaggedSession, "tag">> = {}): TaggedSession {
    this.clock += 1;
    const at = new Date(this.now().getTime() + this.clock * 1000).toISOString();
    const session: TaggedSession = {
      id: facts.id ?? `s${this.clock}`,
      tag,
      title: facts.title ?? `${tag.kind} ${this.clock}`,
      createdAt: facts.createdAt ?? at,
      lastActivityAt: facts.lastActivityAt ?? at,
      working: facts.working ?? false,
      waiting: facts.waiting ?? 0,
      ...(facts.parent !== undefined && { parent: facts.parent }),
      ...(facts.held !== undefined && { held: facts.held }),
    };
    this.sessions.push(session);
    this.transcripts.set(session.id, []);
    return session;
  }

  startTurn(sessionId: string): void {
    this.busy.add(sessionId);
    this.turns.set(sessionId, this.turnsStarted(sessionId) + 1);
  }

  settle(sessionId: string): void {
    this.busy.delete(sessionId);
  }

  write(sessionId: string, text: string): void {
    this.transcripts.get(sessionId)?.push(text);
  }
}
