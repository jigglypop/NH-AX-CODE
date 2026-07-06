// Minimal MCP (Model Context Protocol) client over stdio.
// JSON-RPC 2.0, newline-delimited messages (MCP stdio transport).
// No external dependencies — spawn + line parsing only.

import { spawn, type ChildProcess } from "child_process";

export interface McpServerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 30000;
const PROTOCOL_VERSION = "2024-11-05";

class McpClient {
  private child: ChildProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private initialized = false;
  tools: McpToolInfo[] = [];

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
    private readonly log: (line: string) => void
  ) {}

  async start(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child.stdout?.on("data", (data: Buffer) => this.onData(data.toString("utf8")));
    this.child.stderr?.on("data", (data: Buffer) => this.log(`[mcp:${this.name}] ${data.toString("utf8").trim()}`));
    this.child.on("error", (error) => {
      this.log(`[mcp:${this.name}] spawn error: ${error.message}`);
      this.failAll(new Error(`MCP 서버 시작 실패: ${error.message}`));
    });
    this.child.on("close", (code) => {
      this.log(`[mcp:${this.name}] exited with ${code}`);
      this.initialized = false;
      this.failAll(new Error(`MCP 서버가 종료되었습니다 (code ${code})`));
    });

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "nh-ax-code", version: "0.1.0" }
    });
    this.notify("notifications/initialized", {});
    this.initialized = true;

    const result = await this.request("tools/list", {}) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
    this.tools = (result.tools ?? []).map((tool) => ({
      server: this.name,
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema
    }));
    this.log(`[mcp:${this.name}] ready — ${this.tools.length} tools`);
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request("tools/call", { name: toolName, arguments: args }) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((item) => (item.type === "text" ? item.text ?? "" : `[${item.type}]`))
      .join("\n")
      .trim();
    if (result.isError) {
      throw new Error(text || "MCP 도구가 오류를 반환했습니다.");
    }
    return text || "(빈 응답)";
  }

  dispose(): void {
    this.failAll(new Error("MCP 클라이언트가 종료되었습니다."));
    this.child?.kill();
    this.child = undefined;
    this.initialized = false;
  }

  private onData(text: string): void {
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        this.handleMessage(line);
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleMessage(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return; // non-JSON noise on stdout
    }

    if (typeof message.id !== "number") {
      return; // notification from server — ignored
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(new Error(message.error.message ?? "MCP 오류"));
    } else {
      pending.resolve(message.result);
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 요청 시간 초과: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin?.write(`${payload}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class McpManager {
  private readonly clients = new Map<string, McpClient>();

  constructor(private readonly log: (line: string) => void) {}

  /** Start/refresh clients from settings. Failed servers are logged, not fatal. */
  async sync(configs: Record<string, McpServerConfig>): Promise<void> {
    // Drop removed servers.
    for (const [name, client] of this.clients) {
      if (!configs[name]) {
        client.dispose();
        this.clients.delete(name);
      }
    }

    for (const [name, config] of Object.entries(configs)) {
      if (this.clients.has(name)) {
        continue;
      }
      const client = new McpClient(name, config, this.log);
      this.clients.set(name, client);
      try {
        await client.start();
      } catch (error) {
        this.log(`[mcp:${name}] start failed: ${error instanceof Error ? error.message : String(error)}`);
        client.dispose();
        this.clients.delete(name);
      }
    }
  }

  restart(configs: Record<string, McpServerConfig>): Promise<void> {
    for (const [, client] of this.clients) {
      client.dispose();
    }
    this.clients.clear();
    return this.sync(configs);
  }

  allTools(): McpToolInfo[] {
    return [...this.clients.values()].flatMap((client) => client.tools);
  }

  async callTool(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const client = this.clients.get(server);
    if (!client) {
      throw new Error(`알 수 없는 MCP 서버: ${server}`);
    }
    return client.callTool(tool, args);
  }

  dispose(): void {
    for (const [, client] of this.clients) {
      client.dispose();
    }
    this.clients.clear();
  }
}
