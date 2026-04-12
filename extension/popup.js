const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const toolCountEl = document.getElementById('tool-count');

function checkBackend() {
  statusEl.textContent = 'Checking...';
  statusEl.className = 'checking';
  logEl.textContent = '';
  toolCountEl.textContent = '';

  fetch('http://localhost:3000/info')
    .then(res => res.json())
    .then(data => {
      if (data.status === 'online') {
        statusEl.textContent = 'Connected ✓';
        statusEl.className = 'online';
        const count = data.tools?.tools?.length ?? 0;
        toolCountEl.textContent = `${count} tools available`;
        logEl.textContent = 'Ready. Open ChatGPT / Claude / Gemini and run node cli.js';
      } else {
        statusEl.textContent = 'MCP Error';
        statusEl.className = 'offline';
        logEl.textContent = 'Backend online but MCP server error: ' + (data.error || '?');
      }
    })
    .catch(() => {
      statusEl.textContent = 'Offline ✗';
      statusEl.className = 'offline';
      logEl.textContent = 'Cannot reach backend on port 3000.\nRun: cd backend && node server.js';
    });
}

document.getElementById('check').addEventListener('click', checkBackend);

// Auto-check on open
checkBackend();
