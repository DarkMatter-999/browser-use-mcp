export interface KeyValueStore {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export const DEFAULT_PORT = 38241;
/** chrome.storage.local key of the "Let the agent open tabs (keep connected)" setting. */
export const ALWAYS_CONNECTED_KEY = "alwaysConnected";
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export class Settings {
  constructor(private readonly store: KeyValueStore) {}

  async getToken(): Promise<string | undefined> {
    const { token } = await this.store.get("token");
    return typeof token === "string" && TOKEN_PATTERN.test(token) ? token : undefined;
  }

  setToken(token: string): Promise<void> {
    return this.store.set({ token });
  }

  clearToken(): Promise<void> {
    return this.store.remove("token");
  }

  async getPort(): Promise<number> {
    const { port } = await this.store.get("port");
    return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535
      ? port
      : DEFAULT_PORT;
  }

  /** Default off: the extension only holds a connection while a tab is connected. */
  async getAlwaysConnected(): Promise<boolean> {
    const stored = await this.store.get(ALWAYS_CONNECTED_KEY);
    return stored[ALWAYS_CONNECTED_KEY] === true;
  }

  setAlwaysConnected(value: boolean): Promise<void> {
    return this.store.set({ [ALWAYS_CONNECTED_KEY]: value });
  }

  async getPeerId(): Promise<string> {
    const { peerId } = await this.store.get("peerId");
    if (typeof peerId === "string") return peerId;
    const created = crypto.randomUUID();
    await this.store.set({ peerId: created });
    return created;
  }
}
