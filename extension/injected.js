(function () {
  if (window.__MCP_BRIDGE_PATCHED__) return;
  window.__MCP_BRIDGE_PATCHED__ = true;

  // ─── System prompt — teaches the AI how to call MCP tools ───
  const BRIDGE_PROMPT = `

---
[MCP Bridge — AGENT MODE — CRITICAL INSTRUCTIONS]
YOU ARE A LOCAL AGENT RUNTIME with DIRECT access to the user's computer via MCP tools.
DO NOT provide disclaimers. DO NOT say you cannot access files or run commands.
YOU CAN AND MUST use tools for ALL file/system tasks.

TOOL CALL FORMAT — Output EXACTLY this format to execute a tool:
MCP_ACTION: {"tool":"<tool_name>","args":{<arguments>}}

AVAILABLE TOOLS:
  list_directory    → {"path": "."}
  read_file         → {"path": "relative/path"}
  write_file        → {"path": "file.txt", "content": "..."}
  run_shell_command → {"command": "ls -la"}
  search_files      → {"pattern": "TODO", "directory": "."}
  get_system_info   → {}

CRITICAL OUTPUT RULES:
1. When you decide to call a tool, your ENTIRE response MUST be ONLY the single MCP_ACTION line.
   DO NOT write ANY text before or after it. No "I'll do that", no "Sure!", no explanations.
   WRONG: "I'll create that folder for you!\nMCP_ACTION: {...}"
   RIGHT: "MCP_ACTION: {...}"
2. Output ONE MCP_ACTION, then STOP. Wait for [TOOL RESULT #N: ...].
3. If the user asks for local files, git, or system state, call a tool FIRST.
4. Final answer: give a comprehensive answer ONLY after all tools have run, with NO MCP_ACTION.
---
`;

  // ─── AI endpoint detection ───
  function isAiEndpoint(url) {
    const u = String(url).toLowerCase();
    return (
      u.includes('/backend-api/conversation') ||      // ChatGPT web
      u.includes('/v1/messages') ||                   // Claude API
      u.includes('/append_message') ||                // Claude web
      u.includes('/chat_conversations') ||            // Claude web alt
      u.includes('/api/organizations') ||             // Claude web org
      u.includes('generatecontent') ||                // Gemini API
      u.includes('streamgeneratecontent') ||          // Gemini streaming
      u.includes('bardchatui') ||                     // Gemini consumer (Bard legacy)
      u.includes('assistant.v1.assistant/chat') ||    // Gemini consumer modern
      u.includes('/completions') ||                   // OpenAI completions
      u.includes('/conversation') ||                  // Generic
      u.includes('/messages')                         // Generic
    );
  }

  // ─── Recursive payload injection ───
  // Walks the request body and appends the bridge prompt to the last user message.
  function injectIntoObject(obj, depth) {
    if (depth > 10 || !obj || typeof obj !== 'object') return false;

    // ── ChatGPT web: { action: "next", messages: [...] } ──
    if (obj.action === 'next' && Array.isArray(obj.messages)) {
      // 1. Try to inject as a system message if possible (often fails but worth having)
      // 2. Fallback to prepending to the last user message
      const lastUser = [...obj.messages].reverse().find(m => m.author?.role === 'user');
      if (lastUser?.content?.parts) {
        for (let i = 0; i < lastUser.content.parts.length; i++) {
          if (typeof lastUser.content.parts[i] === 'string' &&
            !lastUser.content.parts[i].includes('MCP Bridge')) {
            lastUser.content.parts[i] = BRIDGE_PROMPT + '\n' + lastUser.content.parts[i];
            return true;
          }
        }
      }
    }

    // ── OpenAI / Claude API: { messages: [{role, content}] } ──
    if (Array.isArray(obj.messages) && obj.messages.length) {
      const last = obj.messages[obj.messages.length - 1];
      if (last) {
        if (typeof last.content === 'string' && !last.content.includes('MCP Bridge')) {
          last.content += BRIDGE_PROMPT;
          return true;
        }
        if (Array.isArray(last.content)) {
          const textPart = [...last.content].reverse().find(p => p?.type === 'text');
          if (textPart && !textPart.text.includes('MCP Bridge')) {
            textPart.text += BRIDGE_PROMPT;
            return true;
          }
        }
      }
    }

    // ── Gemini: { contents: [{ role, parts: [{ text }] }] } ──
    if (Array.isArray(obj.contents) && obj.contents.length) {
      // Find the last user turn
      const lastUserContent = [...obj.contents].reverse().find(c => c.role === 'user' || !c.role);
      if (lastUserContent) {
        if (Array.isArray(lastUserContent.parts) && lastUserContent.parts.length) {
          const lastPart = lastUserContent.parts[lastUserContent.parts.length - 1];
          if (lastPart?.text && !lastPart.text.includes('MCP Bridge')) {
            lastPart.text += BRIDGE_PROMPT;
            return true;
          }
        }
      }
      // Fallback — last content item
      const last = obj.contents[obj.contents.length - 1];
      if (Array.isArray(last?.parts) && last.parts.length) {
        const lastPart = last.parts[last.parts.length - 1];
        if (lastPart?.text && !lastPart.text.includes('MCP Bridge')) {
          lastPart.text += BRIDGE_PROMPT;
          return true;
        }
      }
    }

    // ── Flat string fields (fallback) ──
    for (const key of ['prompt', 'text', 'query', 'input', 'userMessage', 'message']) {
      if (typeof obj[key] === 'string' && obj[key].length > 5 && !obj[key].includes('MCP Bridge')) {
        obj[key] += BRIDGE_PROMPT;
        return true;
      }
    }

    // ── Deep recursive search ──
    for (const key of Object.keys(obj)) {
      if (obj[key] && typeof obj[key] === 'object') {
        if (injectIntoObject(obj[key], depth + 1)) return true;
      }
    }

    return false;
  }

  function processBody(bodyStr, isBinary) {
    try {
      if (bodyStr.includes('MCP Bridge')) return null; // Already injected
      const body = JSON.parse(bodyStr);
      if (injectIntoObject(body, 0)) {
        const result = JSON.stringify(body);
        return isBinary ? new TextEncoder().encode(result) : result;
      }
    } catch (e) {
      // Not JSON or injection failed — skip silently
    }
    return null;
  }

  // ─── Override window.fetch ───
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = input instanceof Request ? input.url : String(input);
    if (isAiEndpoint(url) && init?.method === 'POST') {
      let bodyStr = null;
      let isBinary = false;

      if (typeof init.body === 'string') {
        bodyStr = init.body;
      } else if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) {
        bodyStr = new TextDecoder().decode(init.body);
        isBinary = true;
      }

      if (bodyStr) {
        const newBody = processBody(bodyStr, isBinary);
        if (newBody) init = { ...init, body: newBody };
      }
    }
    return originalFetch(input, init);
  };

  // ─── Override XMLHttpRequest ───
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__mcpUrl = url;
    this.__mcpMethod = method;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (typeof body === 'string' && this.__mcpUrl && this.__mcpMethod === 'POST' && isAiEndpoint(this.__mcpUrl)) {
      const newBody = processBody(body, false);
      if (newBody) body = newBody;
    }
    return origSend.call(this, body);
  };

  console.log('[MCP Bridge] Injected — fetch + XHR patched ✓');
})();
