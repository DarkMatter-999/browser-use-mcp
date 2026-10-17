export interface Pointer {
  readonly enabled: boolean;
  ensureInstalled(tabId: number): Promise<void>;
  moveTo(tabId: number, x: number, y: number, label: string): Promise<void>;
  hideForCapture(tabId: number): Promise<() => Promise<void>>;
}
