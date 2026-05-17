#!/usr/bin/env node

import WebSocket from 'ws';
import readline from 'readline';
import chalk from 'chalk';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { exec, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const WS_URL = 'ws://localhost:3000?type=cli';
const REPORT_WIDTH = 76;
const SHELL_TIMEOUT_MS = 20000;

// ─── Detect project context ───
const CWD = process.cwd();
const PROJECT_NAME = path.basename(CWD);
let USER = 'user';
try { USER = os.userInfo().username || 'user'; } catch (e) {}
let shellCwd = CWD;
let lastShellCommand = '';
let lastShellOutput = '';

function shortCwd(dir) {
  return dir.replace(os.homedir(), '~');
}

// ─── Spinner ───
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerTimer = null;
let spinnerIdx = 0;
let spinnerMsg = '';
let spinnerActive = false;

function startSpinner(msg) {
  stopSpinner();
  spinnerMsg = msg;
  spinnerActive = true;
  spinnerIdx = 0;
  spinnerTimer = setInterval(() => {
    if (!spinnerActive) return;
    const frame = FRAMES[spinnerIdx++ % FRAMES.length];
    // Use readline to properly clear and overwrite the line
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`  ${chalk.cyan(frame)} ${chalk.gray(spinnerMsg)}`);
  }, 100);
}

function stopSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
  if (spinnerActive) {
    spinnerActive = false;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}

// ─── Formatting ───
function printBanner() {
  console.clear();
  const bar = '─'.repeat(REPORT_WIDTH);
  console.log();
  console.log(chalk.bold.cyan('  ┌' + bar + '┐'));
  console.log(chalk.bold.cyan('  │') + chalk.bold.white('  🤖  Browser AI Agent  ·  MCP Bridge v2.0') + ' '.repeat(REPORT_WIDTH - 43) + chalk.bold.cyan('│'));
  console.log(chalk.bold.cyan('  │') + chalk.gray(`  Using browser AI as the reasoning engine`) + ' '.repeat(REPORT_WIDTH - 43) + chalk.bold.cyan('│'));
  console.log(chalk.bold.cyan('  └' + bar + '┘'));
  console.log();
  console.log(chalk.gray('  Project : ') + chalk.bold.white(PROJECT_NAME));
  console.log(chalk.gray('  Workdir : ') + chalk.white(shortCwd(shellCwd)));
  console.log(chalk.gray('  User    : ') + chalk.white(USER));
  console.log(chalk.gray('  Backend : ') + chalk.green('ws://localhost:3000'));
  console.log();
  console.log(chalk.gray('  Type a natural-language request, or run shell commands like `cd`, `ls`, `pwd`, `git status`.'));
  console.log(chalk.gray('  Prefix with ') + chalk.yellow('!') + chalk.gray(' to force local shell execution.'));
  console.log(chalk.gray('  Commands: ') + chalk.yellow('/clear') + chalk.gray('  ') + chalk.yellow('/exit') + chalk.gray('  ') + chalk.yellow('/help') + chalk.gray('  ') + chalk.yellow('/new') + chalk.gray('  ') + chalk.yellow('/new ai <url>') + chalk.gray('  ') + chalk.yellow('/agents'));
  console.log(chalk.gray('  ' + '─'.repeat(REPORT_WIDTH)));
  console.log();
}

function getPrompt() {
  return chalk.bold.green(`${USER}`) + chalk.gray(':') + chalk.bold.blue(shortCwd(shellCwd)) + chalk.bold.cyan(' λ ');
}

function printToolCall(tool, args, toolNum) {
  const argStr = JSON.stringify(args || {});
  const short = argStr.length > 50 ? argStr.slice(0, 47) + '...' : argStr;
  const badge = chalk.bgYellow.black(` TOOL #${toolNum} `);
  console.log(`\n  ${badge} ${chalk.bold.yellow(tool)}`);
  console.log(chalk.gray(`         args: ${short}`));
}

