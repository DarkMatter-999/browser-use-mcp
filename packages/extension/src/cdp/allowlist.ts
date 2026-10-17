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
  "Network.getCookies",
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

const MAX_EXPRESSION_CHARS = 1_000_000;
const MAX_TEXT_CHARS = 100_000;
const MAX_SELECTOR_CHARS = 10_000;
const MAX_ID_CHARS = 1_024;

/** What the extension knows about the tab a command targets; needed by the URL-scoped methods. */
export interface ValidationContext {
  /** The tab's committed URL. */
  tabUrl: string;
  /** Whether the user has enabled "Allow access to file URLs" for the extension. */
  fileAccess: boolean;
}

type Validator = (
  params: Record<string, unknown>,
  context: ValidationContext | undefined,
) => string | undefined;

type FieldCheck = (value: unknown) => boolean;

const bool: FieldCheck = (v) => typeof v === "boolean";
const num: FieldCheck = (v) => typeof v === "number" && Number.isFinite(v);
const int: FieldCheck = (v) => Number.isInteger(v);
const nodeId: FieldCheck = (v) => Number.isInteger(v) && (v as number) >= 0;
const str =
  (max = MAX_ID_CHARS): FieldCheck =>
  (v) =>
    typeof v === "string" && v.length <= max;
const range =
  (min: number, max: number): FieldCheck =>
  (v) =>
    num(v) && (v as number) >= min && (v as number) <= max;
const oneOf =
  (...values: string[]): FieldCheck =>
  (v) =>
    typeof v === "string" && values.includes(v);
const plainObject: FieldCheck = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const stringList =
  (maxItems: number, maxChars = MAX_ID_CHARS): FieldCheck =>
  (v) =>
    Array.isArray(v) &&
    v.length <= maxItems &&
    v.every((item) => typeof item === "string" && item.length <= maxChars);

/**
 * Builds a validator that accepts only the listed fields (each type-checked) and requires
 * `required`. Unknown fields are rejected so new CDP options cannot be smuggled through.
 */
