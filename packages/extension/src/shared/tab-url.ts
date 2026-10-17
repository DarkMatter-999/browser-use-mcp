/** Chrome reports url "" (not undefined) for a tab that is still loading its first navigation. */
export function resolveTabUrl(tab: { url?: string; pendingUrl?: string }): string {
  if (tab.url) return tab.url;
  if (tab.pendingUrl) return tab.pendingUrl;
  return "about:blank";
}
