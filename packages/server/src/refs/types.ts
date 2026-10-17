export interface RefStore {
  set(tabId: number, refs: ReadonlyMap<string, number>): void;
  /** Throws STALE_REF when the ref is unknown or was invalidated. */
  resolve(tabId: number, ref: string): number;
  invalidate(tabId: number): void;
  has(tabId: number): boolean;
}
