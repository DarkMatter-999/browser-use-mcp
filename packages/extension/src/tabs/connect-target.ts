interface ActiveTab {
  id?: number;
  url?: string;
  windowId?: number;
}

interface CreatedTab {
  id?: number;
}

type CreateTab = (properties: {
  url: string;
  active: true;
  windowId?: number;
}) => Promise<CreatedTab>;

const NEW_TAB_HOSTS = new Set(["newtab", "new-tab-page"]);

export async function targetTabIdForConnect(tab: ActiveTab, createTab: CreateTab): Promise<number> {
  if (tab.id === undefined) throw new Error("No active tab");
  if (!isNewTabPage(tab.url)) return tab.id;

  const created = await createTab({
    url: "about:blank",
    active: true,
    ...(tab.windowId === undefined ? {} : { windowId: tab.windowId }),
  });
  if (created.id === undefined) {
    throw new Error("Chrome did not return an ID for the blank tab");
  }
  return created.id;
}

function isNewTabPage(value?: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "chrome:" || url.protocol === "brave:") && NEW_TAB_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}
