import { describe, expect, it } from "vitest";
import type { BridgeState } from "../src/bridge/client";
import { describeStatus } from "../src/popup/view-model";

const base = {
  bridge: "ready",
  state: "disconnected",
  connectedCount: 0,
  alwaysConnected: false,
} as const;

describe("describeStatus", () => {
  it("asks for pairing when unpaired and hides tab controls", () => {
    const view = describeStatus({ ...base, bridge: "unpaired" });
    expect(view.showPair).toBe(true);
    expect(view.canConnect).toBe(false);
    expect(view.headline).toMatch(/not paired/i);
  });

  it("offers Connect when ready and the tab is not connected", () => {
    const view = describeStatus(base);
    expect(view).toMatchObject({ showPair: false, canConnect: true, canDisconnect: false });
    expect(view.headline).toBe("Connected");
    expect(view.tone).toBe("ok");
  });

  it("offers Disconnect for a connected tab and Disconnect all when any are connected", () => {
    const view = describeStatus({ ...base, state: "connected", connectedCount: 2 });
    expect(view).toMatchObject({ canConnect: false, canDisconnect: true, canDisconnectAll: true });
    expect(view.detail).toMatch(/2 tabs/);
  });

  it("shows off as a neutral resting state, not an error, and still offers Connect", () => {
    const view = describeStatus({ ...base, bridge: "off" });
    expect(view.headline).toBe("Off — no tabs connected");
    expect(view.tone).toBe("neutral");
    expect(view.error).toBeUndefined();
    expect(view.headline).not.toMatch(/not reachable/i);
    expect(view.detail).toMatch(/connect a tab/i);
    expect(view.canConnect).toBe(true);
  });

  it("says another browser is connected for inUse and lets Connect retry", () => {
    const view = describeStatus({ ...base, bridge: "inUse" });
    expect(view.headline).toBe("Another browser is connected to Browser Use");
    expect(view.tone).toBe("warn");
    expect(view.detail).toMatch(/30 seconds/);
    expect(view.canConnect).toBe(true);
  });

  it("reports the server as unreachable only for backoff (a wanted connection that failed)", () => {
    const states: BridgeState[] = ["idle", "off", "unpaired", "connecting", "ready", "inUse"];
    for (const bridge of states) {
      expect(describeStatus({ ...base, bridge }).headline).not.toMatch(/not reachable/i);
    }
    const view = describeStatus({ ...base, bridge: "backoff" });
    expect(view.headline).toBe("Local server not reachable");
    expect(view.tone).toBe("error");
  });

  const busy: BridgeState[] = ["connecting", "idle"];
  it.each(busy)("disables Connect while %s", (bridge) => {
    const view = describeStatus({ ...base, bridge });
    expect(view.canConnect).toBe(false);
    expect(view.headline.length).toBeGreaterThan(0);
  });

  it("mirrors the alwaysConnected setting and explains the idle ready state", () => {
    const view = describeStatus({ ...base, alwaysConnected: true });
    expect(view.alwaysConnected).toBe(true);
    expect(view.detail).toMatch(/agent to open a tab/i);
    expect(describeStatus(base).alwaysConnected).toBe(false);
  });

  it("surfaces an error message", () => {
    expect(describeStatus({ ...base, state: "error", error: "restricted" }).error).toBe(
      "restricted",
    );
  });
});
