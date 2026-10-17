import type { KeyValueStore } from "../../src/bridge/settings";
import type { SocketLike } from "../../src/bridge/client";

export class MemoryStore implements KeyValueStore {
  readonly data: Record<string, unknown>;
  constructor(initial: Record<string, unknown> = {}) {
    this.data = { ...initial };
  }
  get(keys: string | string[]): Promise<Record<string, unknown>> {
    const list = Array.isArray(keys) ? keys : [keys];
    return Promise.resolve(
      Object.fromEntries(
        list.filter((key) => key in this.data).map((key) => [key, this.data[key]]),
      ),
    );
  }
  set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.data, items);
    return Promise.resolve();
  }
  remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) Reflect.deleteProperty(this.data, key);
    return Promise.resolve();
  }
}

export class FakeWebSocket implements SocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closeCode: number | undefined;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCode = code;
    this.onclose?.({ code: code ?? 1000 });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  messages(): Record<string, unknown>[] {
    return this.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }
}

export function socketAt(index: number): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(index);
  if (!socket) throw new Error(`No fake socket at index ${String(index)}`);
  return socket;
}
