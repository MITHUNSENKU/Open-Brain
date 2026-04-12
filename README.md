# Open Brain

> **Claude Code, but using your browser's AI as the brain.**

A local agent runtime that uses browser-based AI models (ChatGPT, Claude, Gemini) as the reasoning engine, connected to local MCP tools for file system access, shell commands, and more.

## How It Works

```
You type → CLI → Backend → Chrome Extension → Browser AI
                                                  ↓
                                          AI thinks + calls tools
                                                  ↓
                              MCP Server ← Backend ← Extension
                                  ↓
                          executes locally (ls, read, grep, etc.)
                                  ↓
                          result sent back → AI reasons again...
                                  ↓
                          Final report → CLI displays it beautifully ✨
```

## Quick Start

### 1. Install dependencies

For macOS and Linux:
```bash
chmod +x install.sh
./install.sh
```

For Windows:
```cmd
install.bat
```

### 2. Load the Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder

### 3. Start the backend

```bash
cd backend && node server.js
```

### 4. Open your AI

Open [ChatGPT](https://chatgpt.com), [Claude](https://claude.ai), or [Gemini](https://gemini.google.com) in Chrome.

### 5. Start the CLI

```bash
openbrain
```

### 6. Ask anything

```
bridge> list all JavaScript files and summarize the project
bridge> search for any TODO comments in the codebase
bridge> what's in my package.json?
bridge> run git log --oneline -5 and explain recent changes
```

## Tools Available

| Tool | Description |
|------|-------------|
| `list_directory` | List files and folders |
| `read_file` | Read file contents |
| `write_file` | Create or overwrite files |
| `run_shell_command` | Run shell commands (ls, git, grep, find, etc.) |
| `search_files` | Search text patterns across files |
| `get_system_info` | OS, memory, Node version, cwd |

## Architecture

| Component | File | Role |
|-----------|------|------|
| **CLI** | `cli.js` | User interface with spinners and formatted reports |
| **Backend** | `backend/server.js` | WebSocket relay + agentic state machine |
| **MCP Client** | `backend/mcp-client.js` | Connects to MCP server via stdio |
| **Extension** | `extension/` | Injects tool context into browser AI, reads responses |
| **MCP Server** | `mcp-server/index.js` | Executes tools locally |

## Security

- Shell commands are restricted to an allowlist: `ls`, `pwd`, `cat`, `echo`, `mkdir`, `rm`, `git`, `find`, `wc`, `grep`, `tree`
- Max 10 tool calls per session to prevent runaway loops
- Output truncated at 4000 characters
- File operations scoped to the working directory

## License

MIT

## Advanced Configuration

### Adding New Tools
To add custom local tools:
1. Open `mcp-server/index.js`
2. Add your tool name to the `VALID_TOOLS` array at the top.
3. Define the tool's input schema in the `ListToolsRequestSchema` handler.
4. Implement the tool's execution logic inside the `CallToolRequestSchema` switch statement.

### Using an Existing MCP Server
By default, the bridge uses its own bundled MCP server. To use an external or official MCP server (e.g., Postgres, GitHub):
1. Open `backend/mcp-client.js`.
2. Locate `new StdioClientTransport(...)`.
3. Change the `command` and `args` to start your custom MCP server. For example:
   ```javascript
   this.transport = new StdioClientTransport({
     command: "npx",
     args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"],
   });
   ```

### Adding New AI Websites
To support a new browser-based AI interface:
1. **Permissions:** In `extension/manifest.json`, add the website's URL to both `host_permissions` and the `matches` arrays under `content_scripts`.
2. **Endpoint Detection:** In `extension/injected.js`, update the `isAiEndpoint(url)` function to match the API endpoint the web UI uses to submit chat messages (e.g., `/api/chat`).
3. **Payload Injection:** If the AI uses a standard JSON payload format, `injectIntoObject` in `extension/injected.js` should automatically inject the hidden system prompt. If the site uses a highly custom payload, you may need to add a custom parser case for it inside the `injectIntoObject` function.
