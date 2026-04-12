// Extension background service worker
// Handles popup checks and legacy relay; main agentic loop is in content.js via WebSocket.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // Status check from popup
  if (request.type === "BRIDGE_PING") {
    fetch("http://localhost:3000/info")
      .then(res => res.json())
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // async
  }

  // Registration relay (content.js calls this directly, but kept for safety)
  if (request.type === "BRIDGE_REGISTER") {
    fetch("http://localhost:3000/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: request.url })
    }).catch(() => {});
    return;
  }

});