function shape(
  method: string,
  fields: Record<string, FieldCheck>,
  required: readonly string[] = [],
): Validator {
  return (params) => {
    for (const key of required) {
      if (!(key in params)) return `${method} requires ${key}`;
    }
    for (const [key, value] of Object.entries(params)) {
      const check = fields[key];
      if (!check) return `${method} does not accept ${key}`;
      if (!check(value)) return `${method} ${key} has an invalid value`;
    }
    return undefined;
  };
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function tabHost(context: ValidationContext | undefined): string | undefined {
  if (!context) return undefined;
  try {
    const url = new URL(context.tabUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.hostname.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

/** A cookie domain is in scope when it is the tab's host or a parent domain of it (never a bare TLD). */
function cookieDomainInScope(domain: unknown, context: ValidationContext | undefined): boolean {
  const host = tabHost(context);
  if (host === undefined || typeof domain !== "string") return false;
  const wanted = domain.replace(/^\./, "").toLowerCase();
  if (wanted === host) return true;
  if (IPV4.test(host) || host.startsWith("[")) return false;
  return wanted.includes(".") && host.endsWith(`.${wanted}`);
}

function cookieUrlInScope(value: unknown, context: ValidationContext | undefined): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      cookieDomainInScope(url.hostname, context)
    );
  } catch {
    return false;
  }
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function navigableUrl(value: unknown, context: ValidationContext | undefined): boolean {
  if (typeof value !== "string" || value.length > 8_192) return false;
  if (value === "about:blank") return true;
  try {
    const { protocol } = new URL(value);
    if (protocol === "http:" || protocol === "https:") return true;
    return protocol === "file:" && context?.fileAccess === true;
  } catch {
    return false;
  }
}

const COOKIE_SCOPE_ERROR = "Cookies are limited to the connected tab's site";

const COOKIE_FIELDS: Record<string, FieldCheck> = {
  name: str(4_096),
  value: str(4_096),
  url: str(8_192),
  domain: str(253),
  path: str(1_024),
  secure: bool,
  httpOnly: bool,
  sameSite: oneOf("Strict", "Lax", "None"),
  expires: num,
  priority: oneOf("Low", "Medium", "High"),
};
const cookieShape = shape("Storage.setCookies cookie", COOKIE_FIELDS, ["name", "value"]);

/** Validators for methods whose parameters depend on the tab (URL scope, file access). */
const contextual: Record<string, Validator> = {
  "Page.navigate": (params, context) => {
    const invalid = shape(
      "Page.navigate",
      {
        url: str(8_192),
        referrer: str(8_192),
        transitionType: str(64),
        frameId: str(),
        referrerPolicy: str(64),
      },
      ["url"],
    )(params, context);
    if (invalid) return invalid;
    if (!navigableUrl(params.url, context)) {
      return context?.fileAccess === true
        ? "Page.navigate accepts only http, https, file and about:blank URLs"
        : "Page.navigate accepts only http, https and about:blank URLs";
    }
    if ("referrer" in params && params.referrer !== "" && !isHttpUrl(params.referrer)) {
      return "Page.navigate referrer must be an http(s) URL";
    }
    return undefined;
  },
  "Network.getCookies": (params, context) => {
    const { urls } = params;
    if (
      Object.keys(params).some((key) => key !== "urls") ||
      !Array.isArray(urls) ||
      urls.length < 1 ||
      urls.length > 10
    ) {
      return "Network.getCookies requires 1-10 urls";
    }
    return urls.every((url) => cookieUrlInScope(url, context)) ? undefined : COOKIE_SCOPE_ERROR;
  },
  "Network.deleteCookies": (params, context) => {
    const invalid = shape(
      "Network.deleteCookies",
      { name: str(4_096), url: str(8_192), domain: str(253), path: str(1_024) },
      ["name"],
    )(params, context);
    if (invalid) return invalid;
    if (!("domain" in params) && !("url" in params)) {
      return "Network.deleteCookies requires a domain or url";
    }
    if ("domain" in params && !cookieDomainInScope(params.domain, context))
      return COOKIE_SCOPE_ERROR;
    if ("url" in params && !cookieUrlInScope(params.url, context)) return COOKIE_SCOPE_ERROR;
    return undefined;
  },
  "Storage.setCookies": (params, context) => {
    const { cookies } = params;
    if (
      Object.keys(params).some((key) => key !== "cookies") ||
      !Array.isArray(cookies) ||
      cookies.length < 1 ||
      cookies.length > 50
    ) {
      return "Storage.setCookies requires 1-50 cookies";
    }
    for (const cookie of cookies) {
      if (!plainObject(cookie)) return "Storage.setCookies cookies must be objects";
      const record = cookie as Record<string, unknown>;
      const invalid = cookieShape(record, context);
      if (invalid) return invalid;
      if (!("domain" in record) && !("url" in record)) {
        return "Storage.setCookies cookies need a domain or url";
      }
      if ("domain" in record && !cookieDomainInScope(record.domain, context)) {
        return COOKIE_SCOPE_ERROR;
      }
      if ("url" in record && !cookieUrlInScope(record.url, context)) return COOKIE_SCOPE_ERROR;
    }
    return undefined;
  },
  "Storage.clearDataForOrigin": (params, context) => {
    const invalid = shape(
      "Storage.clearDataForOrigin",
      { origin: str(8_192), storageTypes: str(1_024) },
      ["origin", "storageTypes"],
    )(params, context);
    if (invalid) return invalid;
    let tabOrigin: string | undefined;
    try {
      tabOrigin =
        tabHost(context) === undefined ? undefined : new URL(context?.tabUrl ?? "").origin;
    } catch {
      tabOrigin = undefined;
    }
    return tabOrigin !== undefined && params.origin === tabOrigin
      ? undefined
      : "Storage.clearDataForOrigin is limited to the connected tab's origin";
  },
};

const MOUSE_TYPES = ["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"];
const KEY_TYPES = ["keyDown", "keyUp", "rawKeyDown", "char"];
const NODE_TARGET = { nodeId, backendNodeId: nodeId, objectId: str() };

/** Methods the daemon only ever calls without parameters. */
const PARAMETERLESS = [
  "Page.enable",
  "Page.getNavigationHistory",
  "Page.stopLoading",
  "Page.getFrameTree",
  "Runtime.enable",
  "Console.enable",
  "Log.enable",
  "Network.enable",
  "DOM.enable",
  "Performance.enable",
  "Performance.getMetrics",
  "Emulation.clearDeviceMetricsOverride",
  "Emulation.clearGeolocationOverride",
  "Tracing.end",
];

const validators: Record<string, Validator> = {
  ...Object.fromEntries(PARAMETERLESS.map((method) => [method, shape(method, {})])),
  "Runtime.evaluate": (params) => {
    if (typeof params.expression !== "string")
      return "Runtime.evaluate requires a string expression";
    if (params.expression.length > MAX_EXPRESSION_CHARS) {
      return `expression exceeds ${MAX_EXPRESSION_CHARS} characters`;
    }
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
  "Page.setLifecycleEventsEnabled": shape("Page.setLifecycleEventsEnabled", { enabled: bool }, [
    "enabled",
  ]),
  "Page.reload": shape("Page.reload", { ignoreCache: bool }),
  "Page.navigateToHistoryEntry": shape("Page.navigateToHistoryEntry", { entryId: int }, [
    "entryId",
  ]),
  "Page.handleJavaScriptDialog": shape(
    "Page.handleJavaScriptDialog",
    { accept: bool, promptText: str(MAX_TEXT_CHARS) },
    ["accept"],
  ),
  "Page.captureScreenshot": shape("Page.captureScreenshot", {
    format: oneOf("png", "jpeg", "webp"),
    quality: range(0, 100),
    clip: plainObject,
    fromSurface: bool,
    captureBeyondViewport: bool,
    optimizeForSpeed: bool,
  }),
  "Page.printToPDF": shape("Page.printToPDF", {
    landscape: bool,
    printBackground: bool,
    displayHeaderFooter: bool,
    scale: range(0.1, 2),
    paperWidth: num,
    paperHeight: num,
    preferCSSPageSize: bool,
    transferMode: oneOf("ReturnAsBase64", "ReturnAsStream"),
  }),
  "Page.removeScriptToEvaluateOnNewDocument": shape(
    "Page.removeScriptToEvaluateOnNewDocument",
    { identifier: str() },
    ["identifier"],
  ),
  "Runtime.releaseObject": shape("Runtime.releaseObject", { objectId: str() }, ["objectId"]),
  "Network.getResponseBody": shape("Network.getResponseBody", { requestId: str() }, ["requestId"]),
  "Network.emulateNetworkConditions": shape("Network.emulateNetworkConditions", {
    offline: bool,
    latency: range(0, 600_000),
    downloadThroughput: range(-1, 1e12),
    uploadThroughput: range(-1, 1e12),
  }),
  "Emulation.setDeviceMetricsOverride": shape(
    "Emulation.setDeviceMetricsOverride",
    {
      width: range(0, 10_000_000),
      height: range(0, 10_000_000),
      deviceScaleFactor: range(0, 100),
      mobile: bool,
    },
    ["width", "height", "deviceScaleFactor", "mobile"],
  ),
  "Emulation.setGeolocationOverride": shape("Emulation.setGeolocationOverride", {
    latitude: range(-90, 90),
    longitude: range(-180, 180),
    accuracy: range(0, 1e9),
  }),
  "Emulation.setUserAgentOverride": shape(
    "Emulation.setUserAgentOverride",
    { userAgent: str(), acceptLanguage: str(), platform: str() },
    ["userAgent"],
  ),
  "Input.dispatchMouseEvent": shape(
    "Input.dispatchMouseEvent",
    {
      type: oneOf(...MOUSE_TYPES),
      x: num,
      y: num,
      modifiers: int,
      button: oneOf("none", "left", "middle", "right", "back", "forward"),
      buttons: int,
      clickCount: int,
      deltaX: num,
      deltaY: num,
    },
    ["type", "x", "y"],
  ),
  "Input.dispatchKeyEvent": shape(
    "Input.dispatchKeyEvent",
    {
      type: oneOf(...KEY_TYPES),
      modifiers: int,
      key: str(),
      code: str(),
      text: str(),
      unmodifiedText: str(),
      windowsVirtualKeyCode: int,
      nativeVirtualKeyCode: int,
      autoRepeat: bool,
      isKeypad: bool,
    },
    ["type"],
  ),
  "Input.insertText": shape("Input.insertText", { text: str(MAX_TEXT_CHARS) }, ["text"]),
  "DOM.getDocument": shape("DOM.getDocument", { depth: int, pierce: bool }),
  "DOM.querySelector": shape("DOM.querySelector", { nodeId, selector: str(MAX_SELECTOR_CHARS) }, [
    "nodeId",
    "selector",
  ]),
  "DOM.querySelectorAll": shape(
    "DOM.querySelectorAll",
    { nodeId, selector: str(MAX_SELECTOR_CHARS) },
    ["nodeId", "selector"],
  ),
  "DOM.describeNode": shape("DOM.describeNode", { ...NODE_TARGET, depth: int, pierce: bool }),
  "DOM.getBoxModel": shape("DOM.getBoxModel", NODE_TARGET),
  "DOM.focus": shape("DOM.focus", NODE_TARGET),
  "DOM.resolveNode": shape("DOM.resolveNode", {
    nodeId,
    backendNodeId: nodeId,
    objectGroup: str(),
    executionContextId: int,
  }),
  "DOM.scrollIntoViewIfNeeded": shape("DOM.scrollIntoViewIfNeeded", {
    ...NODE_TARGET,
    rect: plainObject,
  }),
  "DOM.pushNodesByBackendIdsToFrontend": shape(
    "DOM.pushNodesByBackendIdsToFrontend",
    {
      backendNodeIds: (v) => Array.isArray(v) && v.length <= 10_000 && v.every((id) => nodeId(id)),
    },
    ["backendNodeIds"],
  ),
  "DOMSnapshot.captureSnapshot": shape(
    "DOMSnapshot.captureSnapshot",
    {
      computedStyles: stringList(100, 128),
      includePaintOrder: bool,
      includeDOMRects: bool,
      includeBlendedBackgroundColors: bool,
      includeTextColorOpacities: bool,
    },
    ["computedStyles"],
  ),
  "Accessibility.getFullAXTree": shape("Accessibility.getFullAXTree", {
    depth: int,
    frameId: str(),
  }),
  "Tracing.start": shape("Tracing.start", {
    categories: str(MAX_SELECTOR_CHARS),
    transferMode: oneOf("ReportEvents", "ReturnAsStream"),
    bufferUsageReportingInterval: range(0, 3_600_000),
    traceConfig: plainObject,
  }),
  "IO.read": shape("IO.read", { handle: str(), offset: int, size: int }, ["handle"]),
  "IO.close": shape("IO.close", { handle: str() }, ["handle"]),
  ...contextual,
};

/** Methods whose validation needs the tab's URL or file-access setting. */
export function needsContext(method: string): boolean {
  return method in contextual;
}

export function isAllowedMethod(method: string): boolean {
  return ALLOWED.has(method);
}

/**
 * Per-method parameter validation. URL-scoped methods (see `needsContext`) fail closed when no
 * context is given.
 */
export function validateParams(
  method: string,
  params: Record<string, unknown>,
  context?: ValidationContext,
): string | undefined {
  if (needsContext(method) && context === undefined) {
    return `${method} needs the tab's URL to be validated`;
  }
  return validators[method]?.(params, context);
}
