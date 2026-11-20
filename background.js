const openDashboard = async () => {
  const url = chrome.runtime.getURL("dashboard.html");
  const tabs = await chrome.tabs.query({ url });
  const tab = tabs[0];
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
};

chrome.action.onClicked.addListener(openDashboard);
const discover = async () => {
  try {
    if ((await chrome.storage.local.get("mcpEnabled")).mcpEnabled === false) return;
    const response = await fetch("http://127.0.0.1:17321/bootstrap", { signal: AbortSignal.timeout(2000), headers: { "X-Runner-Extension-ID": chrome.runtime.id } });
    if (!response.ok || (await chrome.storage.local.get("mcpEnabled")).mcpEnabled === false) return;
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("dashboard.html") });
    if ((await chrome.storage.local.get("mcpEnabled")).mcpEnabled === false) return;
    if (!tabs.length) await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html"), active: false });
    else await chrome.runtime.sendMessage({ type: "runner:mcp-discover" }).catch(() => {});
  } catch {}
};
const schedule = () => { chrome.alarms.create("runner-mcp-discovery", { periodInMinutes: 0.5 }); discover(); };
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "runner-mcp-discovery") discover(); });

chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.mcpEnabled && changes.mcpEnabled.newValue !== false) discover(); });
