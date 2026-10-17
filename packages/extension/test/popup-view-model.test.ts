import { describe, expect, it } from "vitest";
import { describeStatus } from "../src/popup/view-model";

const base = { bridge: "ready", state: "disconnected", connectedCount: 0 } as const;

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
  });

  it("offers Disconnect for a connected tab and Disconnect all when any are connected", () => {
    const view = describeStatus({ ...base, state: "connected", connectedCount: 2 });
    expect(view).toMatchObject({ canConnect: false, canDisconnect: true, canDisconnectAll: true });
    expect(view.detail).toMatch(/2 tabs/);
  });

  it("explains connectivity problems and disables Connect", () => {
    for (const bridge of ["connecting", "backoff", "error", "idle"] as const) {
      const view = describeStatus({ ...base, bridge });
      expect(view.canConnect).toBe(false);
      expect(view.headline.length).toBeGreaterThan(0);
    }
  });

  it("surfaces an error message", () => {
    expect(describeStatus({ ...base, state: "error", error: "restricted" }).error).toBe(
      "restricted",
    );
  });
});
