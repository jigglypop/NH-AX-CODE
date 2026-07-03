import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

type ChatRole = "system" | "user" | "assistant";

interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface WebviewChatMessage {
  role: Exclude<ChatRole, "system">;
  content: string;
  attachments?: Array<{ name: string; type: string }>;
}

interface WebviewChatRequestMessage {
  type: "chatRequest";
  requestId: string;
  messages?: WebviewChatMessage[];
  settings?: WebviewAgentSettings;
}

interface WebviewListModelsMessage {
  type: "listModels";
  requestId: string;
}

interface WebviewListWorkspaceEntriesMessage {
  type: "listWorkspaceEntries";
  requestId: string;
  query?: string;
}

type AgentPermissionMode = "scoped" | "workspace" | "full" | "plan-only";
type OpenAIEndpointMode = "auto" | "chat-completions" | "completions" | "responses";

interface WebviewAgentSettings {
  permissionMode?: AgentPermissionMode;
  planMode?: boolean;
  model?: string;
  endpointMode?: OpenAIEndpointMode;
  streamResponses?: boolean;
}

interface ProviderConfig {
  provider: "openai" | "anthropic" | "openai-compatible";
  apiKey: string;
  model: string;
  compatibleBaseUrl: string;
  requestHeaders: Record<string, string>;
  autoApplyFileActions: boolean;
  endpointMode: OpenAIEndpointMode;
  streamResponses: boolean;
}

interface ModelCallResult {
  content: string;
  requestedModel: string;
  usedModel: string;
  streamed?: boolean;
  usage?: TokenUsage;
}

type FileOperation =
  | { type: "create"; path: string; content: string }
  | { type: "replace"; path: string; content: string }
  | { type: "replaceRange"; path: string; startLine: number; startCharacter: number; endLine: number; endCharacter: number; content: string }
  | { type: "delete"; path: string }
  | { type: "runCommand"; command: string; args?: string[]; cwd?: string; timeoutMs?: number };

interface FileActionPlan {
  summary?: string;
  operations: FileOperation[];
}

interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
  estimated?: boolean;
}

interface MentionContext {
  text: string;
  scopePaths: string[];
}

interface FileActionPolicy {
  mode: AgentPermissionMode;
  scopePaths: string[];
}

interface WorkspaceEntry {
  path: string;
  type: "file" | "folder";
}

interface CheckpointFile {
  path: string;
  existed: boolean;
  content?: string;
}

interface Checkpoint {
  id: string;
  createdAt: string;
  summary: string;
  files: CheckpointFile[];
}

const SYSTEM_PROMPT = [
  "You are NH-AX-CODE, a careful coding assistant embedded in VS Code.",
  "Be concise, practical, and repository-aware.",
  "When asked to change, create, edit, delete files, or run commands, return a clarus-actions JSON code block after a short summary.",
  "The action block format is: ```clarus-actions {\"summary\":\"...\",\"operations\":[{\"type\":\"create|replace|replaceRange|delete|runCommand\",\"path\":\"relative/path\",\"content\":\"...\",\"command\":\"npm\",\"args\":[\"run\",\"build\"],\"cwd\":\".\"}]} ```.",
  "For replaceRange include startLine, startCharacter, endLine, and endCharacter as zero-based positions.",
  "For runCommand, provide command and args separately. Use cwd as a workspace-relative path.",
  "Only use relative file paths. Do not operate outside the workspace.",
  "After tool results are provided, continue only if another concrete action is needed. Otherwise answer with the final result and no clarus-actions block.",
  "If context is missing, ask one targeted question instead of guessing recklessly."
].join("\n");

const MAX_MENTION_FILES = 80;
const MAX_MENTION_FILE_CHARS = 12000;
const MAX_MENTION_CONTEXT_CHARS = 50000;
const MAX_AGENT_STEPS = 4;
const FALLBACK_CHAT_MODELS = ["gpt-5.5", "5.5", "gpt-4.1", "gpt-4o", "gpt-4.1-mini", "gpt-4o-mini", "o4-mini", "o3"];
const execFileAsync = promisify(execFile);
const checkpoints: Checkpoint[] = [];

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("NH-AX-CODE");
  output.appendLine("Activating NH-AX-CODE.");
  const provider = new ChatViewProvider(context.extensionUri, output);

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),
    vscode.commands.registerCommand("clarusCode.openChat", async () => {
      output.appendLine("Opening NH-AX-CODE chat view.");
      await provider.revealChatView();
    }),
    vscode.commands.registerCommand("clarusCode.openPanel", () => provider.openPanel()),
    vscode.commands.registerCommand("clarusCode.restoreLastCheckpoint", async () => {
      await restoreLastCheckpoint();
    })
  );
  output.appendLine(`Registered WebviewViewProvider: ${ChatViewProvider.viewType}`);
}

export function deactivate() {}

