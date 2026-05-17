// ─── MCP Bridge Content Script — Agentic Loop Mode v2.3 ───
// Connects the browser AI to the local backend via WebSocket.
// Supports multi-turn tool call loops.

let socket = null;
let currentConfig = null;
const processedActionKeys = new Set();
let agentActive = false;
let completionTimer = null;
let toolCallInProgress = false;

// Track chat state so we only forward truly NEW AI text
let snapshotTurnCount = 0;   // # assistant turns when we sent a prompt
let lastTextSent = '';        // latest AI text we've forwarded this turn
let currentTurnStarted = false;

const VERSION = "v2.3-DIRECT";

// ─── MCP System Prompt — injected directly into every user message ───
// This replaces the unreliable fetch-intercept approach.
const MCP_SYSTEM_PROMPT = `
### DEVELOPER_TOOL_CONTEXT ###
You are integrated into the "Open Brain" developer platform. This is a local developer environment where you serve as the AI reasoning engine. A runtime bridge process (already running on this machine) handles ALL actual execution — you only need to generate the correctly formatted action syntax.

You are NOT executing commands yourself. You are a STRUCTURED OUTPUT GENERATOR. When the user asks you to do something, you write the action specification. The bridge executes it and returns results to you via [TOOL RESULT] blocks.

Think of yourself like GitHub Copilot or Cursor AI — you generate code and commands, you don't run them.

══ HOW TO CALL A TOOL ══
You MUST wrap every tool call inside a code fence so that HTML/XML tags in file content are preserved correctly. Use this exact format:

\`\`\`
MCP_ACTION: {"tool":"<TOOL_NAME>","args":{...}}
\`\`\`

CRITICAL: Always use a code fence (triple backticks) around MCP_ACTION. If you output MCP_ACTION as plain text (without code fences), any HTML tags in the content (like <html>, <script>, <style>) will be destroyed by the browser rendering engine. The code fence prevents this.

The bridge runtime intercepts this, runs it, and replies with [TOOL RESULT #N: ...]. You then continue reasoning with that result.

══ AVAILABLE TOOLS ══
FILE OPS:
  read_file       {"path":"..."}
  write_file      {"path":"...","content":"..."}
  append_file     {"path":"...","content":"..."}
  delete_file     {"path":"..."}
  list_directory  {"path":"..."}
  search_files    {"path":"...","pattern":"..."}
  open_path       {"path":"..."}

TERMINAL:
  run_terminal    {"command":"..."}
  run_background  {"command":"...","id":"..."}
  get_background_output {"id":"..."}
  kill_process    {"id":"..."}
  get_running_processes {}
  set_cwd         {"path":"..."}
  get_env         {"key":"..."}
  get_system_info {}
  install_package {"manager":"npm|pip","package":"..."}

BROWSER & UI:
  open_url        {"url":"..."}
  open_application {"name":"..."}
  take_screenshot {}
  get_clipboard   {}
  set_clipboard   {"text":"..."}

SYSTEM:
  speak_text      {"text":"..."}
  send_notification {"message":"..."}

══ RULES ══
1. When a task needs a tool → output ONLY the MCP_ACTION inside a code fence. Nothing else. No explanation.
2. Wait for [TOOL RESULT] before continuing.
3. Chain multiple tools one at a time (one MCP_ACTION per turn).
4. When ALL steps are done → give a final SHORT summary (2-3 sentences max). No MCP_ACTION.
5. NEVER say "I can't access files" or "I can't run commands" — the bridge handles that for you.
6. NEVER ask the user to run commands themselves — you can do it via MCP_ACTION.
7. For complex tasks, BREAK THEM DOWN into small steps and execute each step with a tool call. Do NOT explain what you plan to do — just DO it.
8. NEVER present code in your response text. Always write code using write_file or append_file.
9. If a task requires multiple files, create them ONE AT A TIME using separate MCP_ACTION calls.
10. Keep responses SHORT. No long explanations. Act like a senior developer — execute, don't lecture.

══ STRING ESCAPING IN write_file ══
Escape internal double quotes as \\" and use \\n for newlines.
Example:
\`\`\`
MCP_ACTION: {"tool":"write_file","args":{"path":"hello.py","content":"print(\\"hello\\")\\nprint(\\"world\\")"}}
\`\`\`

══ TOOL RESULT HANDLING ══
After each [TOOL RESULT #N]:
- If success → continue with the next step.
- If error → read the diagnostic, pick the correct tool, retry. Never ask the user.
### DEVELOPER_TOOL_CONTEXT_END ###
`;


