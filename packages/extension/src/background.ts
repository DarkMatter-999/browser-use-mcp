import "./zod-jitless";
import { resolveTabUrl } from "./shared/tab-url";
import { BridgeClient, type SocketLike } from "./bridge/client";
import { ALWAYS_CONNECTED_KEY, Settings } from "./bridge/settings";
import { DebuggerAdapter } from "./cdp/debugger-adapter";
import { Controller, type PopupMessage } from "./controller";
import { trackDownloads } from "./downloads";
import { addToBrowserUseGroup, type GroupApi } from "./tabs/groups";

function createSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  const socket: SocketLike = {
    get readyState() {
      return ws.readyState;
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => {
      ws.send(data);
    },
    close: (code, reason) => {
      ws.close(code, reason);
    },
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (event) => socket.onmessage?.({ data: event.data });
  ws.onclose = (event) => socket.onclose?.({ code: event.code });
  ws.onerror = () => socket.onerror?.();
  return socket;
}

const groupApi: GroupApi = {
  tabs: {
    get: (tabId) => chrome.tabs.get(tabId),
    group: ({ tabIds: [first, ...rest], groupId }) => {
      if (first === undefined) return Promise.reject(new Error("No tabs to group"));
      return chrome.tabs.group({
        tabIds: [first, ...rest],
        ...(groupId === undefined ? {} : { groupId }),
      });
    },
  },
  tabGroups: {
    query: (info) => chrome.tabGroups.query(info),
    update: (groupId, props) =>
      chrome.tabGroups.update(groupId, {
        ...(props.title === undefined ? {} : { title: props.title }),
        ...(props.color === "blue" ? { color: "blue" } : {}),
      }),
  },
};

const settings = new Settings(chrome.storage.local);

// `controller` is assigned below; the callbacks only run after start(), when it exists.
const bridge = new BridgeClient(
  {
    settings,
    createSocket,
    extensionVersion: chrome.runtime.getManifest().version,
  },
  {
    onMessage: (message) => void controller.onBridgeMessage(message),
    onState: (state, detail) => {
      controller.onBridgeState(state, detail);
    },
  },
);

async function tabUrl(tabId: number): Promise<string> {
  return resolveTabUrl(await chrome.tabs.get(tabId));
}

const adapter = new DebuggerAdapter(
  chrome.debugger,
  (tabId) => {
    controller.onExternalDetach(tabId);
  },
  async (tabId) => ({
    tabUrl: await tabUrl(tabId),
    fileAccess: await chrome.extension.isAllowedFileSchemeAccess(),
  }),
);

const SESSION_KEY = "connectedTabs";

const downloads = trackDownloads(chrome.downloads, (message) => {
  bridge.send(message);
});

const controller = new Controller({
  bridge,
  adapter,
  tabs: {
    get: (tabId) => chrome.tabs.get(tabId),
    create: (properties) => chrome.tabs.create(properties),
    remove: (tabId) => chrome.tabs.remove(tabId),
    update: (tabId, properties) => chrome.tabs.update(tabId, properties),
    query: (query) => chrome.tabs.query(query),
  },
  isAllowedFileSchemeAccess: () => chrome.extension.isAllowedFileSchemeAccess(),
  addToGroup: (tabId) => addToBrowserUseGroup(groupApi, tabId),
  downloads,
  preferences: {
    getAlwaysConnected: () => settings.getAlwaysConnected(),
    setAlwaysConnected: (value) => settings.setAlwaysConnected(value),
  },
  session: {
    load: async () => (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY],
    save: (tabs) => chrome.storage.session.set({ [SESSION_KEY]: tabs }),
  },
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== undefined) {
    controller.onDebuggerEvent(source.tabId, method, { ...params });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  controller.onTabRemoved(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.title !== undefined || change.url !== undefined) void controller.onTabUpdated(tabId);
});
chrome.storage.onChanged.addListener((changes, area) => {
  const change = changes[ALWAYS_CONNECTED_KEY];
  if (area === "local" && change) controller.onAlwaysConnectedChanged(change.newValue === true);
});

// Explicit connection model (spec section 10): no socket unless a tab is connected (including
// tabs adopted after a service-worker restart) or "Let the agent open tabs" is on.
const started = bridge
  .init()
  .then(() => controller.start())
  .catch(() => undefined);

chrome.runtime.onMessage.addListener((message: PopupMessage, _sender, reply) => {
  void started.then(() => controller.onPopupMessage(message)).then(reply);
  return true;
});
// Listening wakes the worker on browser start so the setting can bring the connection up.
const wake = (): void => {
  void started;
};
chrome.runtime.onStartup.addListener(wake);
chrome.runtime.onInstalled.addListener(wake);