class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "clarusCode.chat";

  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel
  ) {}

  async revealChatView() {
    await vscode.commands.executeCommand("workbench.view.extension.clarusCode");
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.output.appendLine(`Resolving webview view: ${ChatViewProvider.viewType}`);
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "media"),
        vscode.Uri.joinPath(this.extensionUri, "webview", "dist")
      ]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      await this.receiveMessage(message);
    });
  }

  openPanel() {
    this.output.appendLine("Opening NH-AX-CODE chat panel.");
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "clarusCode.chatPanel",
      "NH-AX-CODE",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "media"),
          vscode.Uri.joinPath(this.extensionUri, "webview", "dist")
        ],
        retainContextWhenHidden: true
      }
    );

    this.panel = panel;
    panel.webview.html = this.getHtml(panel.webview);
    panel.webview.onDidReceiveMessage(async (message) => {
      await this.receiveMessage(message);
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private async handleMessage(message: { type: string; value?: string; requestId?: string; query?: string }) {
    switch (message.type) {
      case "chatRequest":
        await this.handleChatRequest(message as WebviewChatRequestMessage);
        break;
      case "listModels":
        await this.handleListModels(message as WebviewListModelsMessage);
        break;
      case "listWorkspaceEntries":
        await this.handleListWorkspaceEntries(message as WebviewListWorkspaceEntriesMessage);
        break;
    }
  }

  private async handleChatRequest(message: WebviewChatRequestMessage) {
    const requestId = message.requestId;

    try {
      const settings = normalizeAgentSettings(message.settings);
      const mentionContext = await buildMentionContext(message.messages ?? []);
      const policy = {
        mode: settings.permissionMode,
        scopePaths: mentionContext.scopePaths
      };
      const chatMessages: ChatMessage[] = [
        {
          role: "system",
          content: buildSystemPrompt(settings, mentionContext)
        },
        ...(message.messages ?? []).map((chatMessage) => ({
          role: chatMessage.role,
          content: formatWebviewMessageContent(chatMessage)
        }))
      ];

      for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
        const streamFilter = createActionBlockStreamFilter((chunk) => {
          this.postBridgeMessage({ type: "chatChunk", requestId, value: chunk });
        });
        const result = await callModel(chatMessages, settings.model, settings.endpointMode, settings.streamResponses, (chunk) => {
          streamFilter.push(chunk);
        });
        streamFilter.flush();
        this.postModelFallbackIfNeeded(requestId, result);
        this.postUsageIfNeeded(requestId, result.usage);

        const answer = result.content;
        if (!result.streamed) {
          const visibleAnswer = stripActionBlocks(answer).trim();
          if (visibleAnswer) {
            this.postBridgeMessage({ type: "chatChunk", requestId, value: step === 0 ? visibleAnswer : `\n\n${visibleAnswer}` });
          }
        }

        const actionResult = await this.applyActionsForAgentStep(requestId, answer, policy, settings.planMode);
        if (!actionResult) {
          break;
        }

        chatMessages.push({ role: "assistant", content: answer });
        chatMessages.push({
          role: "user",
          content: [
            "작업 결과:",
            actionResult,
            "",
            "Continue the task if more work is required. If the task is complete, provide a final concise summary without a clarus-actions block."
          ].join("\n")
        });

        if (step === MAX_AGENT_STEPS - 1) {
          this.postBridgeMessage({
            type: "chatChunk",
            requestId,
            value: "\n\n작업 단계 한도에 도달했습니다. 현재 결과를 확인한 뒤 이어서 요청하세요."
          });
        }
      }

      this.postBridgeMessage({ type: "chatDone", requestId });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Chat request error: ${text}`);
      this.postBridgeMessage({ type: "chatError", requestId, value: text });
    }
  }

  private async handleListModels(message: WebviewListModelsMessage) {
    try {
      const models = await listModels();
      this.postBridgeMessage({ type: "modelList", requestId: message.requestId, value: models });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Model list error: ${text}`);
      this.postBridgeMessage({ type: "modelListError", requestId: message.requestId, value: text });
    }
  }

  private async handleListWorkspaceEntries(message: WebviewListWorkspaceEntriesMessage) {
    try {
      const entries = await listWorkspaceEntries(message.query ?? "");
      this.postBridgeMessage({ type: "workspaceEntries", requestId: message.requestId, value: entries });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Workspace entry list error: ${text}`);
      this.postBridgeMessage({ type: "workspaceEntriesError", requestId: message.requestId, value: text });
    }
  }

  private postBridgeMessage(message: unknown) {
    this.view?.webview.postMessage(message);
    this.panel?.webview.postMessage(message);
  }

  private async receiveMessage(message: { type: string; value?: string; requestId?: string; query?: string }) {
    try {
      await this.handleMessage(message);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Webview message error: ${text}`);
    }
  }

  private postModelFallbackIfNeeded(requestId: string, result: ModelCallResult) {
    if (result.usedModel === result.requestedModel) {
      return;
    }

    this.postBridgeMessage({
      type: "modelFallback",
      requestId,
      value: {
        failedModel: result.requestedModel,
        usedModel: result.usedModel
      }
    });
  }

  private postUsageIfNeeded(requestId: string, usage?: TokenUsage) {
    if (!usage) {
      return;
    }

    this.postBridgeMessage({ type: "chatUsage", requestId, value: usage });
  }

  private async applyActionsForAgentStep(requestId: string, answer: string, policy: FileActionPolicy, planMode: boolean): Promise<string | undefined> {
    const plan = parseFileActionPlan(answer);
    if (!plan) {
      return undefined;
    }

    if (planMode) {
      const message = "계획 모드가 켜져 있어 작업을 적용하지 않았습니다.";
      this.postBridgeMessage({ type: "chatChunk", requestId, value: `\n\n${message}` });
      return undefined;
    }

    const shouldApply = true;

    if (!shouldApply) {
      const message = "작업을 적용하지 않았습니다.";
      this.postBridgeMessage({ type: "chatChunk", requestId, value: `\n\n${message}` });
      return undefined;
    }

    const result = await applyFileActionPlan(plan, policy);
    this.postBridgeMessage({ type: "chatChunk", requestId, value: `\n\n${result}` });
    return result;
  }

  private async offerFileActions(requestId: string, answer: string, policy: FileActionPolicy, planMode: boolean) {
    const plan = parseFileActionPlan(answer);
    if (!plan) {
      return;
    }

    if (planMode) {
      this.postBridgeMessage({
        type: "chatChunk",
        requestId,
        value: "\n\n계획 모드가 켜져 있어 파일 작업을 적용하지 않았습니다."
      });
      return;
    }

    const config = getProviderConfig();
    const summary = summarizePlan(plan);
    const shouldApply = config.autoApplyFileActions;

    if (!shouldApply) {
      this.postBridgeMessage({
        type: "chatChunk",
        requestId,
        value: "\n\n파일 작업을 적용하지 않았습니다."
      });
      return;
    }

    const result = await applyFileActionPlan(plan, policy);
    this.postBridgeMessage({
      type: "chatChunk",
      requestId,
      value: `\n\n${result}`
    });
  }

  private getHtml(webview: vscode.Webview) {
    const nonce = getNonce();
    const devServer = process.env.CLARUS_WEBVIEW_DEV_SERVER?.replace(/\/$/, "");
    const isDevServer = Boolean(devServer);
    const scriptUri = isDevServer
      ? `${devServer}/src/main.tsx`
      : webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "webview", "dist", "assets", "index.js")).toString();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "webview", "dist", "assets", "index.css"));
    const styleTag = isDevServer ? "" : `<link href="${styleUri}" rel="stylesheet">`;
    const viteClientTag = isDevServer ? `<script nonce="${nonce}" type="module" src="${devServer}/@vite/client"></script>` : "";
    const devCsp = isDevServer ? `${devServer} ws://127.0.0.1:5173 ws://localhost:5173` : "";
    const connectCsp = isDevServer ? `connect-src ${devCsp};` : "";
    this.output.appendLine(`Rendering webview HTML. devServer=${devServer || "off"} script=${scriptUri}`);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} ${devCsp} 'unsafe-inline'; script-src ${webview.cspSource} ${devCsp} 'unsafe-eval' 'nonce-${nonce}'; worker-src ${webview.cspSource} blob:; ${connectCsp}">
  ${styleTag}
  <title>NH-AX-CODE</title>