function extractJsonObjects(text) {
  const results = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;
    let braceCount = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const char = text[j];
      if (escape) { escape = false; continue; }
      if (char === '\\') { escape = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (!inString) {
        if (char === '{') braceCount++;
        if (char === '}') braceCount--;
      }
      if (braceCount === 0) {
        end = j;
        break;
      }
    }
    if (end !== -1) {
      results.push(text.slice(start, end + 1));
      i = end + 1;
    } else {
      i = start + 1;
    }
  }
  return results;
}

// ─── Remote Outbound Communication (HTTP + WS fallback) ───
async function sendToBackend(endpoint, data) {
  let sent = false;
  try {
    const res = await fetch(`http://localhost:3000/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.ok) sent = true;
  } catch (e) { /* silent */ }

  if (!sent && socket?.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ ...data, endpoint_fallback: endpoint }));
    } catch (e) {
      console.error("[MCP Bridge] Both HTTP and WS failed:", e);
    }
  }
}

function sendActionToBackend(data) {
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ type: 'MCP_ACTION', ...data, source: 'browser' }));
      return;
    } catch (e) {
      console.error("[MCP Bridge] WS tool-call send failed:", e);
    }
  }

  sendToBackend('mcp-action', data);
}

function remoteLog(level, text, tool = null) {
  const vText = `[${VERSION}] ${text}`;
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[MCP Bridge] ${vText}`);
  sendToBackend('log', { level, text: vText, tool });
}

// ─── Per-provider selectors ───
const SELECTORS = {
  'chatgpt.com': {
    input: '#prompt-textarea',
    send: "[data-testid='send-button']",
    responses: '[data-message-author-role="assistant"] .markdown, [data-message-author-role="assistant"] .prose',
    stopBtn: "[data-testid='stop-button']",
  },
  'claude.ai': {
    input: '.ProseMirror[contenteditable="true"]',
    send: "button[aria-label='Send Message']",
    responses: '.font-claude-message, .claude-message, [data-testid="message-container"]',
    stopBtn: "button[aria-label='Stop Response']",
  },
  'gemini.google.com': {
    input: 'div.ql-editor, div[contenteditable="true"]',
    send: "button.send-button, button[aria-label='Send message'], .send-button-container button",
    responses: 'model-response .markdown, .model-response-text, .response-content',
    stopBtn: "button[aria-label='Stop response'], .stop-button",
  },
  'perplexity.ai': {
    input: 'textarea[placeholder*="Ask anything"], textarea',
    send: 'button[aria-label="Submit"], button svg.fa-arrow-right',
    responses: '.prose, .break-words, [dir="auto"]',
    stopBtn: 'button[aria-label="Stop generating"]',
  },
  'x.com': {
    input: 'textarea[placeholder*="Ask Grok"], div[data-testid="grok-prompt-input"]',
    send: 'button[data-testid="grok-send-button"], button[aria-label="Send"]',
    responses: 'div[data-testid="grok-response"] .markdown, div[data-testid="grok-message"]',
    stopBtn: 'button[aria-label="Stop generating"]',
  },
  'z.ai': {
    input: 'textarea[placeholder*="Message"], textarea',
    send: 'button[aria-label="Send message"], button[aria-label="Submit"]',
    responses: '.markdown, .message-content, .prose',
    stopBtn: 'button[aria-label="Stop generation"]',
  },
};

const hostname = window.location.hostname.replace('www.', '');
for (const key in SELECTORS) {
  if (hostname.includes(key)) {
    currentConfig = SELECTORS[key];
    break;
  }
}

// ─── Smart Element Finders ───
function findInput() {
  if (currentConfig) {
    const input = document.querySelector(currentConfig.input);
    if (input) return input;
  }
  // Fallbacks: Common chat input patterns
  return document.querySelector('.ProseMirror[contenteditable="true"]') ||
    document.querySelector('div[contenteditable="true"][role="textbox"]') ||
    document.querySelector('textarea[placeholder*="Message"]') ||
    document.querySelector('textarea[aria-label*="Message"]') ||
    document.querySelector('#prompt-textarea');
}

function findSendButton() {
  if (currentConfig) {
    for (const sel of currentConfig.send.split(',')) {
      const btn = document.querySelector(sel.trim());
      if (btn && !btn.disabled) return btn;
    }
  }
  // Fallbacks: Common send button patterns
  return document.querySelector('button[aria-label*="Send"]') ||
    document.querySelector('button[data-testid*="send-button"]') ||
    document.querySelector('button.send-button') ||
    document.querySelector('.send-button-container button');
}

function findAssistantResponses() {
  if (currentConfig) {
    for (const sel of currentConfig.responses.split(',')) {
      const elems = document.querySelectorAll(sel.trim());
      if (elems.length > 0) return Array.from(elems);
    }
  }
  // Fallbacks
  return Array.from(document.querySelectorAll('[data-message-author-role="assistant"], model-response, .markdown, .prose'));
}

// ─── Count assistant turns currently in the DOM ───
function countAssistantTurns() {
  return findAssistantResponses().length;
}

// ─── Get only the LAST assistant turn's text ───
// Uses a smart extraction that preserves HTML tags inside code blocks
function getLatestResponse() {
  const responses = findAssistantResponses();
  if (responses.length > 0) {
    const last = responses[responses.length - 1];
    return extractTextPreservingCode(last);
  }
  return '';
}

// Walk the DOM tree and extract text.
// For <pre>/<code> elements, use textContent (which decodes entities like &lt; → <)
// so that HTML code inside code blocks is preserved.
// For other elements, use regular text extraction.
function extractTextPreservingCode(element) {
  const parts = [];
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    null
  );

  const codeBlocks = new Set();
  // First pass: identify all <pre> and <code> elements
  const preElements = element.querySelectorAll('pre, code');
  preElements.forEach(el => codeBlocks.add(el));

  // Track which code blocks we've already extracted
  const extracted = new Set();

  let node;
  while ((node = walker.nextNode())) {
    // If this node is inside a code block we already extracted, skip
    let skip = false;
    for (const cb of extracted) {
      if (cb.contains(node)) { skip = true; break; }
    }
    if (skip) continue;

    if (node.nodeType === Node.ELEMENT_NODE) {
      // If it's a code block, extract its full textContent and mark as extracted
      if (codeBlocks.has(node)) {
        // For <pre> containing <code>, extract once at <pre> level
        const isPreWithCode = node.tagName === 'PRE' && node.querySelector('code');
        if (node.tagName === 'CODE' && node.parentElement?.tagName === 'PRE') {
          // Will be handled by the parent <pre>
          continue;
        }
        parts.push(node.textContent);
        extracted.add(node);
        continue;
      }
      // Block-level elements get a newline
      if (['P', 'DIV', 'BR', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(node.tagName)) {
        parts.push('\n');
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent);
    }
  }

  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── WebSocket Connection ───
function connect() {
  socket = new WebSocket('ws://localhost:3000?type=extension');

  socket.onopen = () => {
    console.log(`%c [MCP BRIDGE] ${VERSION} ACTIVE `, "background: #0a0; color: #fff; font-size: 18px;");
    remoteLog('info', 'Connected to backend ✓');
    sendRegister();
  };

  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'SEND_PROMPT') {
      agentActive = true;
      toolCallInProgress = false;
      currentTurnStarted = false;
      processedActionKeys.clear();
      clearTimeout(completionTimer);
      lastTextSent = '';
      snapshotTurnCount = countAssistantTurns();

      // Embed MCP instructions directly in the user message text
      const fullText = MCP_SYSTEM_PROMPT + '\n' + msg.text;
      remoteLog('info', `New prompt — snapshot turns: ${snapshotTurnCount}, injecting ${fullText.length} chars`);
      injectAndSend(fullText);
    }

    else if (msg.type === 'MCP_RESULT') {
      toolCallInProgress = false;
      currentTurnStarted = false;
      processedActionKeys.clear();
      clearTimeout(completionTimer);

      // Re-snapshot so we only read the AI's next (new) response
      snapshotTurnCount = countAssistantTurns();
      lastTextSent = '';

      const formatted = formatToolResult(msg.tool, msg.text, msg.callNum);
      remoteLog('info', `Injecting tool result for: ${msg.tool}`, msg.tool);
      setTimeout(() => injectAndSend(formatted), 1200);
    }

    // ── Backend wants us to open a new AI tab ──
    else if (msg.type === 'OPEN_TAB') {
      remoteLog('info', `Opening new tab: ${msg.url}`);
      chrome.runtime.sendMessage({ type: 'OPEN_TAB', url: msg.url });
    }

    // ── Backend wants us to clear the conversation ──
    else if (msg.type === 'CLEAR_CONVERSATION') {
      remoteLog('info', 'Clearing conversation state');
      agentActive = false;
      toolCallInProgress = false;
      processedActionKeys.clear();
      clearTimeout(completionTimer);
      lastTextSent = '';
      snapshotTurnCount = countAssistantTurns();
    }
  };

  socket.onclose = () => {
    remoteLog('warn', 'Disconnected — retrying in 3s...');
    setTimeout(connect, 3000);
  };

  socket.onerror = (err) => {
    console.warn('[MCP Bridge] WebSocket error', err);
  };

  setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      remoteLog('debug', `Heartbeat (agentActive: ${agentActive})`);
    }
  }, 10000);
}

