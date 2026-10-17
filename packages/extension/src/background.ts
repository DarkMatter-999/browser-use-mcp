import "./zod-jitless.js";
import { PROTOCOL_VERSION } from "@browser-use/protocol";

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.set({ protocolVersion: PROTOCOL_VERSION });
});