</head>
<body style="margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);">
  <div id="root" style="min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box;">
    <main style="width:100%;max-width:520px;border:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);padding:14px;border-radius:8px;line-height:1.5;">
      <strong>NH-AX-CODE 시작 중...</strong>
      <p style="margin:8px 0 0;color:var(--vscode-descriptionForeground);">화면이 바뀌지 않으면 Webview 번들 로딩을 확인하세요.</p>
    </main>
  </div>
  <script nonce="${nonce}">
    window.addEventListener("error", (event) => {
      const root = document.getElementById("root");
      if (root) {
        root.innerHTML = "<main style='padding:16px;line-height:1.5'><strong>NH-AX-CODE 스크립트 오류</strong><pre style='white-space:pre-wrap'>" + String(event.message || event.error || "알 수 없는 오류") + "</pre></main>";
      }
    });
    window.addEventListener("unhandledrejection", (event) => {
      const root = document.getElementById("root");
      if (root) {
        root.innerHTML = "<main style='padding:16px;line-height:1.5'><strong>NH-AX-CODE 처리 오류</strong><pre style='white-space:pre-wrap'>" + String(event.reason || "알 수 없는 오류") + "</pre></main>";
      }
    });
  </script>
  ${viteClientTag}
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

async function callModel(
  messages: ChatMessage[],
  modelOverride?: string,
  endpointModeOverride?: OpenAIEndpointMode,
  streamResponsesOverride?: boolean,
  onChunk?: (chunk: string) => void
): Promise<ModelCallResult> {
  const config = getProviderConfig();
  config.endpointMode = endpointModeOverride ?? config.endpointMode;
  config.streamResponses = streamResponsesOverride ?? config.streamResponses;

  if (!config.apiKey && config.provider !== "openai-compatible") {
    throw new Error("채팅 전에 VS Code 설정에서 clarusCode.apiKey를 입력하세요.");
  }

  if (config.provider === "anthropic") {
    const requestedModel = modelOverride || config.model;
    return {
      content: await callAnthropic(config, messages, requestedModel),
      requestedModel,
      usedModel: requestedModel
    };
  }

  return callOpenAICompatible(config, messages, modelOverride, onChunk);
}

async function callOpenAICompatible(config: ProviderConfig, messages: ChatMessage[], modelOverride?: string, onChunk?: (chunk: string) => void): Promise<ModelCallResult> {
  const baseUrl = config.provider === "openai" ? "https://api.openai.com/v1" : config.compatibleBaseUrl.replace(/\/$/, "");
  const model = modelOverride || config.model;
  return callOpenAIEndpointRouter(baseUrl, config, messages, model, onChunk);
  if (!isChatCompletionModel(model, config.provider)) {
    const completion = await requestTextCompletion(baseUrl, config, messages, model);
    if (completion.ok) {
      return {
        content: await readCompletionResponse(completion),
        requestedModel: model,
        usedModel: model
      };
    }
  }

  const response = await requestChatCompletion(baseUrl, config, messages, model);

  if (!response.ok) {
    const text = await response.text();
    if (isNotChatModelError(response.status, text)) {
      const completion = await requestTextCompletion(baseUrl, config, messages, model);
      if (completion.ok) {
        return {
          content: await readCompletionResponse(completion),
          requestedModel: model,
          usedModel: model
        };
      }

      const fallback = await retryChatCompletionWithFallbackModels(baseUrl, config, messages, model);
      if (fallback) {
        return fallback as ModelCallResult;
      }
    }

    throw new Error(`제공자 요청 실패: ${response.status} ${text}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return {
    content: data.choices?.[0]?.message?.content?.trim() || "응답 내용이 없습니다.",
    requestedModel: model,
    usedModel: model
  };
}

async function requestChatCompletion(baseUrl: string, config: ProviderConfig, messages: ChatMessage[], model: string): Promise<Response> {
  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...config.requestHeaders,
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      messages
    })
  });
}

async function requestTextCompletion(baseUrl: string, config: ProviderConfig, messages: ChatMessage[], model: string): Promise<Response> {
  return fetch(`${baseUrl}/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...config.requestHeaders,
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      prompt: messagesToPrompt(messages),
      max_tokens: 4096
    })
  });
}

async function callOpenAIEndpointRouter(
  baseUrl: string,
  config: ProviderConfig,
  messages: ChatMessage[],
  model: string,
  onChunk?: (chunk: string) => void
): Promise<ModelCallResult> {
  const errors: string[] = [];
  const endpoints = getOpenAIEndpointOrder(config.endpointMode);

  for (const endpoint of endpoints) {
    const response = await requestOpenAIEndpoint(baseUrl, config, messages, model, endpoint, config.streamResponses);
    if (response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const isSse = contentType.includes("text/event-stream");
      const parsed = await readOpenAIEndpointResponseWithUsage(response, endpoint, onChunk);
      return {
        content: parsed.content,
        requestedModel: model,
        usedModel: model,
        streamed: isSse && Boolean(onChunk),
        usage: parsed.usage ?? estimateTokenUsage(messages, parsed.content)
      };
    }

    const text = await response.text();
    errors.push(`${endpoint}: ${response.status} ${text}`);
    if (config.endpointMode !== "auto" && !isEndpointFallbackError(response.status, text)) {
      break;
    }
  }

  const fallback = await retryChatCompletionWithFallbackModels(baseUrl, config, messages, model);
  if (fallback) {
    return fallback;
  }

  throw new Error(`제공자 요청 실패. 시도한 엔드포인트: ${endpoints.join(", ")}.\n${errors.join("\n")}`);
}