connect();

function sendRegister() {
  fetch('http://localhost:3000/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: window.location.href }),
  }).catch(() => { });
}

// ─── Format tool result ───
function formatToolResult(tool, text, callNum) {
  const MAX_LEN = 4000;
  const body = text.length > MAX_LEN
    ? text.slice(0, MAX_LEN) + `\n... [truncated]`
    : text;

  return (
    `[TOOL RESULT #${callNum || '?'}: ${tool || 'tool'}]\n` +
    `${body}\n` +
    `[END TOOL RESULT]\n\n` +
    `Continue your reasoning. Output another MCP_ACTION if you need more data, ` +
    `or give your complete final answer if you have enough information (NO MCP_ACTION in the final answer).`
  );
}

// ─── Inject text into chat input and click Send ───
function injectAndSend(text) {
  const input = findInput();
  if (!input) {
    remoteLog('warn', `Input not found — retrying`);
    setTimeout(() => injectAndSend(text), 1000);
    return;
  }

  remoteLog('info', `Injecting ${text.length} chars into ${input.tagName}`);

  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(input, text);
    } else {
      input.value = text;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    // contenteditable (Claude, Gemini)
    input.focus();
    document.execCommand('selectAll', false, null);
    const ok = document.execCommand('insertText', false, text);
    if (!ok || !input.textContent.includes(text.slice(0, 20))) {
      input.innerHTML = '';
      input.textContent = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  setTimeout(() => {
    const sendBtn = findSendButton();

    if (sendBtn && !sendBtn.disabled) {
      remoteLog('info', 'Clicking Send button');
      sendBtn.click();
    } else {
      remoteLog('warn', 'Send button not found or disabled — trying Enter key');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    }
  }, 700);
}

// ─── Scan for new AI response ───
function scanForResponse() {
  if (!currentConfig || !agentActive || toolCallInProgress) return;

  const currentTurns = countAssistantTurns();

  // Wait until a NEW assistant turn appears
  if (!currentTurnStarted) {
    if (currentTurns > snapshotTurnCount) {
      currentTurnStarted = true;
      remoteLog('debug', `New AI turn detected (now ${currentTurns} turns)`);
    } else {
      return; // still showing old content
    }
  }

  const latestText = getLatestResponse();
  if (!latestText) return;

  // ── 1. Detect MCP_ACTION — robust extractor ──
  // Wait until generation is completely finished before parsing tools.
  // This prevents premature truncation on unescaped code blocks while streaming.
  if (!isStillGenerating()) {
    const PREFIX = 'MCP_ACTION:';
    let searchPos = 0;
    while (true) {
      const prefixIdx = latestText.indexOf(PREFIX, searchPos);
    if (prefixIdx === -1) break;
    searchPos = prefixIdx + PREFIX.length;

    const braceStart = latestText.indexOf('{', prefixIdx + PREFIX.length);
    if (braceStart === -1) break;

    // Strategy 1: Balanced-brace walk (works for properly escaped JSON)
    let braceCount = 0, inStr = false, esc = false, balancedBraceEnd = -1;
    for (let j = braceStart; j < latestText.length; j++) {
      const c = latestText[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (c === '{') braceCount++;
        if (c === '}') { braceCount--; if (braceCount === 0) { balancedBraceEnd = j; break; } }
      }
    }

    // Strategy 2: Greedy brace walk
    const nextActionIdx = latestText.indexOf('MCP_ACTION:', searchPos);
    const searchEnd = nextActionIdx !== -1 ? nextActionIdx : latestText.length;
    let greedyBraceEnd = -1;
    for (let j = searchEnd - 1; j > braceStart; j--) {
      if (latestText[j] === '}') { greedyBraceEnd = j; break; }
    }

    if (balancedBraceEnd === -1 && greedyBraceEnd === -1) break; // still streaming

    // Determine the most likely correct json string
    let jsonStr = '';
    let tool = null, args = {};
    let isParseSuccess = false;

    // First try the balanced string
    if (balancedBraceEnd !== -1) {
      jsonStr = latestText.slice(braceStart, balancedBraceEnd + 1);
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed.tool === 'string') {
          tool = parsed.tool;
          args = parsed.args || {};
          isParseSuccess = true;
        }
      } catch (_) {}
    }

    // If balanced string failed (e.g. nested unescaped code braces), use the greedy string
    if (!isParseSuccess && greedyBraceEnd !== -1) {
      jsonStr = latestText.slice(braceStart, greedyBraceEnd + 1);
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed.tool === 'string') {
          tool = parsed.tool;
          args = parsed.args || {};
          isParseSuccess = true;
        }
      } catch (_) {}
    }

    const key = jsonStr.replace(/\s+/g, '').slice(0, 200);
    if (processedActionKeys.has(key)) continue;

    // If both JSON.parse attempts failed, try regex extraction on the greedy string
    if (!isParseSuccess) {
      const toolMatch = jsonStr.match(/"tool"\s*:\s*"([^"]+)"/);
      if (toolMatch) {
        tool = toolMatch[1];
        const argsMatch = jsonStr.match(/"args"\s*:\s*(\{[\s\S]*\})/);
        if (argsMatch) {
          const argsStr = argsMatch[1];
          try { args = JSON.parse(argsStr); } catch (_2) {
            const fields = {};
            const simpleRe = /"(path|manager|package|url|text|message)"\s*:\s*"([^"\n]*)"/g;
            let fm;
            while ((fm = simpleRe.exec(argsStr)) !== null) {
              fields[fm[1]] = fm[2];
            }
            // Extract content/command field using reverse-scan to find the true closing quote
            const contentKeyRe = /"(content|command)"\s*:\s*"/;
            const ckMatch = contentKeyRe.exec(argsStr);
            if (ckMatch) {
              const valStart = ckMatch.index + ckMatch[0].length;
              // Scan backwards from end of argsStr to find the real closing quote
              // (skip past trailing }, whitespace, etc)
              let closeQuote = -1;
              for (let ci = argsStr.length - 1; ci > valStart; ci--) {
                if (argsStr[ci] === '"') {
                  // Verify it's not escaped: count consecutive backslashes before it
                  let bs = 0;
                  for (let bi = ci - 1; bi >= valStart && argsStr[bi] === '\\'; bi--) bs++;
                  if (bs % 2 === 0) { closeQuote = ci; break; } // even backslashes = unescaped quote
                }
              }
              if (closeQuote > valStart) {
                const rawVal = argsStr.slice(valStart, closeQuote);
                fields[ckMatch[1]] = rawVal
                  .replace(/\\n/g, '\n')
                  .replace(/\\t/g, '\t')
                  .replace(/\\"/g, '"')
                  .replace(/\\\\/g, '\\');
              }
            }
            args = fields;
          }
        }
      }
    }


    if (tool) {
      processedActionKeys.add(key);
      toolCallInProgress = true;
      clearTimeout(completionTimer);
      remoteLog('info', `🔧 Tool call detected: ${tool}`, tool);
      sendActionToBackend({ tool, args });
    }
    }
  }


  // ── 2. Stream incremental text ──
  if (latestText.length > lastTextSent.length) {
    const newText = latestText.slice(lastTextSent.length);
    const hasProtocol = newText.includes('MCP_ACTION') || newText.includes('[TOOL RESULT');
    if (!hasProtocol && newText.trim()) {
      sendToBackend('ai-stream', { text: newText });
    }
    lastTextSent = latestText;
    scheduleCompletion();
  }
}

