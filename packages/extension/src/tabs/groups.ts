export const GROUP_TITLE = "Browser Use";

export interface GroupApi {
  tabs: {
    get(tabId: number): Promise<{ windowId: number }>;
    group(options: { tabIds: number[]; groupId?: number }): Promise<number>;
  };
  tabGroups: {
    query(info: { title?: string; windowId?: number }): Promise<{ id: number }[]>;
    update(groupId: number, props: { title?: string; color?: string }): Promise<unknown>;
  };
}

export async function addToBrowserUseGroup(api: GroupApi, tabId: number): Promise<void> {
  const { windowId } = await api.tabs.get(tabId);
  const [existing] = await api.tabGroups.query({ title: GROUP_TITLE, windowId });
  if (existing) {
    await api.tabs.group({ tabIds: [tabId], groupId: existing.id });
    return;
  }
  const groupId = await api.tabs.group({ tabIds: [tabId] });
  await api.tabGroups.update(groupId, { title: GROUP_TITLE, color: "blue" });
}