async function requestOpenAIEndpoint(
  baseUrl: string,
  config: ProviderConfig,
  messages: ChatMessage[],
  model: string,
  endpoint: Exclude<OpenAIEndpointMode, "auto">,
  stream: boolean
): Promise<Response> {
  const pathByEndpoint: Record<Exclude<OpenAIEndpointMode, "auto">, string> = {
    "chat-completions": "chat/completions",
    completions: "completions",
    responses: "responses"
  };

  return fetch(`${baseUrl}/${pathByEndpoint[endpoint]}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...config.requestHeaders,
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
    },
    body: JSON.stringify(buildOpenAIEndpointBody(endpoint, messages, model, stream))
  });
}

function buildOpenAIEndpointBody(endpoint: Exclude<OpenAIEndpointMode, "auto">, messages: ChatMessage[], model: string, stream: boolean): Record<string, unknown> {
  if (endpoint === "chat-completions") {
    return { model, messages, stream };
  }

  if (endpoint === "responses") {
    return { model, input: messagesToPrompt(messages), max_output_tokens: 4096, stream };
  }

  return { model, prompt: messagesToPrompt(messages), max_tokens: 4096, stream };
}

async function readOpenAIEndpointResponse(response: Response, endpoint: Exclude<OpenAIEndpointMode, "auto">, onChunk?: (chunk: string) => void): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return readSseText(response, endpoint, onChunk);
  }

  const data = await response.json() as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    choices?: Array<{ text?: string; message?: { content?: string } }>;
  };

  const outputText = data.output_text?.trim();
  if (outputText) {
    return outputText;
  }

  const responseText = data.output
    ?.flatMap((item) => item.content ?? [])
    .map((item) => item.text)
    .filter((text): text is string => Boolean(text))
    .join("")
    .trim();
  if (responseText) {
    return responseText;
  }

  return data.choices?.[0]?.text?.trim() || data.choices?.[0]?.message?.content?.trim() || "응답 내용이 없습니다.";
}

async function readSseText(response: Response, endpoint: Exclude<OpenAIEndpointMode, "auto">, onChunk?: (chunk: string) => void): Promise<string> {
  if (!response.body) {
    return "응답 내용이 없습니다.";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";

    for (const event of events) {
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith("data:")) {
          continue;
        }

        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }

        try {
          const chunk = extractSsePayloadText(JSON.parse(payload), endpoint);
          if (chunk) {
            output += chunk;
            onChunk?.(chunk);
          }
        } catch {
          continue;
        }
      }
    }
  }

  return output.trim() || "응답 내용이 없습니다.";
}

async function readOpenAIEndpointResponseWithUsage(
  response: Response,
  endpoint: Exclude<OpenAIEndpointMode, "auto">,
  onChunk?: (chunk: string) => void
): Promise<{ content: string; usage?: TokenUsage }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return readSseTextWithUsage(response, endpoint, onChunk);
  }

  const data = await response.json() as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    choices?: Array<{ text?: string; message?: { content?: string } }>;
  };

  const outputText = data.output_text?.trim();
  if (outputText) {
    return { content: outputText, usage: extractUsage(data) };
  }

  const responseText = data.output
    ?.flatMap((item) => item.content ?? [])
    .map((item) => item.text)
    .filter((text): text is string => Boolean(text))
    .join("")
    .trim();
  if (responseText) {
    return { content: responseText, usage: extractUsage(data) };
  }

  return {
    content: data.choices?.[0]?.text?.trim() || data.choices?.[0]?.message?.content?.trim() || "응답 내용이 없습니다.",
    usage: extractUsage(data)
  };
}

async function readSseTextWithUsage(
  response: Response,
  endpoint: Exclude<OpenAIEndpointMode, "auto">,
  onChunk?: (chunk: string) => void
): Promise<{ content: string; usage?: TokenUsage }> {
  if (!response.body) {
    return { content: "응답 내용이 없습니다." };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let usage: TokenUsage | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";

    for (const event of events) {
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith("data:")) {
          continue;
        }

        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }

        try {
          const parsedPayload = JSON.parse(payload);
          usage = extractUsage(parsedPayload) ?? usage;
          const chunk = extractSsePayloadText(parsedPayload, endpoint);
          if (chunk) {
            output += chunk;
            onChunk?.(chunk);
          }
        } catch {
          continue;
        }
      }
    }
  }

  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) {
      if (!line.startsWith("data:")) {
        continue;
      }

      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }

      try {
        const parsedPayload = JSON.parse(payload);
        usage = extractUsage(parsedPayload) ?? usage;
        const chunk = extractSsePayloadText(parsedPayload, endpoint);
        if (chunk) {
          output += chunk;
          onChunk?.(chunk);
        }
      } catch {
        continue;
      }
    }
  }

  return { content: output.trim() || "응답 내용이 없습니다.", usage };
}

function extractSsePayloadText(payload: unknown, endpoint: Exclude<OpenAIEndpointMode, "auto">): string {
  const data = payload as {
    delta?: string;
    text?: string;
    content?: string;
    output_text?: string;
    message?: { content?: string | Array<{ text?: string }> };
    output?: Array<{ content?: Array<{ text?: string }> }>;
    choices?: Array<{ text?: string; delta?: { content?: string }; message?: { content?: string } }>;
  };

  if (endpoint === "responses") {
    const outputText = data.output
      ?.flatMap((item) => item.content ?? [])
      .map((item) => item.text)
      .filter((text): text is string => Boolean(text))
      .join("");
    return data.delta ?? data.text ?? data.content ?? data.output_text ?? outputText ?? "";
  }

  const messageContent = Array.isArray(data.message?.content)
    ? data.message.content.map((item) => item.text).filter(Boolean).join("")
    : data.message?.content;

  return data.choices?.[0]?.delta?.content
    ?? data.choices?.[0]?.text
    ?? data.choices?.[0]?.message?.content
    ?? data.delta
    ?? data.text
    ?? data.content
    ?? data.output_text
    ?? messageContent
    ?? "";
}

function extractUsage(payload: unknown): TokenUsage | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const data = payload as {
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
    response?: unknown;
  };

  const nested = data.response ? extractUsage(data.response) : undefined;
  const usage = data.usage;
  if (!usage) {
    return nested;
  }

  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  const total = usage.total_tokens ?? (typeof input === "number" && typeof output === "number" ? input + output : undefined);

  if (typeof input !== "number" && typeof output !== "number" && typeof total !== "number") {
    return nested;
  }

  return { input, output, total };
}

function estimateTokenUsage(messages: ChatMessage[], content: string): TokenUsage {
  const inputChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  const outputChars = content.length;
  const input = Math.ceil(inputChars / 4);
  const output = Math.ceil(outputChars / 4);
  return {
    input,
    output,
    total: input + output,
    estimated: true
  };
}

function getOpenAIEndpointOrder(endpointMode: OpenAIEndpointMode): Array<Exclude<OpenAIEndpointMode, "auto">> {
  if (endpointMode === "chat-completions") {
    return ["chat-completions", "responses", "completions"];
  }

  if (endpointMode === "responses") {
    return ["responses", "chat-completions", "completions"];
  }

  if (endpointMode === "completions") {
    return ["completions", "chat-completions", "responses"];
  }

  return ["chat-completions", "responses", "completions"];
}

async function readCompletionResponse(response: Response): Promise<string> {
  const data = await response.json() as { choices?: Array<{ text?: string; message?: { content?: string } }> };
  return data.choices?.[0]?.text?.trim() || data.choices?.[0]?.message?.content?.trim() || "응답 내용이 없습니다.";
}

function messagesToPrompt(messages: ChatMessage[]): string {
  return [
    ...messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`),
    "ASSISTANT:"
  ].join("\n\n");
}

