import { BrowserUseError, type JsonValue } from "@browser-use/protocol";

interface Pending {
  resolve(value: JsonValue): void;
  reject(error: BrowserUseError): void;
  timer: ReturnType<typeof setTimeout>;
  tag: number | undefined;
}

export class PendingRequests {
  readonly #requests = new Map<string, Pending>();

  get size(): number {
    return this.#requests.size;
  }

  create(requestId: string, timeoutMs: number, tag?: number): Promise<JsonValue> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.reject(
          requestId,
          new BrowserUseError("TIMEOUT", `Bridge request timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      this.#requests.set(requestId, { resolve, reject, timer, tag });
    });
  }

  resolve(requestId: string, value: JsonValue): boolean {
    const pending = this.#take(requestId);
    if (!pending) return false;
    pending.resolve(value);
    return true;
  }

  reject(requestId: string, error: BrowserUseError): boolean {
    const pending = this.#take(requestId);
    if (!pending) return false;
    pending.reject(error);
    return true;
  }

  rejectAll(error: BrowserUseError): void {
    for (const requestId of [...this.#requests.keys()]) this.reject(requestId, error);
  }

  rejectWhere(tag: number, error: BrowserUseError): number {
    let count = 0;
    for (const [requestId, pending] of [...this.#requests]) {
      if (pending.tag === tag && this.reject(requestId, error)) count += 1;
    }
    return count;
  }

  #take(requestId: string): Pending | undefined {
    const pending = this.#requests.get(requestId);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.#requests.delete(requestId);
    return pending;
  }
}
