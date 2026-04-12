import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.join(__dirname, "../mcp-server/index.js");

export class MyMcpClient {
  constructor() {
    this.client = null;
    this.transport = null;
    this.connecting = false;
  }

  async connect() {
    if (this.connecting) {
      // Wait for existing connection attempt
      while (this.connecting) await new Promise(r => setTimeout(r, 100));
      if (this.client) return;
    }

    this.connecting = true;
    try {
      console.error("[MCP Client] Connecting to MCP server...");

      this.transport = new StdioClientTransport({
        command: "node",
        args: [MCP_SERVER_PATH],
      });

      this.client = new Client(
        { name: "mcp-bridge-client", version: "2.0.0" },
        { capabilities: { tools: {} } }
      );

      // Handle transport errors / crash
      this.transport.onclose = () => {
        console.error("[MCP Client] MCP server process exited — will reconnect on next call");
        this.client = null;
        this.transport = null;
      };

      await this.client.connect(this.transport);
      console.error("[MCP Client] Connected ✓");
    } catch (err) {
      console.error("[MCP Client] Connection failed:", err.message);
      this.client = null;
      this.transport = null;
      throw err;
    } finally {
      this.connecting = false;
    }
  }

  async callTool(name, args) {
    if (!this.client) await this.connect();
    try {
      return await this.client.callTool({ name, arguments: args });
    } catch (err) {
      // If the MCP process died, reconnect and retry once
      console.error(`[MCP Client] Tool call failed (${name}): ${err.message} — retrying...`);
      this.client = null;
      this.transport = null;
      await this.connect();
      return await this.client.callTool({ name, arguments: args });
    }
  }

  async listTools() {
    if (!this.client) await this.connect();
    return await this.client.listTools();
  }
}
