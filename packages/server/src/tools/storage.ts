import { BrowserUseError, type JsonValue } from "@browser-use/protocol";
import { z } from "zod";
import type { ToolContext } from "../mcp/context";
import { defineTool } from "../mcp/define-tool";
import { jsonResult } from "../mcp/format";
import { evaluate } from "./evaluate";
import { asObject, requireTab, tabIdField } from "./schema";

const cookieShape = {
  tabId: tabIdField,
  operation: z.enum(["get", "set", "delete", "clear"]),
  domain: z.string().min(1).max(253),
  path: z.string().min(1).max(1024),
  name: z.string().min(1).max(4096).optional(),
  value: z.string().max(4096).optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
};
const storageShape = {
  tabId: tabIdField,
  storage: z.enum(["local", "session"]),
  operation: z.enum(["get", "set", "delete", "clear"]),
  key: z.string().max(4096).optional(),
  value: z.string().max(65_536).optional(),
};
const cookieArgs = z.object({
  ...cookieShape,
  domain: z
    .string()
    .min(1)
    .max(253)
    .regex(/^\.?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i),
  path: z.string().min(1).max(1024).startsWith("/"),
});
const storageArgs = z.object(storageShape);

export interface CookieSummary {
  name?: string;
  domain?: string;
  path?: string;
  expires?: number;
  size?: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 4096) : undefined;
}

function matchingCookies(
  cookies: JsonValue[],
  domain: string,
  path: string,
): Record<string, unknown>[] {
  return cookies
    .map(asObject)
    .filter(
      (cookie) =>
        typeof cookie.domain === "string" &&
        cookie.domain.replace(/^\./, "").toLowerCase() === domain &&
        cookie.path === path,
    )
    .slice(0, 100);
}

export async function browserCookies(
  ctx: ToolContext,
  input: z.input<typeof cookieArgs>,
): Promise<Record<string, unknown>> {
  const args = cookieArgs.parse(input);
  requireTab(ctx, args.tabId);
  const tab = ctx.listTabs().find((item) => item.tabId === args.tabId);
  const domain = args.domain.replace(/^\./, "").toLowerCase();
  const host = new URL(tab?.url ?? "about:blank").hostname.toLowerCase();
  if (host !== domain && !host.endsWith(`.${domain}`)) {
    throw new BrowserUseError("INVALID_ARGUMENT", "Domain must match the connected tab", {
      hint: `The tab's host is ${host}.`,
    });
  }
  if (args.operation === "get" || args.operation === "clear") {
    const result = asObject(await ctx.sendCommand(args.tabId, "Storage.getCookies", {}));
    const matches = matchingCookies(
      Array.isArray(result.cookies) ? result.cookies : [],
      domain,
      args.path,
    );
    if (args.operation === "get") {
      return {
        cookies: matches.map((cookie): CookieSummary => ({
          name: safeString(cookie.name),
          domain: safeString(cookie.domain),
          path: safeString(cookie.path),
          expires: typeof cookie.expires === "number" ? cookie.expires : undefined,
          size: typeof cookie.size === "number" ? cookie.size : undefined,
          httpOnly: cookie.httpOnly === true,
          secure: cookie.secure === true,
          session: cookie.session === true,
          sameSite: safeString(cookie.sameSite),
        })),
      };
    }
    for (const cookie of matches) {
      if (typeof cookie.name === "string") {
        await ctx.sendCommand(args.tabId, "Network.deleteCookies", {
          name: cookie.name,
          domain: typeof cookie.domain === "string" ? cookie.domain : domain,
          path: typeof cookie.path === "string" ? cookie.path : args.path,
        });
      }
    }
    return { tabId: args.tabId, cleared: matches.length };
  }
  if (!args.name) {
    throw new BrowserUseError("INVALID_ARGUMENT", "name is required for this cookie operation");
  }
  if (args.operation === "set") {
    await ctx.sendCommand(args.tabId, "Storage.setCookies", {
      cookies: [
        {
          name: args.name,
          value: args.value ?? "",
          domain: args.domain,
          path: args.path,
          ...(args.secure === undefined ? {} : { secure: args.secure }),
          ...(args.httpOnly === undefined ? {} : { httpOnly: args.httpOnly }),
          ...(args.sameSite ? { sameSite: args.sameSite } : {}),
        },
      ],
    });
  } else {
    await ctx.sendCommand(args.tabId, "Network.deleteCookies", {
      name: args.name,
      domain: args.domain,
      path: args.path,
    });
  }
  return { tabId: args.tabId, operation: args.operation, name: args.name, changed: true };
}

export async function browserStorage(
  ctx: ToolContext,
  input: z.input<typeof storageArgs>,
): Promise<Record<string, unknown>> {
  const args = storageArgs.parse(input);
  requireTab(ctx, args.tabId);
  if ((args.operation === "set" || args.operation === "delete") && args.key === undefined) {
    throw new BrowserUseError("INVALID_ARGUMENT", "key is required");
  }
  if (args.operation === "set" && args.value === undefined) {
    throw new BrowserUseError("INVALID_ARGUMENT", "value is required");
  }
  const expression = `(() => { const s = window[${JSON.stringify(`${args.storage}Storage`)}]; const op = ${JSON.stringify(args.operation)}; const key = ${JSON.stringify(args.key ?? null)}; const value = ${JSON.stringify(args.value ?? null)}; if (op === "get") { const storage = {}; let bytes = 2; let truncated = s.length > 500; for (let i = 0; i < Math.min(s.length, 500); i++) { const k = s.key(i); if (k === null) continue; const v = s.getItem(k); const item = JSON.stringify(k) + ":" + JSON.stringify(v); const itemBytes = new TextEncoder().encode(item).length + (Object.keys(storage).length ? 1 : 0); if (bytes + itemBytes > 48 * 1024) { truncated = true; break; } storage[k] = v; bytes += itemBytes; } return { storage, truncated }; } if (op === "set") s.setItem(key, value); else if (op === "delete") s.removeItem(key); else s.clear(); return null; })()`;
  const result = await evaluate(ctx, {
    tabId: args.tabId,
    expression,
    awaitPromise: true,
    timeoutMs: 10_000,
  });
  const raw = result.value;
  const pageResult =
    args.operation === "get" &&
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "storage" in raw &&
    "truncated" in raw
      ? raw
      : undefined;
  const value = pageResult?.storage ?? raw;
  const serialized = JSON.stringify(value);
  if (serialized && Buffer.byteLength(serialized) > 65_536) {
    return {
      tabId: args.tabId,
      storage: args.storage,
      operation: args.operation,
      value: "[omitted: output limit exceeded]",
      truncated: true,
    };
  }
  return {
    tabId: args.tabId,
    storage: args.storage,
    operation: args.operation,
    ...(args.operation === "get" ? { value } : { changed: true }),
    ...(pageResult?.truncated ? { truncated: true } : {}),
  };
}

export const storageTools = [
  defineTool({
    name: "browser_cookies",
    title: "Cookies",
    description:
      "Inspect or modify bounded cookie metadata for the connected tab; cookie values are never returned.",
    inputShape: cookieShape,
    handler: async (ctx, args) => jsonResult(await browserCookies(ctx, args)),
  }),
  defineTool({
    name: "browser_storage",
    title: "Web storage",
    description:
      "Inspect or modify local/session storage in the connected page with bounded results.",
    inputShape: storageShape,
    handler: async (ctx, args) => jsonResult(await browserStorage(ctx, args)),
  }),
];
