import express from "express";
import bodyParser from "body-parser";
import chalk from "chalk";
import { WebSocketServer } from "ws";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { exec } from 'child_process';
import { MyMcpClient } from "./mcp-client.js";
import fs from 'fs';

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
const extensionSockets = new Set();
let activeExtensionSocket = null; // The most recently active/connected extension

// ─── Agentic Session State ───
// States: IDLE | WAITING_FOR_AI | TOOL_RUNNING
let session = {
  state: 'IDLE',
  toolCallCount: 0,
  fullReport: '',   // accumulates ALL reasoning across turns
  cwd: process.cwd(),
  project: '',
  shellCwd: process.cwd(),
  shellMetadata: {},
  pendingTool: null,
  approvedTools: new Set(),
  approvalTimer: null,
};

function sendToCli(msg) {
  if (cliSocket?.readyState === 1) {
    cliSocket.send(JSON.stringify(msg));
  }
}

function sendToExtension(msg) {
  if (activeExtensionSocket?.readyState === 1) {
    activeExtensionSocket.send(JSON.stringify(msg));
    log(chalk.cyan(`[Relay] Message sent to extension: ${msg.type}`));
  } else {
    // Try other available sockets if the active one failed
    for (const ws of extensionSockets) {
      if (ws.readyState === 1) {
        activeExtensionSocket = ws;
        ws.send(JSON.stringify(msg));
        log(chalk.cyan(`[Relay] Message sent to alternate extension: ${msg.type}`));
        return;
      }
    }
    log(chalk.red(`[Relay] Failed to send ${msg.type}: No active extension connection`));
  }
}

function resetSession() {
  if (session.approvalTimer) {
    clearTimeout(session.approvalTimer);
  }
  session = {
    state: 'IDLE',
    toolCallCount: 0,
    fullReport: '',
    cwd: session.cwd,
    project: session.project,
    shellCwd: session.shellCwd,
    shellMetadata: session.shellMetadata,
    pendingTool: null,
    approvedTools: session.approvedTools || new Set(),
    approvalTimer: null,
  };
}

