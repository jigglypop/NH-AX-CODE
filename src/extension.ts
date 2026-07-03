import * as vscode from "vscode";
import * as path from "path";

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

type AgentPermissionMode = "scoped" | "workspace" | "full";

interface WebviewAgentSettings {
  permissionMode?: AgentPermissionMode;
  planMode?: boolean;
  model?: string;
}

interface ProviderConfig {
  provider: "openai" | "anthropic" | "openai-compatible";
  apiKey: string;
  model: string;
  compatibleBaseUrl: string;
  requestHeaders: Record<string, string>;
  autoApplyFileActions: boolean;
}

type FileOperation =
  | { type: "create"; path: string; content: string }
  | { type: "replace"; path: string; content: string }
  | { type: "replaceRange"; path: string; startLine: number; startCharacter: number; endLine: number; endCharacter: number; content: string }
  | { type: "delete"; path: string };

interface FileActionPlan {
  summary?: string;
  operations: FileOperation[];
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

const SYSTEM_PROMPT = [
  "You are NH-AX-CODE, a careful coding assistant embedded in VS Code.",
  "Be concise, practical, and repository-aware.",
  "When asked to change, create, edit, or delete files, return a clarus-actions JSON code block after a short summary.",
  "The action block format is: ```clarus-actions {\"summary\":\"...\",\"operations\":[{\"type\":\"create|replace|replaceRange|delete\",\"path\":\"relative/path\",\"content\":\"...\"}]} ```.",
  "For replaceRange include startLine, startCharacter, endLine, and endCharacter as zero-based positions.",
  "Only use relative paths. Do not operate outside the workspace.",
  "If context is missing, ask one targeted question instead of guessing recklessly."
].join("\n");

const MAX_MENTION_FILES = 80;
const MAX_MENTION_FILE_CHARS = 12000;
const MAX_MENTION_CONTEXT_CHARS = 50000;

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
    vscode.commands.registerCommand("clarusCode.openPanel", () => provider.openPanel())
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
      const answer = await callModel(chatMessages, settings.model);

