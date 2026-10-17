import type { BridgeState } from "../bridge/client";
import type { PopupReply } from "../controller";

export type StatusTone = "neutral" | "ok" | "warn" | "error";

export interface StatusView {
  headline: string;
  /** Styling only: "off" is a normal resting state, never an error. */
  tone: StatusTone;
  detail?: string;
  error?: string;
  showPair: boolean;
  canConnect: boolean;
  canDisconnect: boolean;
  canDisconnectAll: boolean;
  alwaysConnected: boolean;
}

const HEADLINES: Record<BridgeState, string> = {
  idle: "Starting…",
  off: "Off — no tabs connected",
  unpaired: "Not paired",
  connecting: "Connecting to the local server…",
  ready: "Connected",
  // Only reachable while a connection is wanted (a connected tab or "Let the agent open tabs").
  backoff: "Local server not reachable",
  inUse: "Another browser is connected to Browser Use",
  error: "Cannot talk to the local server",
};

const TONES: Record<BridgeState, StatusTone> = {
  idle: "neutral",
  off: "neutral",
  unpaired: "warn",
  connecting: "neutral",
  ready: "ok",
  backoff: "error",
  inUse: "warn",
  error: "error",
};

function describeDetail(reply: PopupReply): string | undefined {
  if (reply.connectedCount > 0) {
    return `${reply.connectedCount} ${reply.connectedCount === 1 ? "tab" : "tabs"} connected`;
  }
  switch (reply.bridge) {
    case "off":
      return "Connect a tab to start. The agent can't open tabs until you do.";
    case "ready":
      return reply.alwaysConnected ? "Waiting for the agent to open a tab." : reply.bridgeDetail;
    case "backoff":
      return "Start your MCP client (it launches the local server automatically).";
    case "inUse":
      return "Disconnect its tabs or close it to use this browser. Retrying every 30 seconds.";
    default:
      return reply.bridgeDetail;
  }
}

export function describeStatus(reply: PopupReply): StatusView {
  const detail = describeDetail(reply);
  const tabBusy = reply.state === "connected" || reply.state === "connecting";
  // Connect also brings the connection up (from off) or retries it now (backoff, inUse, error).
  const bridgeUsable = reply.bridge !== "unpaired" && reply.bridge !== "idle";
  return {
    headline: HEADLINES[reply.bridge],
    tone: TONES[reply.bridge],
    ...(detail === undefined ? {} : { detail }),
    ...(reply.error === undefined ? {} : { error: reply.error }),
    showPair: reply.bridge === "unpaired",
    canConnect: bridgeUsable && reply.bridge !== "connecting" && !tabBusy,
    canDisconnect: tabBusy,
    canDisconnectAll: reply.connectedCount > 0,
    alwaysConnected: reply.alwaysConnected,
  };
}