function printToolDone(preview, isError) {
  const clean = (preview || '').replace(/\n/g, ' ').trim();
  const short = clean.length > 65 ? clean.slice(0, 62) + '...' : clean;
  if (isError) {
    console.log(chalk.red(`    ✗ `) + chalk.red(short));
  } else {
    console.log(chalk.green(`    ✓ `) + chalk.gray(short));
  }
}

// ─── Balanced-brace MCP_ACTION stripper ───
function stripMcpActions(text) {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const idx = text.indexOf('MCP_ACTION:', i);
    if (idx === -1) { result += text.slice(i); break; }
    result += text.slice(i, idx);
    const braceStart = text.indexOf('{', idx);
    if (braceStart === -1) { i = idx + 11; continue; }
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

function cleanProtocolNoise(text) {
  return stripMcpActions(text)
    .replace(/```(?:json)?\s*\n?MCP_ACTION[\s\S]*?```/g, '')
    .replace(/\[TOOL RESULT:[\s\S]*?\[END TOOL RESULT\]/g, '')
    .replace(/Continue your (?:analysis|reasoning)\..*$/gm, '')
    .replace(/Output another MCP_ACTION.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanAndPrintReasoning(text) {
  if (!text) return;
  const cleaned = cleanProtocolNoise(text);

  if (cleaned) {
    console.log();
    // Word-wrap the reasoning 
    const lines = cleaned.split('\n');
    for (const rawLine of lines) {
      if (!rawLine.trim()) {
        console.log();
        continue;
      }
      const words = rawLine.split(' ');
      let cur = '  ';
      for (const word of words) {
        if ((cur + word).length > REPORT_WIDTH - 2) {
          console.log(chalk.gray(cur));
          cur = '  ' + word + ' ';
        } else {
          cur += word + ' ';
        }
      }
      if (cur.trim()) console.log(chalk.gray(cur));
    }
  }
}

function printFinalReport(text, toolCount) {
  const thinBar = '─'.repeat(REPORT_WIDTH);
  const toolLabel = `${toolCount} tool call${toolCount !== 1 ? 's' : ''}`;

  console.log();
  console.log(chalk.bold.cyan('  ┌' + thinBar + '┐'));

  const titleStr = '  ✨ Final Report';
  const padding = Math.max(0, REPORT_WIDTH - titleStr.length - toolLabel.length - 2);
  console.log(
    chalk.bold.cyan('  │') +
    chalk.bold.white(titleStr) +
    ' '.repeat(padding) +
    chalk.gray(toolLabel) + '  ' +
    chalk.bold.cyan('│')
  );
  console.log(chalk.bold.cyan('  ├' + thinBar + '┤'));
  console.log();

  // Word-wrap the report
  const lines = text.split('\n');
  for (const rawLine of lines) {
    if (!rawLine.trim()) {
      console.log();
      continue;
    }
    const words = rawLine.split(' ');
    let cur = '  ';
    for (const word of words) {
      if ((cur + word).length > REPORT_WIDTH - 2) {
        console.log(chalk.white(cur));
        cur = '  ' + word + ' ';
      } else {
        cur += word + ' ';
      }
    }
    if (cur.trim()) console.log(chalk.white(cur));
  }

  console.log();
  console.log(chalk.bold.cyan('  └' + thinBar + '┘'));
  console.log();
}

function printHelp() {
  console.log();
  console.log(chalk.bold.white('  Available commands:'));
  console.log(chalk.yellow('    /clear') + chalk.gray('          — Clear terminal and show banner'));
  console.log(chalk.yellow('    /exit') + chalk.gray('           — Quit the CLI'));
  console.log(chalk.yellow('    /help') + chalk.gray('           — Show this help'));
  console.log(chalk.yellow('    /new') + chalk.gray('            — Reset the current session (fresh conversation)'));
  console.log(chalk.yellow('    /new ai <url>') + chalk.gray('   — Open a new AI tab and register it as an agent'));
  console.log(chalk.yellow('    /agents') + chalk.gray('         — List all active browser agents'));
  console.log();
  console.log(chalk.bold.white('  Shell mode:'));
  console.log(chalk.gray('    cd <dir>') + chalk.gray('   — Change the local working directory'));
  console.log(chalk.gray('    pwd, ls, cat, tree, git status, grep, find, wc'));
  console.log(chalk.gray('    !<cmd>') + chalk.gray('     — Force a command to run locally in your shell'));
  console.log();
}

// ─── State ───
let isWaiting = false;
let toolCallCount = 0;
let reportBuffer = '';
let isStreamingReport = false;
let pendingToolRequest = null;

function isBuiltinShellCommand(line) {
  return /^(cd|pwd|ls|tree|cat|head|tail|grep|find|wc|mkdir|rm|git|du|node|npm|which)\b/.test(line);
}

function updateShellMetadata(command, output) {
  lastShellCommand = command;
  lastShellOutput = output;
}

function runLocalShell(command) {
  return new Promise((resolve) => {
    exec(command, {
      cwd: shellCwd,
      shell: '/bin/bash',
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const out = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim();
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        signal: error?.signal ?? null,
        output: out || '(no output)',
        error: error?.message || null,
      });
    });
  });
}

async function handleLocalShellInput(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;

  const shellLine = trimmed.startsWith('!') ? trimmed.slice(1).trim() : trimmed;
  const base = shellLine.split(/\s+/)[0];

  if (base === 'cd') {
    const target = shellLine.slice(2).trim() || os.homedir();
    const next = path.resolve(shellCwd, target);
    try {
      const stat = fs.statSync(next);
      if (!stat.isDirectory()) throw new Error('Not a directory');
      shellCwd = next;
      updateShellMetadata(`cd ${target}`, '');
      console.log(chalk.green(`  changed directory to ${shortCwd(shellCwd)}`));
    } catch (err) {
      console.log(chalk.red(`  cd: ${err.message}`));
    }
    return true;
  }

  if (base === 'pwd') {
    updateShellMetadata('pwd', shellCwd);
    console.log(chalk.white(`  ${shellCwd}`));
    return true;
  }

  if (trimmed.startsWith('!') || isBuiltinShellCommand(trimmed)) {
    const result = await runLocalShell(shellLine);
    updateShellMetadata(shellLine, result.output);
    const lines = result.output.split('\n').map((l) => `  ${l}`).join('\n');
    console.log(chalk.gray(lines));
    if (!result.ok) {
      console.log(chalk.red(`  [exit ${result.code}] ${result.error || 'command failed'}`));
    }
    return true;
  }

  return false;
}

// ─── WebSocket Initialization ───
let ws = null;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: getPrompt(),
});

function initWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    printBanner();
    rl.prompt();
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    handleWsMessage(msg);
  });

  ws.on('error', (err) => {
    stopSpinner();
    if (err.code === 'ECONNREFUSED') {
      console.log(chalk.yellow('\n  ℹ️  Backend is not running.'));
      rl.question(chalk.bold.cyan('  Would you like to start the backend automatically? [Y/n] '), (answer) => {
        const reply = answer.trim().toLowerCase();
        if (reply === '' || reply === 'y' || reply === 'yes') {
          startBackendAndReconnect();
        } else {
          console.error(chalk.red('\n  ❌ Cannot connect to backend. Please start it manually:'));
          console.error(chalk.gray('  cd backend && node server.js\n'));
          process.exit(1);
        }
      });
    } else {
      console.error(chalk.red('\n  ❌ WebSocket error:'), err.message);
      process.exit(1);
    }
  });

  ws.on('close', () => {
    stopSpinner();
    console.log(chalk.red('\n  Disconnected from backend. Attempting reconnection...'));
    setTimeout(() => {
      initWebSocket();
    }, 1500);
  });

}

function startBackendAndReconnect() {
  console.log(chalk.gray('  Starting backend server...'));
  
  // Find installation root to locate backend/server.js
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const backendPath = path.join(__dirname, 'backend', 'server.js');
  
  const child = spawn('node', [backendPath], {
    detached: false,
    stdio: 'ignore'
  });

  child.on('error', (err) => {
    console.error(chalk.red(`  ❌ Failed to start backend: ${err.message}`));
    process.exit(1);
  });

  // Wait a moment for server to bind to port
  setTimeout(() => {
    console.log(chalk.green('  Backend started. Connecting...'));
    initWebSocket();
  }, 1500);
}

