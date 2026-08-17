export interface ArcBindingChange {
  sessionId: string;
  arc: string | undefined;
  previous: string | undefined;
}

export type ArcBindingListener = (change: ArcBindingChange) => void;

export class ArcBindings {
  private readonly bySession = new Map<string, string>();

  constructor(private readonly listener?: ArcBindingListener) {}

  bind(sessionId: string, arc: string): ArcBindingChange {
    return this.record(sessionId, arc);
  }

  unbind(sessionId: string): ArcBindingChange {
    return this.record(sessionId, undefined);
  }

  bindingOf(sessionId: string): string | undefined {
    return this.bySession.get(sessionId);
  }

  inheritOnFork(parentId: string, childId: string): string | undefined {
    const arc = this.bySession.get(parentId);
    if (arc !== undefined) this.record(childId, arc);
    return arc;
  }

  sessionsBoundTo(arc: string): string[] {
    return [...this.bySession.entries()]
      .filter(([, bound]) => bound === arc)
      .map(([sessionId]) => sessionId);
  }

  releaseArc(arc: string): string[] {
    const released = this.sessionsBoundTo(arc);
    for (const sessionId of released) this.record(sessionId, undefined);
    return released;
  }

  private record(sessionId: string, arc: string | undefined): ArcBindingChange {
    const previous = this.bySession.get(sessionId);
    if (arc === undefined) this.bySession.delete(sessionId);
    else this.bySession.set(sessionId, arc);
    const change: ArcBindingChange = { sessionId, arc, previous };
    if (arc !== previous) this.listener?.(change);
    return change;
  }
}
