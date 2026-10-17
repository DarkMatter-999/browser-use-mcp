import "../zod-jitless";
import type { PopupMessage, PopupReply } from "../controller";
import "./popup.css";
import { describeStatus } from "./view-model";

const POLL_MS = 500;

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found;
}

function field<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = el(id);
  if (!(found instanceof type)) throw new Error(`Element #${id} has the wrong type`);
  return found;
}

const headline = el("headline");
const detail = el("detail");
const errorBox = el("error");
const pairForm = field("pair-form", HTMLFormElement);
const codeInput = field("code", HTMLInputElement);
const connectButton = field("connect", HTMLButtonElement);
const disconnectButton = field("disconnect", HTMLButtonElement);
const disconnectAllButton = field("disconnect-all", HTMLButtonElement);

let activeTabId: number | undefined;

async function send(message: PopupMessage): Promise<PopupReply> {
  return chrome.runtime.sendMessage<PopupMessage, PopupReply>(message);
}

function setText(node: HTMLElement, text: string | undefined): void {
  node.textContent = text ?? "";
  node.hidden = text === undefined || text === "";
}

function render(reply: PopupReply): void {
  const view = describeStatus(reply);
  headline.textContent = view.headline;
  setText(detail, view.detail);
  setText(errorBox, view.error);
  pairForm.hidden = !view.showPair;
  connectButton.hidden = view.showPair;
  disconnectButton.hidden = view.showPair;
  disconnectAllButton.hidden = view.showPair;
  connectButton.disabled = !view.canConnect;
  disconnectButton.disabled = !view.canDisconnect;
  disconnectAllButton.disabled = !view.canDisconnectAll;
}

async function refresh(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTabId = tab?.id;
    render(
      await send({
        type: "get-status",
        ...(activeTabId === undefined ? {} : { tabId: activeTabId }),
      }),
    );
  } catch (error) {
    setText(errorBox, error instanceof Error ? error.message : String(error));
  }
}

async function act(message: PopupMessage): Promise<void> {
  try {
    render(await send(message));
  } catch (error) {
    setText(errorBox, error instanceof Error ? error.message : String(error));
  }
}

connectButton.addEventListener("click", () => void act({ type: "connect-active-tab" }));
disconnectButton.addEventListener("click", () => {
  if (activeTabId !== undefined) void act({ type: "disconnect-tab", tabId: activeTabId });
});
disconnectAllButton.addEventListener("click", () => void act({ type: "disconnect-all" }));
pairForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void act({ type: "pair", code: codeInput.value }).then(() => {
    codeInput.value = "";
  });
});

void refresh();
const timer = setInterval(() => void refresh(), POLL_MS);
addEventListener("pagehide", () => {
  clearInterval(timer);
});