      this.postBridgeMessage({ type: "chatChunk", requestId, value: answer });
      await this.offerFileActions(requestId, answer, {
        mode: settings.permissionMode,
        scopePaths: mentionContext.scopePaths
      }, settings.planMode);
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
    const shouldApply = config.autoApplyFileActions
      ? true
      : await vscode.window.showWarningMessage(`NH-AX-CODE 파일 작업을 적용할까요?\n${summary}`, { modal: true }, "적용") === "적용";

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

async function callModel(messages: ChatMessage[], modelOverride?: string): Promise<string> {
  const config = getProviderConfig();

  if (!config.apiKey && config.provider !== "openai-compatible") {
    throw new Error("채팅 전에 VS Code 설정에서 clarusCode.apiKey를 입력하세요.");
  }

  if (config.provider === "anthropic") {
    return callAnthropic(config, messages, modelOverride);
  }

  return callOpenAICompatible(config, messages, modelOverride);
}

async function callOpenAICompatible(config: ProviderConfig, messages: ChatMessage[], modelOverride?: string): Promise<string> {
  const baseUrl = config.provider === "openai" ? "https://api.openai.com/v1" : config.compatibleBaseUrl.replace(/\/$/, "");
  const model = modelOverride || config.model;
  if (!isChatCompletionModel(model, config.provider)) {
    throw new Error(`${model}은 채팅 모델이 아닙니다. 하단 모델 목록에서 GPT/o 계열 채팅 모델을 선택하세요.`);
  }

  const response = await requestChatCompletion(baseUrl, config, messages, model);

  if (!response.ok) {
    const text = await response.text();
    if (isNotChatModelError(response.status, text)) {
      const fallbackModel = (await listModels()).find((candidate) => candidate !== model);
      if (fallbackModel) {
        const retry = await requestChatCompletion(baseUrl, config, messages, fallbackModel);
        if (retry.ok) {
          const data = await retry.json() as { choices?: Array<{ message?: { content?: string } }> };
          const content = data.choices?.[0]?.message?.content?.trim() || "응답 내용이 없습니다.";
          return `[${model} 대신 ${fallbackModel}로 재시도]\n\n${content}`;
        }
      }
    }

    throw new Error(`제공자 요청 실패: ${response.status} ${text}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() || "응답 내용이 없습니다.";
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
      messages,
      temperature: 0.2
    })
  });
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
      max_tokens: 4096,
      temperature: 0.2
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
    model: config.get<string>("model", "gpt-4.1"),
    compatibleBaseUrl: config.get<string>("openAICompatibleBaseUrl", "http://localhost:11434/v1"),
    requestHeaders: config.get<Record<string, string>>("requestHeaders", {}),
    autoApplyFileActions: config.get<boolean>("autoApplyFileActions", false)
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
  return [...configuredModel, ...models.filter((model) => model !== config.model)];
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

function formatWebviewMessageContent(message: WebviewChatMessage): string {
  const attachmentSummary = message.attachments?.length
    ? `\n\nAttachments:\n${message.attachments.map((attachment) => `- ${attachment.name} (${attachment.type})`).join("\n")}`
    : "";

  return `${message.content}${attachmentSummary}`;
}

function normalizeAgentSettings(settings?: WebviewAgentSettings): Required<WebviewAgentSettings> {
  const permissionMode = settings?.permissionMode === "workspace" || settings?.permissionMode === "full"
    ? settings.permissionMode
    : "scoped";

  return {
    permissionMode,
    planMode: settings?.planMode ?? false,
    model: settings?.model?.trim() || getProviderConfig().model
  };
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
    vscode.window.showErrorMessage(`Could not parse clarus-actions block: ${message}`);
    return undefined;
  }
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
    }
  });

  return [plan.summary, ...lines].filter(Boolean).join("\n");
}

async function applyFileActionPlan(plan: FileActionPlan, policy: FileActionPolicy): Promise<string> {
  const edit = new vscode.WorkspaceEdit();
  const touched: string[] = [];

  for (const operation of plan.operations) {
    assertFileActionAllowed(operation.path, policy);
    const uri = resolveWorkspaceUri(operation.path);
    touched.push(`${operation.type} ${operation.path}`);

    switch (operation.type) {
      case "create":
        await ensureParentDirectory(uri);
        edit.createFile(uri, { ignoreIfExists: false, overwrite: false });
        edit.insert(uri, new vscode.Position(0, 0), operation.content);
        break;
      case "replace": {
        await ensureParentDirectory(uri);
        const exists = await fileExists(uri);
        if (!exists) {
          edit.createFile(uri, { ignoreIfExists: false, overwrite: false });
          edit.insert(uri, new vscode.Position(0, 0), operation.content);
          break;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        edit.replace(uri, fullDocumentRange(document), operation.content);
        break;
      }
      case "replaceRange": {
        const range = new vscode.Range(
          new vscode.Position(operation.startLine, operation.startCharacter),
          new vscode.Position(operation.endLine, operation.endCharacter)
        );
        edit.replace(uri, range, operation.content);
        break;
      }
      case "delete":
        edit.deleteFile(uri, { ignoreIfNotExists: false, recursive: false });
        break;
      default:
        throw new Error(`Unsupported file operation: ${(operation as { type: string }).type}`);
    }
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error("VS Code rejected the workspace edit.");
  }

  await vscode.workspace.saveAll(false);
  return `Applied file actions:\n${touched.map((item) => `- ${item}`).join("\n")}`;
}

function assertFileActionAllowed(relativePath: string, policy: FileActionPolicy) {
  if (policy.mode !== "scoped") {
    return;
  }

  if (!policy.scopePaths.length) {
    throw new Error("File action blocked. Mention a file or folder with @path, or switch permission mode to workspace/full.");
  }

  const normalizedTarget = normalizeRelativePath(relativePath);
  const allowed = policy.scopePaths.some((scopePath) => {
    const normalizedScope = normalizeRelativePath(scopePath);
    return normalizedTarget === normalizedScope || normalizedTarget.startsWith(`${normalizedScope}/`);
  });

  if (!allowed) {
    throw new Error(`File action blocked outside @ scope: ${relativePath}`);
  }
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
    throw new Error(`File action path must be relative: ${relativePath}`);
  }

  const root = workspaceFolder.uri.fsPath;
  const target = path.resolve(root, relativePath);
  const normalizedRoot = path.resolve(root);
  const insideRoot = target === normalizedRoot || target.startsWith(`${normalizedRoot}${path.sep}`);

  if (!insideRoot) {
    throw new Error(`File action path escapes the workspace: ${relativePath}`);
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
