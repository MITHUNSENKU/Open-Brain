import express from "express";
import bodyParser from "body-parser";
import chalk from "chalk";
import { WebSocketServer } from "ws";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { exec } from 'child_process';
import { MyMcpClient } from "./mcp-client.js";
import fs from 'fs';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_FILE = join(__dirname, 'bridge.log');
const MAX_TOOL_CALLS = 15;

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

// ─── File Logger ───
function log(msg) {
  const clean = msg.replace(/\x1b\[[0-9;]*m/g, '');
  const timestamped = `[${new Date().toISOString()}] ${clean}\n`;

  try {
    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size > MAX_LOG_SIZE) {
        // Truncate file if too big
        fs.writeFileSync(LOG_FILE, `[Log truncated at ${new Date().toISOString()}]\n`);
      }
    }
    fs.appendFileSync(LOG_FILE, timestamped);
  } catch (e) {
    process.stderr.write(chalk.red(`[bridge] Failed to write log: ${e.message}\n`));
  }

  process.stderr.write(chalk.gray(`[bridge] `) + msg + '\n');
}

// ─── Express App ───
const app = express();
const PORT = 3000;

// CORS + Private Network Access headers
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,Content-Type,Access-Control-Allow-Private-Network,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(bodyParser.json());

// ─── MCP Client ───
const mcpClient = new MyMcpClient();

// ─── WebSocket Server ───
const wss = new WebSocketServer({ noServer: true });

let cliSocket = null;
const extensionSockets = new Map(); // agentId -> ws
let activeAgentId = null;

// ─── Multi-Session State ───
// Each agent (browser tab) gets its own session
const sessions = new Map(); // agentId -> session object

function createSession(agentId) {
  return {
    agentId,
    state: 'IDLE',
    toolCallCount: 0,
    fullReport: '',
    bufferFile: null,  // file-descriptor buffer for streaming data
    cwd: process.cwd(),
    project: '',
    shellCwd: process.cwd(),
    shellMetadata: {},
    pendingTool: null,
    approvedTools: new Set(),
    approvalTimer: null,
    url: '',
  };
}

// Convenience: get the active session
function getSession(agentId) {
  if (!agentId) agentId = activeAgentId;
  if (!agentId) return null;
  if (!sessions.has(agentId)) sessions.set(agentId, createSession(agentId));
  return sessions.get(agentId);
}

function sendToCli(msg) {
  if (cliSocket?.readyState === 1) {
    cliSocket.send(JSON.stringify(msg));
  }
}

function sendToExtension(msg, agentId) {
  const targetId = agentId || activeAgentId;
  const ws = extensionSockets.get(targetId);
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify(msg));
    log(chalk.cyan(`[Relay] Message sent to agent ${targetId}: ${msg.type}`));
  } else {
    // Try any available socket as fallback
    for (const [id, sock] of extensionSockets) {
      if (sock.readyState === 1) {
        activeAgentId = id;
        sock.send(JSON.stringify(msg));
        log(chalk.cyan(`[Relay] Message sent to fallback agent ${id}: ${msg.type}`));
        return;
      }
    }
    log(chalk.red(`[Relay] Failed to send ${msg.type}: No active extension connection`));
  }
}

function resetSession(agentId) {
  const s = getSession(agentId);
  if (!s) return;
  if (s.approvalTimer) clearTimeout(s.approvalTimer);
  closeBuffer(s.bufferFile);
  s.bufferFile = null;
  s.state = 'IDLE';
  s.toolCallCount = 0;
  s.fullReport = '';
  s.pendingTool = null;
  s.approvalTimer = null;
}

// ─── Strip protocol noise from text before storing ───
// Uses balanced-brace walk so nested JSON in MCP_ACTION doesn't leak through
function stripMcpActions(text) {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const idx = text.indexOf('MCP_ACTION:', i);
    if (idx === -1) { result += text.slice(i); break; }
    result += text.slice(i, idx); // keep text before MCP_ACTION
    // Find the opening brace
    const braceStart = text.indexOf('{', idx);
    if (braceStart === -1) { i = idx + 11; continue; }
    // Balanced-brace walk to find the true end
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = braceStart; j < text.length; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (c === '{') depth++;
        if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
      }
    }
    i = end !== -1 ? end + 1 : braceStart + 1;
  }
  return result;
}

