import { type JsonObject, type PendingDialog, pendingDialogSchema } from "@browser-use/protocol";

export class DialogTracker {
  readonly #byTab = new Map<number, PendingDialog>();

  onEvent(tabId: number, method: string, params: JsonObject): boolean {
    if (method === "Page.javascriptDialogOpening") {
      const parsed = pendingDialogSchema.safeParse({
        type: params.type,
        message: params.message ?? "",
        url: params.url ?? "",
        ...(typeof params.defaultPrompt === "string"
          ? { defaultPrompt: params.defaultPrompt }
          : {}),
      });
      if (!parsed.success) return false;
      this.#byTab.set(tabId, parsed.data);
      return true;
    }
    if (method === "Page.javascriptDialogClosed") return this.#byTab.delete(tabId);
    return false;
  }

  get(tabId: number): PendingDialog | undefined {
    return this.#byTab.get(tabId);
  }

  clear(tabId: number): void {
    this.#byTab.delete(tabId);
  }
}
