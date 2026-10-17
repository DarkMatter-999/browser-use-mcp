export interface IdleMonitorOptions {
  idleMs: number;
  isBusy(): boolean;
  onIdle(): void;
  now?(): number;
}

export class IdleMonitor {
  readonly #options: IdleMonitorOptions;
  #lastBusy: number;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: IdleMonitorOptions) {
    this.#options = options;
    this.#lastBusy = (options.now ?? Date.now)();
  }

  tick(): void {
    const now = (this.#options.now ?? Date.now)();
    if (this.#options.isBusy()) {
      this.#lastBusy = now;
      return;
    }
    if (now - this.#lastBusy > this.#options.idleMs) {
      this.stop();
      this.#options.onIdle();
    }
  }

  start(intervalMs = 30_000): void {
    this.#timer = setInterval(() => {
      this.tick();
    }, intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
