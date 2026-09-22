// Session-bound APIs must never escape into watcher continuations. Keep the
// continuation queued across reload and run it synchronously with the bound API.
export class CompletionDelivery<T> {
  private api: T | undefined;
  private stopped = false;
  private pending: Array<{ run: (api: T) => void; resolve: () => void; reject: (error: unknown) => void }> = [];

  enqueue(run: (api: T) => void): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.pending.push({ run, resolve, reject });
      this.drain();
    });
  }

  bind(api: T): void {
    this.stopped = false;
    this.api = api;
    this.drain();
  }

  detach(preserve: boolean): void {
    this.api = undefined;
    this.stopped = !preserve;
    if (!preserve) {
      // Terminal/session-switch teardown suppresses delivery, like active watchers.
      for (const entry of this.pending.splice(0)) entry.resolve();
    }
  }

  private drain(): void {
    while (this.api !== undefined && this.pending.length > 0) {
      const entry = this.pending.shift()!;
      try {
        entry.run(this.api);
        entry.resolve();
      } catch (error) {
        entry.reject(error);
      }
    }
  }
}
