import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { exec, spawn } from "child_process";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";

// ─── Limits ───
const MAX_OUTPUT_CHARS = 8000;
let currentCwd = process.cwd();

// Background process registry  { id -> { proc, output, exitCode } }
const bgProcesses = new Map();
let bgNextId = 1;

// Canonical list of every tool name — returned verbatim in "Unknown tool" errors
// so the AI can correct itself without guessing.
const VALID_TOOLS = [
  'read_file','write_file','append_file','delete_file','list_directory','search_files',
  'run_terminal','run_background','get_background_output','kill_process',
  'get_running_processes','set_cwd','get_env','get_system_info',
  'open_url','open_application','focus_window','list_windows',
  'send_keys','type_text','mouse_click','take_screenshot',
  'get_clipboard','set_clipboard','get_screen_resolution',
  'speak_text','send_notification','install_package','open_path'
];

function truncate(text, label = '') {
  if (!text) return '(no output)';
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) +
    `\n\n... [truncated — ${text.length - MAX_OUTPUT_CHARS} chars omitted${label ? ` in ${label}` : ''}]`;
}

function safeJoin(base, rel) {
  const resolved = path.resolve(base, rel || '.');
  return resolved; // No sandbox restriction — user requested full access
}

function execAsync(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, { cwd: currentCwd, timeout: 30000, maxBuffer: 10 * 1024 * 1024, ...opts },
      (error, stdout, stderr) => {
        const out = [stdout, stderr ? `\nSTDERR:\n${stderr}` : ''].join('').trim() || '(no output)';
        resolve({ out, error, stdout, stderr });
      });
  });
}

// ─── Server ───
const server = new Server(
  { name: 'mcp-bridge-server', version: '3.0.0' },
  { capabilities: { tools: {} } }
);

