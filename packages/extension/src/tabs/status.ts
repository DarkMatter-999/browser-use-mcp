export type TabConnectionState = "connecting" | "connected" | "disconnected" | "error";

export class TabStatus {
  private states = new Map<number, TabConnectionState>();

  set(tabId: number, state: TabConnectionState): void {
    this.states.set(tabId, state);
  }

  get(tabId: number): TabConnectionState {
    return this.states.get(tabId) ?? "disconnected";
  }

  remove(tabId: number): void {
    this.states.delete(tabId);
  }

  clear(): void {
    this.states.clear();
  }
}
