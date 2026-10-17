import "./zod-jitless";
import { BridgeClient, type SocketLike } from "./bridge/client";
import { Settings } from "./bridge/settings";
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

// `controller` is assigned below; the callbacks only run after start(), when it exists.
const bridge = new BridgeClient(
  {
    settings: new Settings(chrome.storage.local),
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

const adapter = new DebuggerAdapter(chrome.debugger, (tabId) => {
  controller.onExternalDetach(tabId);
});

const controller = new Controller({
  bridge,
  adapter,
  tabs: {
    get: (tabId) => chrome.tabs.get(tabId),
    create: (properties) => chrome.tabs.create(properties),
    remove: (tabId) => chrome.tabs.remove(tabId),
    query: (query) => chrome.tabs.query(query),
  },
  isAllowedFileSchemeAccess: () => chrome.extension.isAllowedFileSchemeAccess(),
  addToGroup: (tabId) => addToBrowserUseGroup(groupApi, tabId),
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
chrome.runtime.onMessage.addListener((message: PopupMessage, _sender, reply) => {
  void controller.onPopupMessage(message).then(reply);
  return true;
});
trackDownloads(chrome.downloads, (message) => {
  bridge.send(message);
});
chrome.runtime.onStartup.addListener(() => void bridge.start());
chrome.runtime.onInstalled.addListener(() => void bridge.start());
void bridge.start();
