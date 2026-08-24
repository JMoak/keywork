export class PaneTasks {
  private readonly pending = new Set<Promise<void>>();
  private failures: TaskFailure[] = [];
  private tick = 0;
  private disposed = false;

  constructor(private readonly notify: () => void) {}

  failure(): string | undefined {
    return this.failures.at(-1)?.message;
  }

  live(): boolean {
    return !this.disposed;
  }

  dispose(): void {
    this.disposed = true;
  }

  emit(): void {
    if (!this.disposed) this.notify();
  }

  track(work: () => Promise<void>): void {
    if (this.disposed) return;
    const startedAt = this.advance();
    const settled = work()
      .then(() => this.forgetFailuresBefore(startedAt))
      .catch((cause: unknown) => this.recordFailure(cause))
      .finally(() => {
        this.pending.delete(settled);
        this.emit();
      });
    this.pending.add(settled);
  }

  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private advance(): number {
    this.tick += 1;
    return this.tick;
  }

  private recordFailure(cause: unknown): void {
    this.failures.push({ observedAt: this.advance(), message: failureMessage(cause) });
  }

  private forgetFailuresBefore(startedAt: number): void {
    this.failures = this.failures.filter((failure) => failure.observedAt > startedAt);
  }
}

export function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface TaskFailure {
  readonly observedAt: number;
  readonly message: string;
}
