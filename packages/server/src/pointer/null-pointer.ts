import type { Pointer } from "./types";

const done = (): Promise<void> => Promise.resolve();

export class NullPointer implements Pointer {
  readonly enabled = false;

  ensureInstalled(): Promise<void> {
    return done();
  }

  moveTo(): Promise<void> {
    return done();
  }

  hideForCapture(): Promise<() => Promise<void>> {
    return Promise.resolve(done);
  }
}