// ─── Message Handling ───
function handleWsMessage(msg) {
  switch (msg.type) {
    case 'AI_THINKING':
      startSpinner(msg.text || 'AI is thinking...');
      break;

    case 'TOOL_CALL_START':
      stopSpinner();
      if (reportBuffer) {
        cleanAndPrintReasoning(reportBuffer);
        reportBuffer = '';
      }
      toolCallCount++;
      printToolCall(msg.tool, msg.args, toolCallCount);
      startSpinner(`Running ${msg.tool}...`);
      break;

    case 'TOOL_CALL_REQUEST': {
      stopSpinner();
      if (reportBuffer) {
        cleanAndPrintReasoning(reportBuffer);
        reportBuffer = '';
      }
      console.log(chalk.yellow(`\n  ⚡ THE AI WANTS TO RUN A TOOL:`));
      console.log(chalk.bold.yellow(`       ${msg.tool}`));
      console.log(chalk.white(`       args: ${JSON.stringify(msg.args || {}).slice(0, 200)}`));
      
      rl.question(chalk.green(`  Allow execution? [Y/n/a (always)] `), (ans) => {
         const reply = ans.trim().toLowerCase();
         if (reply === 'n') {
            console.log(chalk.red(`  Tool rejected.`));
            ws.send(JSON.stringify({ type: 'TOOL_APPROVAL', approve: false, remember: false }));
         } else {
            const remember = reply === 'a' || reply === 'always';
            if (remember) {
              console.log(chalk.cyan(`  Executing and remembering approval...`));
            } else {
              console.log(chalk.cyan(`  Executing...`));
            }
            ws.send(JSON.stringify({ type: 'TOOL_APPROVAL', approve: true, remember }));
         }
      });
      break;
    }

    case 'TOOL_CALL_DONE':
      stopSpinner();
      printToolDone(msg.preview, msg.isError);
      startSpinner('AI is analyzing results...');
      break;

    case 'AI_STREAM':
      // Buffer silently — shown in final report
      if (!isStreamingReport) {
        stopSpinner();
        isStreamingReport = true;
        startSpinner('AI is writing response...');
      }
      reportBuffer += msg.text;
      break;

    case 'TOOL_ERROR_RECOVERY':
      stopSpinner();
      console.log(chalk.red(`    ✗ `) + chalk.red((msg.preview || 'Tool error').replace(/\n/g, ' ').slice(0, 70)));
      console.log(chalk.yellow(`  🔧 Error detected — collecting diagnostics & re-sending to AI...`));
      startSpinner('AI is analyzing error and retrying...');
      break;

    case 'TOOL_INTERACTIVE_REQUEST':
      stopSpinner();
      console.log(chalk.yellow(`\n  ⚡ THE AI WANTS TO RUN AN INTERACTIVE COMMAND:`));
      console.log(chalk.white(`       ${msg.args.command}`));
      console.log(chalk.yellow(`     This command may require a password or user interaction.`));
      
      rl.question(chalk.green(`  Allow and run now? [Y/n] `), (ans) => {
         if (ans.trim().toLowerCase() === 'n') {
            console.log(chalk.red(`  Command rejected.`));
            socket.send(JSON.stringify({ type: 'TOOL_INTERACTIVE_RESPONSE', success: false, output: "User rejected the interactive command." }));
            rl.prompt();
         } else {
            console.log(chalk.cyan(`  Spawning interactive terminal for command...`));
            rl.pause();
            const child = spawn(msg.args.command, [], { shell: true, stdio: 'inherit' });
            child.on('close', (code) => {
               console.log(chalk.cyan(`  Interactive command completed with exit code: ${code}`));
               socket.send(JSON.stringify({ type: 'TOOL_INTERACTIVE_RESPONSE', success: code === 0, output: `Process exited with code ${code}` }));
               rl.resume();
               startSpinner('AI is analyzing results...');
            });
         }
      });
      break;

    case 'FINAL_REPORT': {
      stopSpinner();
      isStreamingReport = false;
      const finalText = msg.text || reportBuffer;
      reportBuffer = '';
      // Strip any raw MCP_ACTION lines from the report using balanced-brace logic
      const cleaned = cleanProtocolNoise(finalText);
      printFinalReport(cleaned, toolCallCount);
      toolCallCount = 0;
      isWaiting = false;
      rl.prompt();
      break;
    }

    case 'AI_COMPLETE':
      // Fallback if server sends AI_COMPLETE
      if (reportBuffer) {
        stopSpinner();
        isStreamingReport = false;
        const cleaned = cleanProtocolNoise(reportBuffer);
        printFinalReport(cleaned, toolCallCount);
        reportBuffer = '';
      } else {
        stopSpinner();
      }
      toolCallCount = 0;
      isWaiting = false;
      rl.prompt();
      break;

    case 'STATUS':
      stopSpinner();
      console.log(chalk.yellow(`\n  ℹ️  ${msg.text}`));
      break;

    case 'ERROR':
      stopSpinner();
      isStreamingReport = false;
      reportBuffer = '';
      console.log(chalk.red(`\n  ❌ ${msg.text}\n`));
      isWaiting = false;
      rl.prompt();
      break;
  }
}

