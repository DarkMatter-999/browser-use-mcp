import { EventEmitter } from "node:events";

export class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: string[] = [];
  closeCode: number | undefined;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    if (this.readyState === 3) return;
    this.closeCode = code;
    this.readyState = 3;
    this.emit("close");
  }

  receive(message: unknown): void {
    this.emit(
      "message",
      Buffer.from(typeof message === "string" ? message : JSON.stringify(message)),
    );
  }

  messages(): Record<string, unknown>[] {
    return this.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }

  last(): Record<string, unknown> | undefined {
    return this.messages().at(-1);
  }
}