// ─── Strip protocol noise from text before storing ───
function cleanText(text) {
  return text
    .replace(/MCP_ACTION:\s*\{[\s\S]*?\}/g, '')
    .replace(/\[TOOL RESULT:[\s\S]*?\[END TOOL RESULT\]/g, '')
    .replace(/Continue your analysis\..*?(?:\n|$)/g, '')
    .replace(/If you (?:need|have).*?MCP_ACTION.*?(?:\n|$)/g, '');
}

// ─── Shared Message Logic (Used by both WS and HTTP) ───
async function handleExtensionMessage(msg, source = 'WS') {
  // ── Handle Logs from browser ──
  if (msg.type === "LOG") {
    const { level, text, msg: legacyMsg, tool } = msg;
    const content = text || legacyMsg || '';
    const tag = tool ? `[Tool:${tool}]` : '';
    const color = level === 'error' ? chalk.red : level === 'warn' ? chalk.yellow : chalk.gray;
    log(color(`[Browser:${level}]${tag} (${source}) ${content}`));
    return;
  }

  // ── AI is streaming text ──
  if (msg.type === "AI_STREAM") {
    if (session.state !== 'IDLE') {
      log(chalk.gray(`[Relay] Stream received (${source}, ${msg.text.length} chars)`));
      const cleaned = cleanText(msg.text);
      if (cleaned.trim()) {
        session.fullReport += cleaned;
      }
      sendToCli({ type: 'AI_STREAM', text: msg.text });
    } else {
      log(chalk.gray(`[Relay] AI_STREAM ignored — session state is '${session.state}'`));
    }
  }

  // ── AI finished a turn ──
  else if (msg.type === "AI_COMPLETE") {
    log(chalk.green(`[Relay] AI_COMPLETE received (${source}, turns: ${session.toolCallCount + 1}, state: ${session.state})`));
    if (session.state === 'TOOL_RUNNING') {
      // A tool is still running — AI_COMPLETE is premature, ignore it
      log(chalk.yellow(`[Session] AI_COMPLETE ignored — tool is still running`));
    } else if (session.state === 'WAITING_FOR_AI') {
      log(chalk.green(`[Session] Final answer after ${session.toolCallCount} tool calls`));
      const finalText = session.fullReport;
      resetSession();
      sendToCli({ type: 'FINAL_REPORT', text: finalText });
    } else {
      log(chalk.gray(`[Session] AI_COMPLETE ignored — session is IDLE`));
    }
  }

  // ── AI wants to call a tool ──
  else if (msg.type === "MCP_ACTION") {
    if (session.state === 'IDLE') {
      log(chalk.yellow(`[Session] MCP_ACTION received but session is IDLE — ignoring (no active request)`));
      return;
    }

    if (session.state === 'TOOL_RUNNING') {
      log(chalk.yellow(`[Session] MCP_ACTION for '${msg.tool}' received while TOOL_RUNNING — likely duplicate, ignoring`));
      return;
    }

    if (session.toolCallCount >= MAX_TOOL_CALLS) {
      log(chalk.red(`[Session] Hit max tool calls (${MAX_TOOL_CALLS})`));
      const finalText = session.fullReport || 'Maximum tool iterations reached.';
      resetSession();
      sendToCli({ type: 'FINAL_REPORT', text: finalText });
      return;
    }

    session.pendingTool = {
      tool: msg.tool,
      args: msg.args,
      source,
    };
    
    // Check if tool was previously approved for 'remember' state
    if (session.approvedTools && session.approvedTools.has(msg.tool)) {
      log(chalk.yellow(`[Tool] Auto-executing (previously approved): ${msg.tool}`));
      await executePendingTool();
    } else {
      log(chalk.yellow(`[Tool] Requesting approval for: ${msg.tool}`));
      session.state = 'WAITING_FOR_APPROVAL';
      sendToCli({ type: 'TOOL_CALL_REQUEST', tool: msg.tool, args: msg.args, source });
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
      { label: 'cwd',        cmd: 'pwd' },
      { label: 'ls',         cmd: 'ls -la 2>&1 | head -30' },
      { label: 'PATH',       cmd: 'echo "PATH=$PATH"' },
      { label: 'python',     cmd: 'which python3 2>/dev/null || which python 2>/dev/null || echo "(python not found)"' },
      { label: 'node',       cmd: 'node --version 2>&1' },
      { label: 'npm',        cmd: 'npm --version 2>&1' },
      { label: 'disk',       cmd: 'df -h . 2>&1 | tail -1' },
      { label: 'processes',  cmd: 'ps aux 2>&1 | grep -v grep | grep -E "node|python|npm|server" | head -10' },
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

async function executePendingTool() {
  const pending = session.pendingTool;
  if (!pending) return;

  session.pendingTool = null;
  if (session.approvalTimer) {
    clearTimeout(session.approvalTimer);
    session.approvalTimer = null;
  }
  session.state = 'TOOL_RUNNING';
  session.toolCallCount++;

  log(chalk.yellow(`[Tool #${session.toolCallCount}] ${pending.tool} (${pending.source}) args=${JSON.stringify(pending.args)}`));
  sendToCli({ type: 'TOOL_CALL_START', tool: pending.tool, args: pending.args, source: pending.source });

  if (pending.tool === 'ask_permission_and_run') {
    log(chalk.cyan(`[Interactive] Sending interactive command request to CLI...`));
    session.activeInteractiveTool = pending;
    sendToCli({ type: 'TOOL_INTERACTIVE_REQUEST', tool: pending.tool, args: pending.args, source: pending.source });
    return; // Do not call mcpClient
  }

  try {
    log(chalk.cyan(`[MCP] Calling tool: ${pending.tool}...`));
    const result = await mcpClient.callTool(pending.tool, pending.args);
    const resultText = result.content
      ? result.content.map(c => c.text).join('\n')
      : JSON.stringify(result);
    const isError = result.isError || false;

    const preview = resultText.replace(/\n/g, ' ').slice(0, 100) + (resultText.length > 100 ? '...' : '');
    log(isError ? chalk.red(`[Tool] Error result: ${pending.tool}`) : chalk.green(`[Tool] Done: ${pending.tool} → ${resultText.length} chars`));
    sendToCli({ type: 'TOOL_CALL_DONE', preview, isError });

    session.state = 'WAITING_FOR_AI';
    log(chalk.cyan(`[Session] State → WAITING_FOR_AI (tool #${session.toolCallCount} complete)`));

    if (isError) {
      // Gather diagnostic context so AI can self-heal
      log(chalk.yellow(`[Recovery] Tool ${pending.tool} returned error — collecting diagnostics...`));
      sendToCli({ type: 'TOOL_ERROR_RECOVERY', tool: pending.tool, preview });
      let diag = '';
      try { diag = await collectDiagnostics(session.shellCwd || session.cwd || process.cwd()); } catch (de) { diag = `(diagnostics failed: ${de.message})`; }
      const enriched =
        `❌ TOOL ERROR in '${pending.tool}':\n${resultText}\n\n` +
        `--- DIAGNOSTIC CONTEXT (auto-collected) ---\n${diag}\n` +
        `--- END DIAGNOSTICS ---\n\n` +
        `Analyze the error above. Fix and retry with the correct tool call. Do NOT ask the user.`;
      sendToExtension({ type: 'MCP_RESULT', tool: pending.tool, text: enriched, callNum: session.toolCallCount, isError: true });
    } else {
      sendToExtension({ type: 'MCP_RESULT', tool: pending.tool, text: resultText, callNum: session.toolCallCount });
    }

  } catch (err) {
    log(chalk.red(`[Tool] Exception in ${pending.tool}: ${err.message}`));
    session.state = 'WAITING_FOR_AI';
    log(chalk.cyan(`[Session] State → WAITING_FOR_AI (exception recovery)`));

    // Gather diagnostics — wrapped so a crash here can't block the MCP_RESULT
    let diag = '';
    try { diag = await collectDiagnostics(session.shellCwd || session.cwd || process.cwd()); } catch (de) { diag = `(diagnostics failed: ${de.message})`; }
    const enriched =
      `❌ EXCEPTION in '${pending.tool}':\n${err.message}\n\n` +
      `--- DIAGNOSTIC CONTEXT (auto-collected) ---\n${diag}\n` +
      `--- END DIAGNOSTICS ---\n\n` +
      `Analyze the error above. Fix and retry with the correct tool call. Do NOT ask the user.`;

    sendToCli({ type: 'TOOL_CALL_DONE', preview: `Error: ${err.message}`, isError: true });
    sendToExtension({ type: 'MCP_RESULT', tool: pending.tool, text: enriched, callNum: session.toolCallCount, isError: true });
  }
}

// ─── WebSocket Connection Handler ───
wss.on("connection", (ws, req) => {
  const params = new URLSearchParams(req.url.replace(/^[^?]*/, ''));
  const type = params.get('type') || 'extension';
  log(chalk.magenta(`[WS] ${type} connected`));

  if (type === "cli") {
    cliSocket = ws;

    ws.on("message", async (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === "PROMPT") {
        if (!activeExtensionSocket || activeExtensionSocket.readyState !== 1) {
          // Check if any extension is alive
          const alive = [...extensionSockets].find(ws => ws.readyState === 1);
          if (alive) {
            activeExtensionSocket = alive;
          } else {
            sendToCli({
              type: 'ERROR',
              text: 'Browser extension not connected. Open ChatGPT/Claude/Gemini in Chrome with the extension loaded.',
            });
            return;
          }
        }

        // Store context from CLI
        session.cwd = msg.cwd || session.cwd;
        session.project = msg.project || session.project;
        session.shellCwd = msg.shellCwd || session.shellCwd || session.cwd;
        session.shellMetadata = msg.shellMetadata || session.shellMetadata || {};

        const shellContext = [
          `[Working directory: ${session.cwd}]`,
          `[Shell cwd: ${session.shellCwd}]`,
          `[Project: ${session.project}]`,
          session.shellMetadata?.lastShellCommand ? `[Last shell command: ${session.shellMetadata.lastShellCommand}]` : null,
          session.shellMetadata?.lastShellOutput ? `[Last shell output: ${session.shellMetadata.lastShellOutput}]` : null,
        ].filter(Boolean).join('\n');

        const contextualPrompt = `${shellContext}\n\n${msg.text}`;

        log(chalk.blue(`[CLI→AI] "${msg.text.slice(0, 80)}..."`));
        session = {
          state: 'WAITING_FOR_AI',
          toolCallCount: 0,
          fullReport: '',
          cwd: session.cwd,
          project: session.project,
          shellCwd: session.shellCwd,
          shellMetadata: session.shellMetadata,
          pendingTool: null,
          approvedTools: session.approvedTools || new Set(),
          approvalTimer: null,
        };

        sendToCli({ type: 'AI_THINKING', text: 'AI is thinking...' });
        sendToExtension({ type: 'SEND_PROMPT', text: contextualPrompt });
      } else if (msg.type === "TOOL_APPROVAL") {
        if (session.state !== 'WAITING_FOR_APPROVAL' || !session.pendingTool) {
          log(chalk.yellow(`[Approval] Ignored unexpected approval message`));
          return;
        }

        if (msg.approve) {
          if (msg.remember && session.pendingTool?.tool) {
            session.approvedTools.add(session.pendingTool.tool);
            log(chalk.green(`[Approval] Remembering approval for tool: ${session.pendingTool.tool}`));
          }
          log(chalk.green(`[Approval] Tool approved by user`));
          await executePendingTool();
        } else {
          // Reject
          session.state = 'WAITING_FOR_AI';
          sendToExtension({
            type: 'MCP_RESULT',
            tool: session.pendingTool.tool,
            text: `Error: tool call denied by user`,
            callNum: session.toolCallCount,
            isError: true,
          });
          session.pendingTool = null;
        }
      } else if (msg.type === "TOOL_INTERACTIVE_RESPONSE") {
        if (session.state !== 'TOOL_RUNNING' || !session.activeInteractiveTool) return;
        const pending = session.activeInteractiveTool;
        session.activeInteractiveTool = null;
        
        const preview = msg.output.replace(/\n/g, ' ').slice(0, 100);
        log(msg.success ? chalk.green(`[Interactive] Done: ${preview}`) : chalk.red(`[Interactive] Failed: ${preview}`));
        sendToCli({ type: 'TOOL_CALL_DONE', preview, isError: !msg.success });
        
        session.state = 'WAITING_FOR_AI';
        sendToExtension({ type: 'MCP_RESULT', tool: pending.tool, text: msg.output, callNum: session.toolCallCount, isError: !msg.success });
      }
    });

    ws.on("close", () => {
      cliSocket = null;
      log(chalk.magenta("[WS] CLI disconnected"));
    });

  } else {
    // Extension connection
    extensionSockets.add(ws);
    activeExtensionSocket = ws;

    ws.on("message", async (data) => {
      const dataStr = data.toString();
      // Whenever we get a message from an extension, mark it as active
      if (type === "extension") activeExtensionSocket = ws;

      try {
        const msg = JSON.parse(dataStr);
        await handleExtensionMessage(msg, 'WS');
      } catch (e) {
        log(chalk.red(`[WS] Error handling message: ${e.message}`));
      }
    });

    ws.on("close", () => {
      extensionSockets.delete(ws);
      if (activeExtensionSocket === ws) {
        activeExtensionSocket = [...extensionSockets].find(w => w.readyState === 1) || null;
      }
      log(chalk.magenta("[WS] Extension disconnected"));
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