// ─── Tool Definitions ───
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [

    // ════════════════════════════════
    //  FILE SYSTEM TOOLS (original)
    // ════════════════════════════════
    {
      name: 'read_file',
      description: 'Reads the contents of a file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Writes (or overwrites) a file with given content, creating parent dirs as needed.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path' },
          content: { type: 'string', description: 'Text content to write' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'append_file',
      description: 'Appends text to an existing file (or creates it).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'delete_file',
      description: 'Deletes a file or empty directory.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    {
      name: 'list_directory',
      description: 'Lists files and folders in a directory.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default: current working dir)' },
        },
      },
    },
    {
      name: 'search_files',
      description: 'Grep for a text pattern across files.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          directory: { type: 'string', description: 'Directory to search (default: cwd)' },
          file_types: { type: 'string', description: 'Comma-separated extensions e.g. "js,ts,py"' },
        },
        required: ['pattern'],
      },
    },

    // ════════════════════════════════
    //  TERMINAL TOOLS
    // ════════════════════════════════
    {
      name: 'run_terminal',
      description: 'Runs ANY shell command synchronously and returns stdout+stderr. ' +
        'Full access — no allowlist. Use for: install packages, compile, test, git, ' +
        'move/copy files, curl, python scripts, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command string to execute' },
          cwd: { type: 'string', description: 'Working directory override (optional)' },
          timeout_seconds: { type: 'number', description: 'Max seconds to wait (default 30)' },
        },
        required: ['command'],
      },
    },
    {
      name: 'run_background',
      description: 'Starts a long-running process in the background (e.g. a dev server). ' +
        'Returns a process ID you can use with get_background_output and kill_process.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run in background' },
          cwd: { type: 'string', description: 'Working directory (optional)' },
          label: { type: 'string', description: 'Human-readable label e.g. "dev-server"' },
        },
        required: ['command'],
      },
    },
    {
      name: 'get_background_output',
      description: 'Returns buffered stdout/stderr from a background process.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Process ID returned by run_background' },
        },
        required: ['id'],
      },
    },
    {
      name: 'kill_process',
      description: 'Kills a background process by its ID.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Process ID from run_background' },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_running_processes',
      description: 'Lists currently running background processes started via run_background.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'set_cwd',
      description: 'Changes the working directory used by run_terminal and other tools.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to new cwd' },
        },
        required: ['path'],
      },
    },
    {
      name: 'get_env',
      description: 'Returns environment variables. Pass names array for specific vars, or empty for all.',
      inputSchema: {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' }, description: 'Env var names (optional)' },
        },
      },
    },
    {
      name: 'get_system_info',
      description: 'Returns OS, CPU, memory, cwd, Node version, hostname.',
      inputSchema: { type: 'object', properties: {} },
    },

    // ════════════════════════════════
    //  APP NAVIGATION TOOLS
    // ════════════════════════════════
    {
      name: 'open_url',
      description: 'Opens a URL in the default browser (or a specific browser).',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open' },
          browser: { type: 'string', description: 'Browser to use: "chrome", "firefox", "chromium" (default: system default)' },
        },
        required: ['url'],
      },
    },
    {
      name: 'open_application',
      description: 'Launches a desktop application by name or executable path.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'App name or path, e.g. "code", "nautilus", "vlc", "/usr/bin/gedit"' },
          args: { type: 'array', items: { type: 'string' }, description: 'Optional command-line arguments' },
        },
        required: ['app'],
      },
    },
    {
      name: 'focus_window',
      description: 'Brings a window to the foreground by its title substring (uses wmctrl).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Substring of the window title to focus' },
        },
        required: ['title'],
      },
    },
    {
      name: 'list_windows',
      description: 'Lists all open windows with their titles and IDs (uses wmctrl).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'send_keys',
      description: 'Sends keyboard shortcuts or key sequences to the focused window (uses xdotool). ' +
        'Examples: "ctrl+c", "ctrl+alt+t", "Return", "super".',
      inputSchema: {
        type: 'object',
        properties: {
          keys: { type: 'string', description: 'Key combo, e.g. "ctrl+s", "alt+F4", "Return"' },
          window_title: { type: 'string', description: 'Focus this window first (optional)' },
        },
        required: ['keys'],
      },
    },
    {
      name: 'type_text',
      description: 'Types a string of text into the currently focused input (uses xdotool type).',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
          delay_ms: { type: 'number', description: 'Delay between keystrokes ms (default 20)' },
        },
        required: ['text'],
      },
    },
    {
      name: 'mouse_click',
      description: 'Moves the mouse to (x, y) and clicks. Button: 1=left, 2=middle, 3=right.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          button: { type: 'number', description: '1=left, 2=middle, 3=right (default 1)' },
          double: { type: 'boolean', description: 'Double-click if true' },
        },
        required: ['x', 'y'],
      },
    },
    {
      name: 'take_screenshot',
      description: 'Captures a screenshot of the entire screen or a specific window and saves it to a file.',
      inputSchema: {
        type: 'object',
        properties: {
          output_path: { type: 'string', description: 'File path to save PNG (default: /tmp/screenshot.png)' },
          window_title: { type: 'string', description: 'Capture only this window (optional, uses title match)' },
        },
      },
    },
    {
      name: 'get_clipboard',
      description: 'Returns the current clipboard text content.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'set_clipboard',
      description: 'Sets the clipboard to the given text.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to copy to clipboard' },
        },
        required: ['text'],
      },
    },
    {
      name: 'get_screen_resolution',
      description: 'Returns the current display resolution.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'speak_text',
      description: 'Uses text-to-speech to speak a message (uses espeak or spd-say).',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message to speak' },
          speed: { type: 'number', description: 'Speaking speed (default 150)' }
        },
        required: ['text'],
      },
    },
    {
      name: 'send_notification',
      description: 'Sends a desktop notification (uses notify-send).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Notification title' },
          message: { type: 'string', description: 'Notification body' },
          urgency: { type: 'string', description: 'low, normal, critical' }
        },
        required: ['message'],
      },
    },
    {
      name: 'install_package',
      description: 'Installs a package using various manager (npm, pip, apt).',
      inputSchema: {
        type: 'object',
        properties: {
          manager: { type: 'string', description: 'npm, pip, or apt' },
          package: { type: 'string', description: 'Name of the package' }
        },
        required: ['manager', 'package'],
      },
    },
    {
      name: 'open_path',
      description: 'Opens a file or folder using the system default handler (xdg-open).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to file or folder' }
        },
        required: ['path'],
      },
    },
  ],
}));

