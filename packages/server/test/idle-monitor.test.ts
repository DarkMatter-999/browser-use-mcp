import { describe, expect, it, vi } from "vitest";
import { IdleMonitor } from "../src/daemon/idle-monitor";

describe("IdleMonitor", () => {
  it("fires onIdle only after idleMs of continuous idleness", () => {
    let now = 0;
    let busy = true;
    const onIdle = vi.fn();
    const monitor = new IdleMonitor({ idleMs: 1000, isBusy: () => busy, onIdle, now: () => now });
    now = 500;
    monitor.tick(); // busy: idle clock starts at 500
    busy = false;
    now = 900;
    monitor.tick();
    now = 1500;
    monitor.tick(); // exactly 1000ms idle: not yet
    expect(onIdle).not.toHaveBeenCalled();
    now = 1501;
    monitor.tick();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("busy activity resets the idle clock", () => {
    let now = 0;
    let busy = false;
    const onIdle = vi.fn();
    const monitor = new IdleMonitor({ idleMs: 1000, isBusy: () => busy, onIdle, now: () => now });
    now = 900;
    monitor.tick();
    busy = true;
    now = 950;
    monitor.tick();
    busy = false;
    now = 1900;
    monitor.tick();
    expect(onIdle).not.toHaveBeenCalled();
  });
});