function cleanText(text) {
  return stripMcpActions(text)
    .replace(/\`\`\`(?:json)?\\s*\\n?MCP_ACTION[\\s\\S]*?\`\`\`/g, '')
    .replace(/\\[TOOL RESULT:[\\s\\S]*?\\[END TOOL RESULT\\]/g, '')
    .replace(/Continue your (?:analysis|reasoning)\\..*?(?:\\n|$)/g, '')
    .replace(/If you (?:need|have).*?MCP_ACTION.*?(?:\\n|$)/g, '')
    .replace(/Output another MCP_ACTION.*?(?:\\n|$)/g, '')
    .replace(/\\n{3,}/g, '\\n\\n');
}

// ─── File-descriptor buffer for browser stream data ───
function createBufferFile() {
  const tmpPath = join(os.tmpdir(), `openbrain-buf-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  const fd = fs.openSync(tmpPath, 'w+');
  return { fd, path: tmpPath };
}

function appendToBuffer(bufInfo, text) {
  if (!bufInfo || bufInfo.fd === null) return;
  try {
    fs.writeSync(bufInfo.fd, text);
  } catch (e) {
    log(chalk.red(`[Buffer] Write failed: ${e.message}`));
  }
}

function readBuffer(bufInfo) {
  if (!bufInfo || bufInfo.fd === null) return '';
  try {
    return fs.readFileSync(bufInfo.path, 'utf-8');
  } catch (e) {
    log(chalk.red(`[Buffer] Read failed: ${e.message}`));
    return '';
  }
}

function closeBuffer(bufInfo) {
  if (!bufInfo) return;
  try {
    if (bufInfo.fd !== null) { fs.closeSync(bufInfo.fd); bufInfo.fd = null; }
    if (fs.existsSync(bufInfo.path)) fs.unlinkSync(bufInfo.path);
  } catch (e) { /* ignore cleanup errors */ }
}

// ─── Shared Message Logic (Used by both WS and HTTP) ───
async function handleExtensionMessage(msg, source = 'WS') {
  const agentId = msg.agentId || activeAgentId;
  const s = getSession(agentId);
  if (!s) return;

  if (msg.type === "LOG") {
    const { level, text, msg: legacyMsg, tool } = msg;
    const content = text || legacyMsg || '';
    const tag = tool ? `[Tool:${tool}]` : '';
    const color = level === 'error' ? chalk.red : level === 'warn' ? chalk.yellow : chalk.gray;
    log(color(`[Browser:${level}]${tag} (${source}) ${content}`));
    return;
  }

  if (msg.type === "AI_STREAM") {
    if (s.state !== 'IDLE') {
      // Write raw stream to file descriptor buffer instead of growing a string
      if (!s.bufferFile) s.bufferFile = createBufferFile();
      appendToBuffer(s.bufferFile, msg.text);
      sendToCli({ type: 'AI_STREAM', text: msg.text, agentId });
    }
    return;
  }

  if (msg.type === "AI_COMPLETE") {
    log(chalk.green(`[Agent:${agentId}] AI_COMPLETE (state: ${s.state})`));
    if (s.state === 'WAITING_FOR_AI') {
      // Read the full buffer from the temp file, clean it, then send
      const rawBuffer = s.bufferFile ? readBuffer(s.bufferFile) : s.fullReport;
      const finalText = cleanText(rawBuffer);
      resetSession(agentId);
      sendToCli({ type: 'FINAL_REPORT', text: finalText, agentId });
    }
    return;
  }

  if (msg.type === "MCP_ACTION") {
    if (s.state === 'IDLE' || s.state === 'TOOL_RUNNING') return;
    if (s.toolCallCount >= MAX_TOOL_CALLS) {
      const rawBuffer = s.bufferFile ? readBuffer(s.bufferFile) : s.fullReport;
      const finalText = cleanText(rawBuffer) || 'Maximum tool iterations reached.';
      resetSession(agentId);
      sendToCli({ type: 'FINAL_REPORT', text: finalText, agentId });
      return;
    }
    s.pendingTool = { tool: msg.tool, args: msg.args, source, agentId };
    if (s.approvedTools && s.approvedTools.has(msg.tool)) {
      await executePendingTool(agentId);
    } else {
      s.state = 'WAITING_FOR_APPROVAL';
      sendToCli({ type: 'TOOL_CALL_REQUEST', tool: msg.tool, args: msg.args, source, agentId });
    }
    return;
  }
}

// ─── Diagnostic snapshot gathered on tool errors ───
function collectDiagnostics(cwd) {
  return new Promise((resolve) => {
    const lines = [];
    let done = 0;
    const tryDone = () => { if (++done === cmds.length) resolve(lines.join('\n')); };

    const cmds = [
      { label: 'cwd', cmd: 'pwd' },
      { label: 'ls', cmd: 'ls -la 2>&1 | head -30' },
      { label: 'PATH', cmd: 'echo "PATH=$PATH"' },
      { label: 'python', cmd: 'which python3 2>/dev/null || which python 2>/dev/null || echo "(python not found)"' },
      { label: 'node', cmd: 'node --version 2>&1' },
      { label: 'npm', cmd: 'npm --version 2>&1' },
      { label: 'disk', cmd: 'df -h . 2>&1 | tail -1' },
      { label: 'processes', cmd: 'ps aux 2>&1 | grep -v grep | grep -E "node|python|npm|server" | head -10' },
    ];

    for (const { label, cmd } of cmds) {
      exec(cmd, { cwd, timeout: 5000 }, (err, stdout, stderr) => {
        const out = (stdout || stderr || '').trim();
        if (out) lines.push(`[${label}]: ${out}`);
        tryDone();
      });
    }
  });
}

async function executePendingTool(agentId) {
  agentId = agentId || activeAgentId;
  const s = getSession(agentId);
  const pending = s?.pendingTool;
  if (!pending) return;

  s.pendingTool = null;
  if (s.approvalTimer) { clearTimeout(s.approvalTimer); s.approvalTimer = null; }
  s.state = 'TOOL_RUNNING';
  s.toolCallCount++;

  log(chalk.yellow(`[Tool #${s.toolCallCount}] ${pending.tool} args=${JSON.stringify(pending.args)}`));
  sendToCli({ type: 'TOOL_CALL_START', tool: pending.tool, args: pending.args, agentId });

  try {
    const result = await mcpClient.callTool(pending.tool, pending.args);
    const resultText = result.content ? result.content.map(c => c.text).join('\n') : JSON.stringify(result);
    const isError = result.isError || false;
    const preview = resultText.replace(/\n/g, ' ').slice(0, 100) + (resultText.length > 100 ? '...' : '');

    sendToCli({ type: 'TOOL_CALL_DONE', preview, isError, agentId });
    s.state = 'WAITING_FOR_AI';

    if (isError) {
      let diag = '';
      try { diag = await collectDiagnostics(s.shellCwd || s.cwd || process.cwd()); } catch (de) { diag = `(diagnostics failed: ${de.message})`; }
      const enriched = `❌ TOOL ERROR in '${pending.tool}':\n${resultText}\n\n--- DIAGNOSTIC CONTEXT ---\n${diag}\n--- END DIAGNOSTICS ---\n\nFix and retry. Do NOT ask the user.`;
      sendToCli({ type: 'TOOL_ERROR_RECOVERY', tool: pending.tool, preview, agentId });
      sendToExtension({ type: 'MCP_RESULT', tool: pending.tool, text: enriched, callNum: s.toolCallCount, isError: true }, agentId);
    } else {
      sendToExtension({ type: 'MCP_RESULT', tool: pending.tool, text: resultText, callNum: s.toolCallCount }, agentId);
    }
  } catch (err) {
    s.state = 'WAITING_FOR_AI';
    let diag = '';
    try { diag = await collectDiagnostics(s.shellCwd || s.cwd || process.cwd()); } catch (de) { diag = `(diagnostics failed: ${de.message})`; }
    const enriched = `❌ EXCEPTION in '${pending.tool}':\n${err.message}\n\n--- DIAGNOSTIC CONTEXT ---\n${diag}\n--- END DIAGNOSTICS ---\n\nFix and retry. Do NOT ask the user.`;
    sendToCli({ type: 'TOOL_CALL_DONE', preview: `Error: ${err.message}`, isError: true, agentId });
    sendToExtension({ type: 'MCP_RESULT', tool: pending.tool, text: enriched, callNum: s.toolCallCount, isError: true }, agentId);
  }
}

// ─── WebSocket Connection Handler ───
wss.on("connection", (ws, req) => {
  const params = new URLSearchParams(req.url.replace(/^[^?]*/, ''));
  const type = params.get('type') || 'extension';
  const agentId = params.get('agentId') || `agent-${Date.now()}`;
  log(chalk.magenta(`[WS] ${type} connected (id: ${agentId})`));

  if (type === "cli") {
    cliSocket = ws;

    ws.on("message", async (data) => {
      const msg = JSON.parse(data.toString());

      // ── /new ai <url> — open a new AI tab ──
      if (msg.type === "OPEN_TAB") {
        const newId = `agent-${Date.now()}`;
        sessions.set(newId, createSession(newId));
        // Broadcast OPEN_TAB to all connected extensions so one of them opens it
        for (const [, sock] of extensionSockets) {
          if (sock.readyState === 1) {
            sock.send(JSON.stringify({ type: 'OPEN_TAB', url: msg.url, agentId: newId }));
            break;
          }
        }
        sendToCli({ type: 'STATUS', text: `🆕 Spawning new agent tab (${newId}) → ${msg.url}` });
        return;
      }

      // ── /new — reset active session ──
      if (msg.type === "NEW_SESSION") {
        const targetId = msg.agentId || activeAgentId;
        if (targetId) {
          resetSession(targetId);
          const ws2 = extensionSockets.get(targetId);
          if (ws2?.readyState === 1) ws2.send(JSON.stringify({ type: 'CLEAR_CONVERSATION' }));
        }
        sendToCli({ type: 'STATUS', text: `🔄 Session reset for agent: ${targetId || 'none'}` });
        return;
      }

      // ── /agents — list active agents ──
      if (msg.type === "LIST_AGENTS") {
        const list = [...extensionSockets.entries()].map(([id, sock]) => {
          const s = sessions.get(id);
          return `• ${id} | ${sock.readyState === 1 ? '🟢 connected' : '🔴 disconnected'} | state: ${s?.state || 'unknown'} | url: ${s?.url || 'unknown'}`;
        });
        sendToCli({ type: 'STATUS', text: list.length ? `Active agents:\n${list.join('\n')}` : 'No active agents.' });
        return;
      }

      // ── PROMPT ──
      if (msg.type === "PROMPT") {
        const targetId = msg.agentId || activeAgentId;
        const alive = extensionSockets.get(targetId);
        if (!alive || alive.readyState !== 1) {
          // fallback to any live socket
          let found = null;
          for (const [id, sock] of extensionSockets) {
            if (sock.readyState === 1) { found = id; break; }
          }
          if (!found) {
            sendToCli({ type: 'ERROR', text: 'No browser extension connected. Open ChatGPT/Claude/Gemini in Chrome.' });
            return;
          }
          activeAgentId = found;
        } else {
          activeAgentId = targetId;
        }

        const s = getSession(activeAgentId);
        s.cwd = msg.cwd || s.cwd;
        s.project = msg.project || s.project;
        s.shellCwd = msg.shellCwd || s.shellCwd || s.cwd;
        s.shellMetadata = msg.shellMetadata || s.shellMetadata || {};
        s.state = 'WAITING_FOR_AI';
        s.toolCallCount = 0;
        s.fullReport = '';
        // Clean up old buffer and create fresh one
        closeBuffer(s.bufferFile);
        s.bufferFile = null;
        s.pendingTool = null;

        const shellContext = [
          `[Working directory: ${s.cwd}]`,
          `[Shell cwd: ${s.shellCwd}]`,
          `[Project: ${s.project}]`,
          s.shellMetadata?.lastShellCommand ? `[Last shell command: ${s.shellMetadata.lastShellCommand}]` : null,
          s.shellMetadata?.lastShellOutput ? `[Last shell output: ${s.shellMetadata.lastShellOutput}]` : null,
        ].filter(Boolean).join('\n');

        const contextualPrompt = `${shellContext}\n\n${msg.text}`;
        log(chalk.blue(`[CLI→Agent:${activeAgentId}] "${msg.text.slice(0, 80)}..."`));
        sendToCli({ type: 'AI_THINKING', text: 'AI is thinking...' });
        sendToExtension({ type: 'SEND_PROMPT', text: contextualPrompt }, activeAgentId);
      }

      // ── TOOL_APPROVAL ──
      else if (msg.type === "TOOL_APPROVAL") {
        const tid = msg.agentId || activeAgentId;
        const s = getSession(tid);
        if (!s || s.state !== 'WAITING_FOR_APPROVAL' || !s.pendingTool) return;
        if (msg.approve) {
          if (msg.remember && s.pendingTool?.tool) s.approvedTools.add(s.pendingTool.tool);
          await executePendingTool(tid);
        } else {
          s.state = 'WAITING_FOR_AI';
          sendToExtension({ type: 'MCP_RESULT', tool: s.pendingTool.tool, text: 'Error: tool call denied by user', callNum: s.toolCallCount, isError: true }, tid);
          s.pendingTool = null;
        }
      }

      // ── TOOL_INTERACTIVE_RESPONSE ──
      else if (msg.type === "TOOL_INTERACTIVE_RESPONSE") {
        const tid = msg.agentId || activeAgentId;
        const s = getSession(tid);
        if (!s || !s.activeInteractiveTool) return;
        const pending = s.activeInteractiveTool;
        s.activeInteractiveTool = null;
        const preview = msg.output.replace(/\n/g, ' ').slice(0, 100);
        sendToCli({ type: 'TOOL_CALL_DONE', preview, isError: !msg.success, agentId: tid });
        s.state = 'WAITING_FOR_AI';
        sendToExtension({ type: 'MCP_RESULT', tool: pending.tool, text: msg.output, callNum: s.toolCallCount, isError: !msg.success }, tid);
      }
    });

    ws.on("close", () => { cliSocket = null; log(chalk.magenta("[WS] CLI disconnected")); });

  } else {
    // Extension connection — register by agentId
    extensionSockets.set(agentId, ws);
    activeAgentId = agentId;
    if (!sessions.has(agentId)) sessions.set(agentId, createSession(agentId));

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        msg.agentId = agentId; // stamp every message with its origin
        if (msg.url) sessions.get(agentId).url = msg.url;
        await handleExtensionMessage(msg, 'WS');
      } catch (e) {
        log(chalk.red(`[WS] Error handling message: ${e.message}`));
      }
    });

    ws.on("close", () => {
      extensionSockets.delete(agentId);
      if (activeAgentId === agentId) {
        activeAgentId = [...extensionSockets.keys()].find(id => extensionSockets.get(id).readyState === 1) || null;
      }
      log(chalk.magenta(`[WS] Agent ${agentId} disconnected`));
    });
  }
});