initWebSocket();

// ─── Input Handling ───
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) { rl.prompt(); return; }

  if (text === '/exit' || text === 'exit') { rl.close(); return; }
  if (text === '/clear') { printBanner(); rl.prompt(); return; }
  if (text === '/help') { printHelp(); rl.prompt(); return; }

  // ── /new — reset session ──
  if (text === '/new') {
    ws.send(JSON.stringify({ type: 'NEW_SESSION' }));
    console.log(chalk.cyan('  🔄 Session reset requested...'));
    rl.prompt();
    return;
  }

  // ── /new ai <url> — open new AI tab ──
  if (text.startsWith('/new ai ')) {
    const url = text.slice(8).trim();
    if (!url) {
      console.log(chalk.red('  Usage: /new ai <url>  (e.g. /new ai https://claude.ai)'));
    } else {
      ws.send(JSON.stringify({ type: 'OPEN_TAB', url }));
      console.log(chalk.cyan(`  🆕 Opening new AI tab: ${url}`));
    }
    rl.prompt();
    return;
  }

  // ── /agents — list active agents ──
  if (text === '/agents') {
    ws.send(JSON.stringify({ type: 'LIST_AGENTS' }));
    rl.prompt();
    return;
  }

  if (await handleLocalShellInput(text)) {
    rl.setPrompt(getPrompt());
    rl.prompt();
    return;
  }

  if (isWaiting) {
    console.log(chalk.gray('  ⏳ Still waiting for AI response...'));
    rl.prompt();
    return;
  }

  console.log();
  isWaiting = true;
  toolCallCount = 0;
  reportBuffer = '';
  isStreamingReport = false;

  // Send prompt with working directory context
  ws.send(JSON.stringify({
    type: 'PROMPT',
    text,
    cwd: CWD,
    project: PROJECT_NAME,
    shellCwd,
    shellMetadata: {
      lastShellCommand,
      lastShellOutput: lastShellOutput.slice(0, 2000),
    },
  }));
});

rl.on('close', () => { ws.close(); process.exit(0); });