async function retryChatCompletionWithFallbackModels(
  baseUrl: string,
  config: ProviderConfig,
  messages: ChatMessage[],
  failedModel: string
): Promise<ModelCallResult | undefined> {
  const candidates = uniqueStrings([
    ...(await listModels().catch(() => [])),
    config.model,
    ...FALLBACK_CHAT_MODELS
  ])
    .filter((candidate) => candidate !== failedModel)
    .filter((candidate) => isChatCompletionModel(candidate, config.provider));

  for (const candidate of candidates) {
    const retry = await requestChatCompletion(baseUrl, config, messages, candidate);
    if (retry.ok) {
      const data = await retry.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content?.trim() || "응답 내용이 없습니다.";
      return {
        content: `[${failedModel}은 채팅 모델이 아니어서 ${candidate}로 재시도했습니다]\n\n${content}`,
        requestedModel: failedModel,
        usedModel: candidate
      };
    }

    const retryText = await retry.text();
    if (isNotChatModelError(retry.status, retryText)) {
      continue;
    }
  }

  return undefined;
}

async function callAnthropic(config: ProviderConfig, messages: ChatMessage[], modelOverride?: string): Promise<string> {
  const system = messages.find((message) => message.role === "system")?.content ?? SYSTEM_PROMPT;
  const chatMessages = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, content: message.content }));

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...config.requestHeaders,
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: modelOverride || config.model,
      system,
      messages: chatMessages,
      max_tokens: 4096
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic 요청 실패: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
  return data.content?.find((item) => item.type === "text")?.text?.trim() || "응답 내용이 없습니다.";
}

function getProviderConfig(): ProviderConfig {
  const config = vscode.workspace.getConfiguration("clarusCode");
  return {
    provider: config.get<ProviderConfig["provider"]>("provider", "openai"),
    apiKey: config.get<string>("apiKey", ""),
    model: config.get<string>("model", "gpt-5.5"),
    compatibleBaseUrl: config.get<string>("openAICompatibleBaseUrl", "http://localhost:11434/v1"),
    requestHeaders: config.get<Record<string, string>>("requestHeaders", {}),
    autoApplyFileActions: config.get<boolean>("autoApplyFileActions", true),
    endpointMode: config.get<OpenAIEndpointMode>("endpointMode", "auto"),
    streamResponses: config.get<boolean>("streamResponses", true)
  };
}

async function listModels(): Promise<string[]> {
  const config = getProviderConfig();

  if (config.provider === "anthropic") {
    return [
      config.model,
      "claude-3-5-sonnet-latest",
      "claude-3-5-haiku-latest",
      "claude-3-opus-latest"
    ].filter((model, index, models) => model && models.indexOf(model) === index);
  }

  const baseUrl = config.provider === "openai" ? "https://api.openai.com/v1" : config.compatibleBaseUrl.replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/models`, {
    method: "GET",
    headers: {
      ...config.requestHeaders,
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
    }
  });

  if (!response.ok) {
    throw new Error(`모델 목록 요청 실패: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as { data?: Array<{ id?: string }> };
  const models = (data.data ?? [])
    .map((item) => item.id)
    .filter((id): id is string => Boolean(id))
    .filter((id) => isChatCompletionModel(id, config.provider))
    .sort((a, b) => a.localeCompare(b));

  const configuredModel = isChatCompletionModel(config.model, config.provider) ? [config.model] : [];
  return uniqueStrings([...configuredModel, ...models.filter((model) => model !== config.model), ...FALLBACK_CHAT_MODELS]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isChatCompletionModel(model: string, provider: ProviderConfig["provider"]): boolean {
  const id = model.toLowerCase();
  const knownNonChatTokens = [
    "embedding",
    "whisper",
    "tts",
    "dall-e",
    "moderation",
    "babbage",
    "davinci",
    "curie",
    "ada",
    "instruct",
    "transcribe",
    "realtime",
    "image",
    "audio",
    "rerank",
    "clip"
  ];

  if (knownNonChatTokens.some((token) => id.includes(token))) {
    return false;
  }

  if (provider !== "openai") {
    return true;
  }

  return /^(gpt-|chatgpt-|o\d|codex)/.test(id);
}

function isNotChatModelError(status: number, text: string): boolean {
  return (status === 400 || status === 404) && /not a chat model|v1\/chat\/completions|v1\/completions/i.test(text);
}

function isEndpointFallbackError(status: number, text: string): boolean {
  return (status === 400 || status === 404 || status === 405) && /not a chat model|not supported|v1\/chat\/completions|v1\/completions|v1\/responses|did you mean/i.test(text);
}

function formatWebviewMessageContent(message: WebviewChatMessage): string {
  const attachmentSummary = message.attachments?.length
    ? `\n\nAttachments:\n${message.attachments.map((attachment) => `- ${attachment.name} (${attachment.type})`).join("\n")}`
    : "";

  return `${message.content}${attachmentSummary}`;
}

function normalizeAgentSettings(settings?: WebviewAgentSettings): Required<WebviewAgentSettings> {
  const permissionMode = settings?.permissionMode === "workspace" || settings?.permissionMode === "full" || settings?.permissionMode === "plan-only"
    ? settings.permissionMode
    : "workspace";

  return {
    permissionMode,
    planMode: permissionMode === "plan-only" ? true : settings?.planMode ?? false,
    model: settings?.model?.trim() || getProviderConfig().model,
    endpointMode: normalizeEndpointMode(settings?.endpointMode),
    streamResponses: settings?.streamResponses ?? true
  };
}

function normalizeEndpointMode(endpointMode?: OpenAIEndpointMode): OpenAIEndpointMode {
  if (endpointMode === "chat-completions" || endpointMode === "completions" || endpointMode === "responses") {
    return endpointMode;
  }

  return "auto";
}

function buildSystemPrompt(settings: Required<WebviewAgentSettings>, mentionContext: MentionContext): string {
  const policyLines = [
    `Agent permission mode: ${settings.permissionMode}.`,
    settings.planMode
      ? "Plan mode is enabled. Do not return clarus-actions. Return a concrete implementation plan instead."
      : "Plan mode is disabled. You may return clarus-actions when a file change is necessary.",
    settings.permissionMode === "scoped"
      ? "In scoped mode, only propose file actions inside the @mentioned file or folder scopes."
      : "You may propose file actions across the workspace when needed.",
    mentionContext.scopePaths.length
      ? `Active @ scopes: ${mentionContext.scopePaths.join(", ")}`
      : "No @ scopes were provided."
  ];

  return [
    SYSTEM_PROMPT,
    "",
    "Agent policy:",
    ...policyLines,
    mentionContext.text ? ["", mentionContext.text].join("\n") : ""
  ].filter(Boolean).join("\n");
}

async function buildMentionContext(messages: WebviewChatMessage[]): Promise<MentionContext> {
  const mentions = [...new Set(messages.flatMap((message) => extractAtMentions(message.content)))];
  const chunks: string[] = [];
  const scopePaths: string[] = [];
  let remainingChars = MAX_MENTION_CONTEXT_CHARS;

  for (const mention of mentions) {
    if (remainingChars <= 0) {
      break;
    }

    let target: { uri: vscode.Uri; label: string };
    let stat: vscode.FileStat;

    try {
      target = resolveMentionTarget(mention);
      stat = await vscode.workspace.fs.stat(target.uri);
    } catch {
      continue;
    }

    scopePaths.push(target.label);

    if (stat.type === vscode.FileType.Directory) {
      const folderChunk = await buildFolderMentionChunk(target.uri, target.label, remainingChars);
      chunks.push(folderChunk.text);
      remainingChars -= folderChunk.text.length;
      continue;
    }

    const fileText = await readWorkspaceTextFile(target.uri, Math.min(MAX_MENTION_FILE_CHARS, remainingChars));
    const chunk = [
      `@${target.label}`,
      "```",
      fileText,
      "```"
    ].join("\n");
    chunks.push(chunk);
    remainingChars -= chunk.length;
  }

  return {
    scopePaths,
    text: chunks.length ? `@ mention context:\n${chunks.join("\n\n")}` : ""
  };
}

async function listWorkspaceEntries(query: string): Promise<WorkspaceEntry[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const normalizedQuery = query.toLowerCase().replace(/^@/, "");
  const entries = new Map<string, WorkspaceEntry>();

  if (looksLikeAbsolutePath(query)) {
    try {
      const uri = vscode.Uri.file(query);
      const stat = await vscode.workspace.fs.stat(uri);
      entries.set(query, { path: query, type: stat.type === vscode.FileType.Directory ? "folder" : "file" });
    } catch {
      entries.set(query, { path: query, type: "folder" });
    }
  }

  if (!workspaceFolders.length) {
    return [...entries.values()];
  }

  for (const folder of workspaceFolders) {
    const relativePath = vscode.workspace.asRelativePath(folder.uri, false);
    const pathLabel = relativePath === folder.name ? "." : relativePath;
    entries.set(pathLabel, { path: pathLabel, type: "folder" });
  }

  const files = await vscode.workspace.findFiles(
    "**/*",
    "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.vscode-test/**}",
    250
  );

  for (const uri of files) {
    const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      entries.set(relativePath, {
        path: relativePath,
        type: stat.type === vscode.FileType.Directory ? "folder" : "file"
      });
    } catch {
      entries.set(relativePath, { path: relativePath, type: "file" });
    }

    const parent = path.posix.dirname(relativePath);
    if (parent && parent !== ".") {
      const parts = parent.split("/");
      for (let index = 1; index <= parts.length; index += 1) {
        const folderPath = parts.slice(0, index).join("/");
        entries.set(folderPath, { path: folderPath, type: "folder" });
      }
    }
  }

  return [...entries.values()]
    .filter((entry) => !normalizedQuery || entry.path.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "folder" ? -1 : 1;
      }
      return a.path.localeCompare(b.path);
    })
    .slice(0, 80);
}