// ─── REST Endpoints ───
app.get("/info", async (req, res) => {
  try {
    const tools = await mcpClient.listTools();
    res.json({ status: "online", tools });
  } catch (e) {
    res.json({ status: "offline", error: e.message });
  }
});

app.post("/register", (req, res) => {
  log(chalk.cyan(`✨ Extension active on: ${req.body.url || 'unknown'}`));
  res.json({ success: true });
});

app.post("/mcp-action", async (req, res) => {
  try {
    await handleExtensionMessage({ type: 'MCP_ACTION', ...req.body }, 'HTTP');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/ai-stream", async (req, res) => {
  try {
    await handleExtensionMessage({ type: 'AI_STREAM', ...req.body }, 'HTTP');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/ai-complete", async (req, res) => {
  try {
    await handleExtensionMessage({ type: 'AI_COMPLETE', ...req.body }, 'HTTP');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/log", async (req, res) => {
  try {
    await handleExtensionMessage({ type: 'LOG', ...req.body }, 'HTTP');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Start Server ───
const server = app.listen(PORT, () => {
  const startMsg = `Bridge server on http://localhost:${PORT}  (log: ${LOG_FILE})`;
  log(chalk.green(startMsg));

  console.log(chalk.bold.green('\n  ┌' + '─'.repeat(50) + '┐'));
  console.log(chalk.bold.green('  │') + chalk.bold.white('  🚀 MCP Bridge Backend  —  Port ' + PORT + '             ') + chalk.bold.green('│'));
  console.log(chalk.bold.green('  │') + chalk.gray('  Waiting for CLI (node cli.js) + extension...  ') + chalk.bold.green('│'));
  console.log(chalk.bold.green('  └' + '─'.repeat(50) + '┘\n'));
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});