// ─── Tool Handlers ───
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {

      // ── File tools ──────────────────────────────────────────────────────

      case 'read_file': {
        const fp = safeJoin(currentCwd, args.path);
        const data = await fs.readFile(fp, 'utf-8');
        return { content: [{ type: 'text', text: truncate(data, args.path) }] };
      }

      case 'write_file': {
        const fp = safeJoin(currentCwd, args.path);
        await fs.mkdir(path.dirname(fp), { recursive: true });
        await fs.writeFile(fp, args.content, 'utf-8');
        return { content: [{ type: 'text', text: `✅ Wrote ${args.content.length} bytes to ${fp}` }] };
      }

      case 'append_file': {
        const fp = safeJoin(currentCwd, args.path);
        await fs.mkdir(path.dirname(fp), { recursive: true });
        await fs.appendFile(fp, args.content, 'utf-8');
        return { content: [{ type: 'text', text: `✅ Appended ${args.content.length} bytes to ${fp}` }] };
      }

      case 'delete_file': {
        const fp = safeJoin(currentCwd, args.path);
        await fs.rm(fp, { recursive: false });
        return { content: [{ type: 'text', text: `✅ Deleted ${fp}` }] };
      }

      case 'list_directory': {
        const dp = safeJoin(currentCwd, args.path || '.');
        const entries = await fs.readdir(dp, { withFileTypes: true });
        const list = entries.map(e => {
          if (e.isDirectory()) return `📁 ${e.name}/`;
          const ext = path.extname(e.name).toLowerCase();
          const icon =
            ['.js', '.ts', '.jsx', '.tsx', '.mjs'].includes(ext) ? '📜' :
            ['.json', '.yaml', '.yml', '.toml', '.env'].includes(ext) ? '⚙️' :
            ['.md', '.txt', '.rst'].includes(ext) ? '📝' :
            ['.py', '.rb', '.go', '.rs', '.php'].includes(ext) ? '🐍' :
            ext === '.sh' ? '🔧' : '📄';
          return `${icon} ${e.name}`;
        }).join('\n');
        return { content: [{ type: 'text', text: list || '(empty directory)' }] };
      }

      case 'search_files': {
        const dir = safeJoin(currentCwd, args.directory || '.');
        const safePattern = (args.pattern || '').replace(/'/g, "\\'");
        const types = (args.file_types || 'js,ts,jsx,tsx,json,md,txt,yaml,yml,sh,py,css,html').split(',');
        const includes = types.map(t => `--include="*.${t.trim()}"`).join(' ');
        const cmd = `grep -rn ${includes} -i '${safePattern}' '${dir}' 2>/dev/null | head -50`;
        const { stdout } = await execAsync(cmd, {});
        return { content: [{ type: 'text', text: stdout.trim() || `No matches for: ${args.pattern}` }] };
      }

      // ── Terminal tools ──────────────────────────────────────────────────

      case 'run_terminal': {
        const cwd = args.cwd ? path.resolve(currentCwd, args.cwd) : currentCwd;
        const timeout = (args.timeout_seconds || 30) * 1000;
        const { out, error } = await execAsync(args.command, { cwd, timeout });
        const label = error ? `⚠️ exit error` : '✅';
        return { content: [{ type: 'text', text: `${label}\n${truncate(out, args.command)}` }], isError: !!error };
      }

      case 'run_background': {
        const id = bgNextId++;
        const cwd = args.cwd ? path.resolve(currentCwd, args.cwd) : currentCwd;
        const label = args.label || `proc-${id}`;
        let output = '';

        const proc = spawn('bash', ['-c', args.command], {
          cwd,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stdout.on('data', d => { output += d.toString(); if (output.length > 50000) output = output.slice(-40000); });
        proc.stderr.on('data', d => { output += d.toString(); if (output.length > 50000) output = output.slice(-40000); });

        let exitCode = null;
        proc.on('exit', code => { exitCode = code; });

        bgProcesses.set(id, { proc, label, get output() { return output; }, get exitCode() { return exitCode; } });
        return { content: [{ type: 'text', text: `✅ Started background process #${id} [${label}]\nPID: ${proc.pid}\nCommand: ${args.command}` }] };
      }

      case 'get_background_output': {
        const entry = bgProcesses.get(Number(args.id));
        if (!entry) return { content: [{ type: 'text', text: `❌ No background process #${args.id}` }], isError: true };
        const status = entry.exitCode !== null ? `Exited: ${entry.exitCode}` : 'Running';
        return { content: [{ type: 'text', text: `Process #${args.id} [${entry.label}] — ${status}\n\n${truncate(entry.output)}` }] };
      }

      case 'kill_process': {
        const entry = bgProcesses.get(Number(args.id));
        if (!entry) return { content: [{ type: 'text', text: `❌ No background process #${args.id}` }], isError: true };
        entry.proc.kill('SIGTERM');
        bgProcesses.delete(Number(args.id));
        return { content: [{ type: 'text', text: `✅ Killed process #${args.id} [${entry.label}]` }] };
      }

      case 'get_running_processes': {
        if (bgProcesses.size === 0) return { content: [{ type: 'text', text: '(no background processes running)' }] };
        const list = [...bgProcesses.entries()].map(([id, e]) =>
          `#${id} [${e.label}] — ${e.exitCode !== null ? 'Exited: ' + e.exitCode : 'Running'}`
        ).join('\n');
        return { content: [{ type: 'text', text: list }] };
      }

      case 'set_cwd': {
        const next = path.resolve(currentCwd, args.path);
        try {
          const stat = await fs.stat(next);
          if (!stat.isDirectory()) throw new Error('Not a directory');
          currentCwd = next;
          return { content: [{ type: 'text', text: `✅ Working directory changed to: ${currentCwd}` }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `❌ ${e.message}` }], isError: true };
        }
      }

      case 'get_env': {
        const names = args.names;
        if (names && names.length > 0) {
          const result = {};
          for (const k of names) result[k] = process.env[k] ?? null;
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(process.env, null, 2) }] };
      }

      case 'get_system_info': {
        return {
          content: [{
            type: 'text', text: JSON.stringify({
              platform: os.platform(), arch: os.arch(),
              hostname: os.hostname(), cwd: currentCwd,
              home: os.homedir(), node_version: process.version,
              memory_free_mb: Math.round(os.freemem() / 1024 / 1024),
              memory_total_mb: Math.round(os.totalmem() / 1024 / 1024),
              uptime_minutes: Math.round(os.uptime() / 60),
              cpu_model: os.cpus()[0]?.model || 'unknown',
              cpu_cores: os.cpus().length,
            }, null, 2),
          }],
        };
      }

      // ── App navigation tools ────────────────────────────────────────────

      case 'open_url': {
        const url = args.url;
        let cmd;
        switch ((args.browser || '').toLowerCase()) {
          case 'chrome':     cmd = `google-chrome "${url}"`; break;
          case 'chromium':   cmd = `chromium-browser "${url}"`; break;
          case 'firefox':    cmd = `firefox "${url}"`; break;
          default:           cmd = `xdg-open "${url}"`; break;
        }
        const { out } = await execAsync(cmd);
        return { content: [{ type: 'text', text: `✅ Opened URL: ${url}\n${out}` }] };
      }

      case 'open_application': {
        const appArgs = (args.args || []).join(' ');
        const { out, error } = await execAsync(`${args.app} ${appArgs} &`);
        return { content: [{ type: 'text', text: `✅ Launched: ${args.app} ${appArgs}\n${out}` }], isError: !!error };
      }

      case 'focus_window': {
        const { out, error } = await execAsync(`wmctrl -a "${args.title}"`);
        if (error) return { content: [{ type: 'text', text: `❌ wmctrl error: ${out}\nMake sure wmctrl is installed: sudo apt install wmctrl` }], isError: true };
        return { content: [{ type: 'text', text: `✅ Focused window matching: "${args.title}"` }] };
      }

      case 'list_windows': {
        const { out, error } = await execAsync('wmctrl -l');
        if (error) return { content: [{ type: 'text', text: `❌ wmctrl error: ${out}\nInstall with: sudo apt install wmctrl` }], isError: true };
        return { content: [{ type: 'text', text: out }] };
      }

      case 'send_keys': {
        let cmd = '';
        if (args.window_title) {
          cmd += `wmctrl -a "${args.window_title}" && sleep 0.2 && `;
        }
        cmd += `xdotool key "${args.keys}"`;
        const { out, error } = await execAsync(cmd);
        if (error) return { content: [{ type: 'text', text: `❌ xdotool error: ${out}\nInstall with: sudo apt install xdotool` }], isError: true };
        return { content: [{ type: 'text', text: `✅ Sent keys: ${args.keys}` }] };
      }

      case 'type_text': {
        const delay = args.delay_ms ?? 20;
        const safeText = args.text.replace(/"/g, '\\"');
        const { out, error } = await execAsync(`xdotool type --delay ${delay} "${safeText}"`);
        if (error) return { content: [{ type: 'text', text: `❌ xdotool error: ${out}\nInstall with: sudo apt install xdotool` }], isError: true };
        return { content: [{ type: 'text', text: `✅ Typed ${args.text.length} characters` }] };
      }

      case 'mouse_click': {
        const btn = args.button ?? 1;
        const dbl = args.double ? '--repeat 2 --delay 100' : '';
        const { out, error } = await execAsync(`xdotool mousemove ${args.x} ${args.y} && xdotool click ${dbl} ${btn}`);
        if (error) return { content: [{ type: 'text', text: `❌ xdotool error: ${out}` }], isError: true };
        return { content: [{ type: 'text', text: `✅ Clicked (${args.x}, ${args.y}) button=${btn}` }] };
      }

      case 'take_screenshot': {
        const output = args.output_path || '/tmp/screenshot.png';
        let cmd;
        if (args.window_title) {
          cmd = `import -window "$(xdotool search --name '${args.window_title}' | head -1)" "${output}"`;
        } else {
          // Try scrot first, fall back to import (ImageMagick)
          cmd = `scrot "${output}" 2>/dev/null || import -window root "${output}"`;
        }
        const { out, error } = await execAsync(cmd);
        if (error && !existsSync(output)) {
          return { content: [{ type: 'text', text: `❌ Screenshot failed: ${out}\nInstall scrot: sudo apt install scrot` }], isError: true };
        }
        return { content: [{ type: 'text', text: `✅ Screenshot saved to: ${output}` }] };
      }

      case 'get_clipboard': {
        const { out, error } = await execAsync('xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null || wl-paste 2>/dev/null');
        if (error) return { content: [{ type: 'text', text: `❌ Clipboard read failed: ${out}\nInstall: sudo apt install xclip` }], isError: true };
        return { content: [{ type: 'text', text: out || '(clipboard empty)' }] };
      }

      case 'set_clipboard': {
        const safe = args.text.replace(/'/g, "'\\''");
        const { out, error } = await execAsync(
          `echo '${safe}' | xclip -selection clipboard 2>/dev/null || ` +
          `echo '${safe}' | xsel --clipboard --input 2>/dev/null || ` +
          `echo '${safe}' | wl-copy 2>/dev/null`
        );
        if (error) return { content: [{ type: 'text', text: `❌ Clipboard write failed. Install: sudo apt install xclip` }], isError: true };
        return { content: [{ type: 'text', text: `✅ Clipboard set (${args.text.length} chars)` }] };
      }

      case 'get_screen_resolution': {
        const { out } = await execAsync(`xrandr 2>/dev/null | grep ' connected' | grep -o '[0-9]*x[0-9]*+0+0' | head -1`);
        const res = out.trim().replace(/\+.*/, '') || 'unknown';
        return { content: [{ type: 'text', text: `Screen resolution: ${res}` }] };
      }

      case 'speak_text': {
        const cmd = `spd-say "${args.text.replace(/"/g, '')}" || espeak "${args.text.replace(/"/g, '')}" -s ${args.speed || 150}`;
        const { out, error } = await execAsync(cmd);
        return { content: [{ type: 'text', text: `✅ Said: ${args.text}` }], isError: !!error };
      }

      case 'send_notification': {
        const urgency = args.urgency || 'normal';
        const title = args.title || 'MCP Bridge';
        const cmd = `notify-send -u ${urgency} "${title}" "${args.message}"`;
        const { out, error } = await execAsync(cmd);
        return { content: [{ type: 'text', text: `✅ Notification sent` }], isError: !!error };
      }

      case 'install_package': {
        let cmd = '';
        if (args.manager === 'npm') cmd = `npm install ${args.package}`;
        else if (args.manager === 'pip') cmd = `pip install ${args.package}`;
        else if (args.manager === 'apt') cmd = `sudo apt-get install -y ${args.package}`;
        else return { content: [{ type: 'text', text: `❌ Unknown manager: ${args.manager}` }], isError: true };
        
        const { out, error } = await execAsync(cmd);
        return { content: [{ type: 'text', text: `${error ? '⚠️' : '✅'} ${cmd}\n${truncate(out)}` }], isError: !!error };
      }

      case 'open_path': {
        const fp = safeJoin(currentCwd, args.path);
        const { out, error } = await execAsync(`xdg-open "${fp}"`);
        return { content: [{ type: 'text', text: `✅ Opened: ${fp}` }], isError: !!error };
      }

      default: {
        // Return the valid tool list so the AI stops guessing
        const hint = VALID_TOOLS.join(', ');
        return {
          content: [{ type: 'text', text:
            `❌ Unknown tool: "${name}"\n\n` +
            `VALID TOOL NAMES (use EXACTLY one of these, no others exist):\n${VALID_TOOLS.map(t => `  - ${t}`).join('\n')}\n\n` +
            `COMMON MAPPINGS:\n` +
            `  create_directory / mkdir / make_directory   → run_terminal with command "mkdir -p <path>"\n` +
            `  shell_execute / exec / run_command          → run_terminal\n` +
            `  create_file / make_file                     → write_file\n` +
            `  open_browser / navigate                     → open_url\n` +
            `Retry immediately using the EXACT correct tool name from the list above.`
          }],
          isError: true,
        };
      }
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error in ${name}: ${error.message}` }],
      isError: true,
    };
  }
});

// ─── Start ───
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[MCP Server] Ready — 22 tools available — cwd: ${currentCwd}`);
}

main().catch((err) => {
  console.error('[MCP Server] Fatal error:', err);
  process.exit(1);
});
