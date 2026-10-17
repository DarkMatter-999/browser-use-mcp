import type { BridgeState } from "../bridge/client";
import type { PopupReply } from "../controller";

export interface StatusView {
  headline: string;
  detail?: string;
  error?: string;
  showPair: boolean;
  canConnect: boolean;
  canDisconnect: boolean;
  canDisconnectAll: boolean;
}

const HEADLINES: Record<BridgeState, string> = {
  idle: "Starting…",
  unpaired: "Not paired",
  connecting: "Connecting to the local server…",
  ready: "Connected to the local server",
  backoff: "Local server not reachable",
  error: "Cannot talk to the local server",
};

function describeDetail(reply: PopupReply): string | undefined {
  if (reply.connectedCount > 0) {
    return `${reply.connectedCount} ${reply.connectedCount === 1 ? "tab" : "tabs"} connected`;
  }
  if (reply.bridge === "backoff") {
    return "Start your MCP client (it launches the local server automatically).";
  }
  if (reply.bridge === "unpaired") {
    return "Run `browser-use-mcp pair` and enter the code below.";
  }
  return reply.bridgeDetail;
}

export function describeStatus(reply: PopupReply): StatusView {
  const ready = reply.bridge === "ready";
  const detail = describeDetail(reply);
  return {
    headline: HEADLINES[reply.bridge],
    ...(detail === undefined ? {} : { detail }),
    ...(reply.error === undefined ? {} : { error: reply.error }),
    showPair: reply.bridge === "unpaired",
    canConnect: ready && reply.state !== "connected" && reply.state !== "connecting",
    canDisconnect: reply.state === "connected" || reply.state === "connecting",
    canDisconnectAll: reply.connectedCount > 0,
  };
}