function extractAtMentions(content: string): string[] {
  const mentions: string[] = [];
  const pattern = /(^|\s)@([^\s`"'<>]+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const raw = match[2].replace(/[),.;:\]}]+$/g, "");
    if (!raw || raw.includes("@")) {
      continue;
    }
    mentions.push(looksLikeAbsolutePath(raw) ? raw : raw.replace(/^[\\/]+/, ""));
  }

  return mentions;
}

async function buildFolderMentionChunk(folderUri: vscode.Uri, label: string, charBudget: number): Promise<{ text: string }> {
  const files = await collectMentionFiles(folderUri, MAX_MENTION_FILES);
  const paths = files.map((file) => formatMentionLabel(file, folderUri, label));
  const chunks = [`@${label}/`, `Files (${paths.length}):`, ...paths.map((filePath) => `- ${filePath}`)];
  let remaining = charBudget - chunks.join("\n").length;

  for (const file of files.slice(0, 12)) {
    if (remaining <= 0) {
      break;
    }

    const text = await readWorkspaceTextFile(file, Math.min(4000, remaining));
    if (!text.trim()) {
      continue;
    }

    const filePath = formatMentionLabel(file, folderUri, label);
    const fileChunk = [``, `@${filePath}`, "```", text, "```"].join("\n");
    chunks.push(fileChunk);
    remaining -= fileChunk.length;
  }

  return { text: chunks.join("\n") };
}

async function collectMentionFiles(root: vscode.Uri, limit: number): Promise<vscode.Uri[]> {
  const files: vscode.Uri[] = [];
  const queue: vscode.Uri[] = [root];
  const excluded = new Set(["node_modules", ".git", "dist", "build", ".vscode-test"]);

  while (queue.length && files.length < limit) {
    const current = queue.shift()!;
    let entries: [string, vscode.FileType][];

    try {
      entries = await vscode.workspace.fs.readDirectory(current);
    } catch {
      continue;
    }

    entries.sort(([aName, aType], [bName, bType]) => {
      if (aType !== bType) {
        return aType === vscode.FileType.Directory ? -1 : 1;
      }
      return aName.localeCompare(bName);
    });

    for (const [name, type] of entries) {
      if (excluded.has(name)) {
        continue;
      }

      const child = vscode.Uri.joinPath(current, name);
      if (type === vscode.FileType.Directory) {
        queue.push(child);
      } else if (type === vscode.FileType.File) {
        files.push(child);
      }

      if (files.length >= limit) {
        break;
      }
    }
  }

  return files;
}

function formatMentionLabel(uri: vscode.Uri, root: vscode.Uri, rootLabel: string): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (workspaceFolder) {
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
  }

  const relative = path.relative(root.fsPath, uri.fsPath).replace(/\\/g, "/");
  return relative ? `${rootLabel.replace(/\\/g, "/")}/${relative}` : rootLabel;
}

async function readWorkspaceTextFile(uri: vscode.Uri, maxChars: number): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString("utf8");
    return text.slice(0, maxChars);
  } catch {
    return "";
  }
}

async function writeWorkspaceTextFile(uri: vscode.Uri, content: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}

function replaceTextRange(text: string, operation: Extract<FileOperation, { type: "replaceRange" }>): string {
  const lines = text.split(/\r?\n/);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const startOffset = positionToOffset(lines, operation.startLine, operation.startCharacter);
  const endOffset = positionToOffset(lines, operation.endLine, operation.endCharacter);
  return `${text.slice(0, startOffset)}${operation.content}${text.slice(endOffset)}`.replace(/\n/g, newline);
}

function positionToOffset(lines: string[], line: number, character: number): number {
  const safeLine = Math.max(0, Math.min(line, lines.length - 1));
  const safeCharacter = Math.max(0, Math.min(character, lines[safeLine]?.length ?? 0));
  let offset = 0;
  for (let index = 0; index < safeLine; index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return offset + safeCharacter;
}

function parseFileActionPlan(answer: string): FileActionPlan | undefined {
  const match = answer.match(/```clarus-actions\s*([\s\S]*?)```/i);
  if (!match) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(match[1]) as FileActionPlan;
    if (!Array.isArray(parsed.operations)) {
      throw new Error("operations must be an array");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not parse clarus-actions block: ${message}`);
    return undefined;
  }
}

