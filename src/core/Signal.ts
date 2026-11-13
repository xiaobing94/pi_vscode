/** Tiny emitter with no vscode dependency, so core services remain unit-testable. */
export class Signal<T> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const l of [...this.listeners]) {
      try { l(value); } catch { /* one bad listener must not break the emitter */ }
    }
  }

  dispose(): void { this.listeners.clear(); }
}

/** Serial async mutex, used for per-session snapshot serialization (§6.11). */
export class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const previous = this.tail;
    this.tail = previous.then(() => gate);
    await previous;
    try { return await fn(); }
    finally { release(); }
  }
}
