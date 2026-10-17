export interface DiagnosticEvent {
  sequence: number;
  tabId: number;
  method: string;
  timestamp: number;
  data: Record<string, unknown>;
  bytes: number;
}

export interface DiagnosticBufferLimits {
  maxItems?: number;
  maxBytes?: number;
}

export interface DiagnosticReadResult {
  events: DiagnosticEvent[];
  cursor: number;
  truncated: boolean;
}

export class DiagnosticEventBuffer {
  private tabs = new Map<number, DiagnosticEvent[]>();
  private sequence = 0;
  constructor(private readonly limits: DiagnosticBufferLimits = {}) {}

  push(tabId: number, method: string, data: Record<string, unknown>): DiagnosticEvent {
    const event: DiagnosticEvent = {
      sequence: ++this.sequence,
      tabId,
      method,
      timestamp: Date.now(),
      data: structuredClone(data),
      bytes: Buffer.byteLength(JSON.stringify(data)),
    };
    const events = this.tabs.get(tabId) ?? [];
    events.push(event);
    this.tabs.set(tabId, events);
    this.trim(events);
    return event;
  }

  read(tabId: number, options: { cursor?: number; limit?: number } = {}): DiagnosticReadResult {
    const events = this.tabs.get(tabId) ?? [];
    const first = events[0]?.sequence ?? this.sequence + 1;
    const cursor = options.cursor ?? 0;
    const available = events.filter((event) => event.sequence > cursor);
    const limit = options.limit ?? 100;
    const selected = available.slice(0, limit);
    return {
      events: selected,
      cursor: selected.at(-1)?.sequence ?? cursor,
      truncated: cursor < first - 1 || available.length > selected.length,
    };
  }

  update(tabId: number, sequence: number, data: Record<string, unknown>): void {
    const events = this.tabs.get(tabId);
    const event = events?.find((item) => item.sequence === sequence);
    if (!events || !event) return;
    event.data = structuredClone(data);
    event.bytes = Buffer.byteLength(JSON.stringify(data));
    this.trim(events);
  }

  clear(tabId: number): void {
    this.tabs.delete(tabId);
  }

  private trim(events: DiagnosticEvent[]): void {
    const maxItems = this.limits.maxItems ?? 500;
    const maxBytes = this.limits.maxBytes ?? 2 * 1024 * 1024;
    while (
      events.length > maxItems ||
      events.reduce((total, item) => total + item.bytes, 0) > maxBytes
    ) {
      events.shift();
    }
  }
}