function stripActionBlocks(answer: string): string {
  return answer.replace(/```clarus-actions\s*[\s\S]*?```/gi, "").trim();
}

function createActionBlockStreamFilter(emit: (chunk: string) => void) {
  let buffer = "";
  let insideActionBlock = false;
  const marker = "```clarus-actions";
  const fence = "```";
  const guardLength = marker.length + 8;

  function drain(force = false) {
    while (buffer) {
      if (insideActionBlock) {
        const end = buffer.indexOf(fence);
        if (end === -1) {
          if (force) {
            buffer = "";
          }
          return;
        }

        buffer = buffer.slice(end + fence.length);
        insideActionBlock = false;
        continue;
      }

      const start = buffer.toLowerCase().indexOf(marker);
      if (start === -1) {
        if (force || buffer.length > guardLength) {
          const emitLength = force ? buffer.length : buffer.length - guardLength;
          const text = buffer.slice(0, emitLength);
          buffer = buffer.slice(emitLength);
          if (text) {
            emit(text);
          }
        }
        return;
      }

      const text = buffer.slice(0, start);
      if (text) {
        emit(text);
      }
      buffer = buffer.slice(start + marker.length);
      insideActionBlock = true;
    }
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      drain(false);
    },
    flush() {
      drain(true);
    }
  };
}

function summarizePlan(plan: FileActionPlan): string {
  const lines = plan.operations.map((operation) => {
    switch (operation.type) {
      case "create":
        return `Create ${operation.path}`;
      case "replace":
        return `Replace ${operation.path}`;
      case "replaceRange":
        return `Edit ${operation.path}:${operation.startLine + 1}`;
      case "delete":
        return `Delete ${operation.path}`;
      case "runCommand":
        return `Run ${formatCommandForDisplay(operation)}`;
    }
  });

  return [plan.summary, ...lines].filter(Boolean).join("\n");
}

async function previewAndConfirmPlan(plan: FileActionPlan, summary: string): Promise<boolean> {
  void plan;
  void summary;
  return false;
}

function buildPlanPreviewMarkdown(plan: FileActionPlan, summary: string): string {
  const sections = [
    "# NH-AX-CODE 작업 미리보기",
    "",
    "## 요약",
    "",
    codeFence(summary || plan.summary || "요약 없음"),
    "",
    "## 작업 목록",
    ""
  ];

  plan.operations.forEach((operation, index) => {
    sections.push(`### ${index + 1}. ${describeOperation(operation)}`, "");

    if (operation.type === "create" || operation.type === "replace") {
      sections.push(`경로: \`${operation.path}\``, "", codeFence(truncatePreview(operation.content)), "");
      return;
    }

    if (operation.type === "replaceRange") {
      sections.push(
        `경로: \`${operation.path}\``,
        `범위: ${operation.startLine + 1}:${operation.startCharacter} - ${operation.endLine + 1}:${operation.endCharacter}`,
        "",
        codeFence(truncatePreview(operation.content)),
        ""
      );
      return;
    }

    if (operation.type === "delete") {
      sections.push(`경로: \`${operation.path}\``, "");
      return;
    }

    sections.push(
      `명령: \`${formatCommandForDisplay(operation)}\``,
      `작업 폴더: \`${operation.cwd ?? "."}\``,
      `제한 시간: ${operation.timeoutMs ?? 120000}ms`,
      ""
    );
  });

  return sections.join("\n");
}

function buildActionPreviewOperations(plan: FileActionPlan): unknown[] {
  return plan.operations.map((operation) => {
    if (operation.type === "runCommand") {
      return {
        type: operation.type,
        label: describeOperation(operation),
        command: formatCommandForDisplay(operation),
        preview: `작업 폴더: ${operation.cwd ?? "."}\n제한 시간: ${operation.timeoutMs ?? 120000}ms`
      };
    }

    if (operation.type === "delete") {
      return {
        type: operation.type,
        label: describeOperation(operation),
        path: operation.path
      };
    }

    if (operation.type === "replaceRange") {
      return {
        type: operation.type,
        label: describeOperation(operation),
        path: operation.path,
        preview: `범위: ${operation.startLine + 1}:${operation.startCharacter} - ${operation.endLine + 1}:${operation.endCharacter}\n\n${truncatePreview(operation.content)}`
      };
    }

    return {
      type: operation.type,
      label: describeOperation(operation),
      path: operation.path,
      preview: truncatePreview(operation.content)
    };
  });
}

function describeOperation(operation: FileOperation): string {
  switch (operation.type) {
    case "create":
      return `생성 ${operation.path}`;
    case "replace":
      return `교체 ${operation.path}`;
    case "replaceRange":
      return `수정 ${operation.path}`;
    case "delete":
      return `삭제 ${operation.path}`;
    case "runCommand":
      return `실행 ${formatCommandForDisplay(operation)}`;
  }
}

