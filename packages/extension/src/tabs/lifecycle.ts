import type { TabStatus } from "./status";

export class TabLifecycle {
  private connects = new Map<number, Promise<void>>();
  private disconnects = new Map<number, Promise<void>>();

  connect(tabId: number, work: () => Promise<void>): Promise<void> {
    const existing = this.connects.get(tabId);
    if (existing) return existing;
    const previousDisconnect = this.disconnects.get(tabId);
    const operation = Promise.resolve(previousDisconnect)
      .catch(() => undefined)
      .then(work);
    this.connects.set(tabId, operation);
    const clear = () => {
      if (this.connects.get(tabId) === operation) this.connects.delete(tabId);
    };
    void operation.then(clear, clear);
    return operation;
  }

  disconnect(tabId: number, work: () => Promise<void>): Promise<void> {
    const existing = this.disconnects.get(tabId);
    if (existing) return existing;
    const pendingConnect = this.connects.get(tabId);
    const operation = Promise.resolve(pendingConnect)
      .catch(() => undefined)
      .then(work);
    this.disconnects.set(tabId, operation);
    const clear = () => {
      if (this.disconnects.get(tabId) === operation) this.disconnects.delete(tabId);
    };
    void operation.then(clear, clear);
    return operation;
  }
}

export function detachAllTabs(
  tabs: Set<number>,
  status: TabStatus,
  detach: (tabId: number) => void,
): void {
  for (const tabId of tabs) {
    status.set(tabId, "disconnected");
    detach(tabId);
  }
  tabs.clear();
}
