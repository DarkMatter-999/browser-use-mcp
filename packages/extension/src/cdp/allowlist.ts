export const CDP_ALLOWLIST: readonly string[] = [
  "Page.enable",
  "Page.setLifecycleEventsEnabled",
  "Page.navigate",
  "Page.reload",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.stopLoading",
  "Page.captureScreenshot",
  "Page.printToPDF",
  "Page.handleJavaScriptDialog",
  "Page.getFrameTree",
  "Page.setInterceptFileChooserDialog",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.removeScriptToEvaluateOnNewDocument",
  "Runtime.enable",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.releaseObject",
  "Console.enable",
  "Log.enable",
  "Network.enable",
  "Network.getResponseBody",
  "Network.emulateNetworkConditions",
  "Network.deleteCookies",
  "Storage.getCookies",
  "Storage.setCookies",
  "Storage.clearDataForOrigin",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.clearDeviceMetricsOverride",
  "Emulation.setGeolocationOverride",
  "Emulation.clearGeolocationOverride",
  "Emulation.setUserAgentOverride",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.describeNode",
  "DOM.getBoxModel",
  "DOM.querySelectorAll",
  "DOM.focus",
  "DOM.resolveNode",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.setFileInputFiles",
  "DOM.pushNodesByBackendIdsToFrontend",
  "DOMSnapshot.captureSnapshot",
  "Accessibility.getFullAXTree",
  "Performance.enable",
  "Performance.getMetrics",
  "Tracing.start",
  "Tracing.end",
  "IO.read",
  "IO.close",
];

const ALLOWED = new Set(CDP_ALLOWLIST);

const EVALUATE_FIELDS = new Set([
  "expression",
  "objectGroup",
  "includeCommandLineAPI",
  "silent",
  "returnByValue",
  "generatePreview",
  "userGesture",
  "awaitPromise",
  "throwOnSideEffect",
  "timeout",
  "disableBreaks",
  "replMode",
  "allowUnsafeEvalBlockedByCSP",
  "uniqueContextId",
  "contextId",
]);
const EVALUATE_BOOLEANS = [
  "includeCommandLineAPI",
  "silent",
  "returnByValue",
  "generatePreview",
  "userGesture",
  "awaitPromise",
  "throwOnSideEffect",
  "disableBreaks",
  "replMode",
  "allowUnsafeEvalBlockedByCSP",
];
const MAX_SCRIPT_CHARS = 100_000;

type Validator = (params: Record<string, unknown>) => string | undefined;

const validators: Record<string, Validator> = {
  "Runtime.evaluate": (params) => {
    if (typeof params.expression !== "string")
      return "Runtime.evaluate requires a string expression";
    if (Object.keys(params).some((key) => !EVALUATE_FIELDS.has(key))) {
      return "Runtime.evaluate accepts only supported evaluation options";
    }
    for (const key of EVALUATE_BOOLEANS) {
      if (key in params && typeof params[key] !== "boolean")
        return `Runtime.evaluate ${key} must be boolean`;
    }
    if ("timeout" in params && typeof params.timeout !== "number")
      return "Runtime.evaluate timeout must be numeric";
    if (
      ["objectGroup", "uniqueContextId"].some(
        (key) => key in params && typeof params[key] !== "string",
      ) ||
      ("contextId" in params && typeof params.contextId !== "number")
    ) {
      return "Runtime.evaluate context options have invalid types";
    }
    return undefined;
  },
  "Runtime.callFunctionOn": (params) => {
    if (typeof params.functionDeclaration !== "string") {
      return "Runtime.callFunctionOn requires a string functionDeclaration";
    }
    if (params.functionDeclaration.length > MAX_SCRIPT_CHARS) {
      return `functionDeclaration exceeds ${MAX_SCRIPT_CHARS} characters`;
    }
    if (typeof params.objectId !== "string") return "Runtime.callFunctionOn requires an objectId";
    if ("arguments" in params) {
      const args = params.arguments;
      if (
        !Array.isArray(args) ||
        args.length > 20 ||
        args.some((a) => typeof a !== "object" || a === null)
      ) {
        return "arguments must be an array of at most 20 objects";
      }
    }
    return undefined;
  },
  "DOM.setFileInputFiles": (params) => {
    const { files } = params;
    if (
      !Array.isArray(files) ||
      files.length < 1 ||
      files.length > 20 ||
      files.some((file) => typeof file !== "string" || file.length < 1 || file.length > 4096)
    ) {
      return "files must be 1-20 non-empty path strings (max 4096 chars each)";
    }
    if (!["nodeId", "backendNodeId", "objectId"].some((key) => key in params)) {
      return "DOM.setFileInputFiles needs a nodeId, backendNodeId or objectId";
    }
    return undefined;
  },
  "Page.addScriptToEvaluateOnNewDocument": (params) =>
    typeof params.source === "string" && params.source.length <= MAX_SCRIPT_CHARS
      ? undefined
      : `source must be a string of at most ${MAX_SCRIPT_CHARS} characters`,
  "Page.setInterceptFileChooserDialog": (params) =>
    typeof params.enabled === "boolean" ? undefined : "enabled must be boolean",
};

export function isAllowedMethod(method: string): boolean {
  return ALLOWED.has(method);
}

export function validateParams(
  method: string,
  params: Record<string, unknown>,
): string | undefined {
  return validators[method]?.(params);
}