const observer = new MutationObserver(() => scanForResponse());
setInterval(scanForResponse, 500);

function isStillGenerating() {
  const stopBtn = (currentConfig?.stopBtn) ?
    document.querySelector(currentConfig.stopBtn) :
    (document.querySelector('button[aria-label*="Stop"]') || document.querySelector('.stop-button'));

  return stopBtn && stopBtn.offsetParent !== null;
}

function scheduleCompletion() {
  clearTimeout(completionTimer);
  completionTimer = setTimeout(() => {
    if (!agentActive || !lastTextSent || toolCallInProgress) return;

    if (isStillGenerating()) {
      remoteLog('debug', 'Still generating...');
      scheduleCompletion();
      return;
    }

    const currentText = getLatestResponse();
    if (currentText.length > lastTextSent.length) {
      lastTextSent = currentText;
      scheduleCompletion();
      return;
    }

    // Only complete if we did NOT make a tool call this turn
    if (processedActionKeys.size === 0) {
      remoteLog('info', `AI done — sending AI_COMPLETE`);
      remoteLog('debug', `FINAL TEXT: ${lastTextSent}`);
      sendToBackend('ai-complete', {});
      agentActive = false;
    } else {
      remoteLog('debug', 'Tool was called — not sending AI_COMPLETE, waiting for MCP_RESULT');
    }
  }, 3000);
}

observer.observe(document.body, { childList: true, subtree: true, characterData: true });

remoteLog('info', `Extension active v2.3 — Direct Prompt Mode 🤖`);
