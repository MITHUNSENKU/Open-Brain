// Extension background service worker
// Handles popup checks, tab spawning, and legacy relay.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // Status check from popup
  if (request.type === "BRIDGE_PING") {
    fetch("http://localhost:3000/info")
      .then(res => res.json())
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // async
  }

  // Registration relay
  if (request.type === "BRIDGE_REGISTER") {
    fetch("http://localhost:3000/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: request.url })
    }).catch(() => {});
    return;
  }

  // Open a new AI tab (sent from content.js when backend requests it)
  if (request.type === "OPEN_TAB") {
    chrome.tabs.create({ url: request.url, active: false }, (tab) => {
      console.log(`[Open Brain] Opened new tab #${tab.id} → ${request.url}`);
      sendResponse({ ok: true, tabId: tab.id });
    });
    return true; // async
  }

});