function truncatePreview(content: string): string {
  const maxChars = 16000;
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, maxChars)}\n\n... ${content.length - maxChars}자 생략 ...`;
}

function codeFence(content: string): string {
  return ["```", content.replace(/```/g, "'''"), "```"].join("\n");
}

async function applyFileActionPlan(plan: FileActionPlan, policy: FileActionPolicy): Promise<string> {
  const touched: string[] = [];
  const commands: Extract<FileOperation, { type: "runCommand" }>[] = [];
  const checkpoint = await createCheckpoint(plan);

  for (const operation of plan.operations) {
    if (operation.type === "runCommand") {
      commands.push(operation);
      continue;
    }

    assertFileActionAllowed(operation.path, policy);
    const uri = resolveWorkspaceUri(operation.path);
    touched.push(`${operation.type} ${operation.path}`);

    switch (operation.type) {
      case "create":
        await ensureParentDirectory(uri);
        if (await fileExists(uri)) {
          throw new Error(`이미 존재하는 파일입니다: ${operation.path}`);
        }
        await writeWorkspaceTextFile(uri, operation.content);
        break;
      case "replace": {
        await ensureParentDirectory(uri);
        await writeWorkspaceTextFile(uri, operation.content);
        break;
      }
      case "replaceRange": {
        const current = await readWorkspaceTextFile(uri, Number.MAX_SAFE_INTEGER);
        await writeWorkspaceTextFile(uri, replaceTextRange(current, operation));
        break;
      }
      case "delete":
        await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
        break;
      default:
        throw new Error(`Unsupported file operation: ${(operation as { type: string }).type}`);
    }
  }

  if (touched.length) {
    void touched;
    if (false) {
      throw new Error("VS Code가 워크스페이스 수정을 거부했습니다.");
    }

    await vscode.workspace.saveAll(false);
  }

  const commandResults: string[] = [];
  for (const command of commands) {
    commandResults.push(await runApprovedCommand(command));
  }

  const sections = [];
  if (checkpoint) {
    sections.push(`체크포인트 생성: ${checkpoint.id}`);
  }
  if (touched.length) {
    sections.push(`적용된 파일 작업:\n${touched.map((item) => `- ${item}`).join("\n")}`);
  }
  if (commandResults.length) {
    sections.push(`명령 실행 결과:\n${commandResults.join("\n\n")}`);
  }

  return sections.join("\n\n") || "적용된 파일 작업이 없습니다.";
}

async function createCheckpoint(plan: FileActionPlan): Promise<Checkpoint | undefined> {
  const targetPaths = uniqueStrings(plan.operations
    .filter((operation): operation is Exclude<FileOperation, { type: "runCommand" }> => operation.type !== "runCommand")
    .map((operation) => operation.path));

  if (!targetPaths.length) {
    return undefined;
  }

  const files: CheckpointFile[] = [];
  for (const relativePath of targetPaths) {
    const uri = resolveWorkspaceUri(relativePath);
    const existed = await fileExists(uri);
    files.push({
      path: relativePath,
      existed,
      content: existed ? await readWorkspaceTextFile(uri, Number.MAX_SAFE_INTEGER) : undefined
    });
  }

  const checkpoint: Checkpoint = {
    id: `${Date.now()}`,
    createdAt: new Date().toISOString(),
    summary: plan.summary ?? summarizePlan(plan),
    files
  };

  checkpoints.push(checkpoint);
  while (checkpoints.length > 20) {
    checkpoints.shift();
  }

  return checkpoint;
}

async function restoreLastCheckpoint(): Promise<void> {
  const checkpoint = checkpoints.at(-1);
  if (!checkpoint) {
    return;
  }

  const choice = "복원";

  if (choice !== "복원") {
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  for (const file of checkpoint.files) {
    const uri = resolveWorkspaceUri(file.path);
    const exists = await fileExists(uri);

    if (!file.existed) {
      if (exists) {
        edit.deleteFile(uri, { ignoreIfNotExists: true, recursive: false });
      }
      continue;
    }

    await ensureParentDirectory(uri);
    if (!exists) {
      edit.createFile(uri, { ignoreIfExists: true, overwrite: true });
      edit.insert(uri, new vscode.Position(0, 0), file.content ?? "");
      continue;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    edit.replace(uri, fullDocumentRange(document), file.content ?? "");
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    console.warn("VS Code rejected checkpoint restore.");
    return;
  }

  await vscode.workspace.saveAll(false);
}

function assertFileActionAllowed(relativePath: string, policy: FileActionPolicy) {
  if (policy.mode !== "scoped") {
    return;
  }

  if (!policy.scopePaths.length) {
    throw new Error("파일 작업이 차단되었습니다. @경로로 파일이나 폴더를 지정하거나 워크스페이스 수정 모드를 사용하세요.");
  }

  const normalizedTarget = normalizeRelativePath(relativePath);
  const allowed = policy.scopePaths.some((scopePath) => {
    const normalizedScope = normalizeRelativePath(scopePath);
    return normalizedTarget === normalizedScope || normalizedTarget.startsWith(`${normalizedScope}/`);
  });

  if (!allowed) {
    throw new Error(`@ 범위 밖 파일 작업이 차단되었습니다: ${relativePath}`);
  }
}

async function runApprovedCommand(operation: Extract<FileOperation, { type: "runCommand" }>): Promise<string> {
  const commandLabel = formatCommandForDisplay(operation);
  const cwdUri = resolveCommandCwd(operation.cwd ?? ".");
  const started = Date.now();
  try {
    const result = await execFileAsync(operation.command, operation.args ?? [], {
      cwd: cwdUri.fsPath,
      timeout: Math.min(Math.max(operation.timeoutMs ?? 120000, 1000), 600000),
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4
    });

    return [
      `$ ${commandLabel}`,
      `exit 0 in ${Date.now() - started}ms`,
      formatCommandOutput("stdout", result.stdout),
      formatCommandOutput("stderr", result.stderr)
    ].filter(Boolean).join("\n");
  } catch (error) {
    const commandError = error as {
      code?: number | string;
      signal?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };

    return [
      `$ ${commandLabel}`,
      `exit ${commandError.code ?? commandError.signal ?? "error"} in ${Date.now() - started}ms`,
      commandError.message ? `error:\n${commandError.message}` : "",
      formatCommandOutput("stdout", commandError.stdout),
      formatCommandOutput("stderr", commandError.stderr)
    ].filter(Boolean).join("\n");
  }
}

function resolveCommandCwd(relativePath: string): vscode.Uri {
  const uri = resolveWorkspaceUri(relativePath || ".");
  return uri;
}

function formatCommandForDisplay(operation: Extract<FileOperation, { type: "runCommand" }>): string {
  return [operation.command, ...(operation.args ?? [])].map(quoteCommandPart).join(" ");
}

function quoteCommandPart(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function formatCommandOutput(label: string, value: string | Buffer | undefined): string {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value ?? "";
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return `${label}:\n${trimmed.slice(0, 12000)}`;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function resolveMentionTarget(mention: string): { uri: vscode.Uri; label: string } {
  if (looksLikeAbsolutePath(mention)) {
    const uri = vscode.Uri.file(mention);
    return {
      uri,
      label: mention.replace(/\\/g, "/")
    };
  }

  const uri = resolveWorkspaceUri(mention);
  return {
    uri,
    label: vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/")
  };
}

function looksLikeAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);
}

function resolveWorkspaceUri(relativePath: string): vscode.Uri {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error("Open a workspace folder before applying file actions.");
  }

  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`파일 작업 경로는 워크스페이스 상대 경로여야 합니다: ${relativePath}`);
  }

  const root = workspaceFolder.uri.fsPath;
  const target = path.resolve(root, relativePath);
  const normalizedRoot = path.resolve(root);
  const insideRoot = target === normalizedRoot || target.startsWith(`${normalizedRoot}${path.sep}`);

  if (!insideRoot) {
    throw new Error(`파일 작업 경로가 워크스페이스 밖으로 벗어납니다: ${relativePath}`);
  }

  return vscode.Uri.file(target);
}

async function ensureParentDirectory(uri: vscode.Uri) {
  const parent = vscode.Uri.file(path.dirname(uri.fsPath));
  await vscode.workspace.fs.createDirectory(parent);
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  const lastLine = document.lineAt(document.lineCount - 1);
  return new vscode.Range(new vscode.Position(0, 0), lastLine.range.end);
}

function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function createRequestId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
