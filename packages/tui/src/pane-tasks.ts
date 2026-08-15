export class PaneTasks {
  private readonly pending = new Set<Promise<void>>();
  private failureText: string | undefined;
  private disposed = false;

  constructor(private readonly notify: () => void) {}

  failure(): string | undefined {
    return this.failureText;
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
    const settled = work()
      .then(() => {
        this.failureText = undefined;
      })
      .catch((cause: unknown) => {
        this.failureText = (cause as Error).message;
      })
      .then(() => {
        this.pending.delete(settled);
        this.emit();
      });
    this.pending.add(settled);
  }

  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
