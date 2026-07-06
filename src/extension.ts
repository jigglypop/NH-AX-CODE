import * as vscode from "vscode";
import * as path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { ClosedLoopController, planSignature, type StepObservation } from "./agentLoop";
import { McpManager, type McpServerConfig } from "./mcp";

type ChatRole = "system" | "user" | "assistant" | "tool";

interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Native function-calling passthrough (OpenAI chat-completions). */
  tool_calls?: unknown;
  tool_call_id?: string;
  /** Anthropic native tool-use passthrough: raw content blocks for this turn. */
  anthropicContent?: unknown;
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
  toolMode: "actions-block" | "native";
}

interface NativeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  raw: unknown;
}

interface ModelCallResult {
  content: string;
  requestedModel: string;
  usedModel: string;
  streamed?: boolean;
  usage?: TokenUsage;
  toolCalls?: NativeToolCall[];
  /** Raw assistant payload for protocol-correct tool-result feedback. */
  rawAssistant?: unknown;
}

type FileOperation =
  | { type: "create"; path: string; content: string }
  | { type: "replace"; path: string; content: string }
  | { type: "replaceRange"; path: string; startLine: number; startCharacter: number; endLine: number; endCharacter: number; content: string }
  | { type: "delete"; path: string }
  | { type: "runCommand"; command: string; args?: string[]; cwd?: string; timeoutMs?: number }
  | { type: "readFile"; path: string; startLine?: number; endLine?: number }
  | { type: "listDir"; path: string }
  | { type: "searchText"; pattern: string; path?: string; maxResults?: number }
  | { type: "mcpTool"; server: string; tool: string; arguments?: Record<string, unknown> }
  | { type: "subagent"; task: string; context?: string };

type ReadOnlyOperation = Extract<FileOperation, { type: "readFile" | "listDir" | "searchText" | "subagent" }>;

// Read-only in the sense of "safe in plan mode": subagents are analysis-only
// nested loops (their own mutations are blocked). mcpTool may mutate external
// state, so it is NOT read-only.
function isReadOnlyOperation(operation: FileOperation): operation is ReadOnlyOperation {
  return operation.type === "readFile" || operation.type === "listDir" || operation.type === "searchText" || operation.type === "subagent";
}

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
  "The action block format is: ```clarus-actions {\"summary\":\"...\",\"operations\":[{\"type\":\"create|replace|replaceRange|delete|runCommand|readFile|listDir|searchText\",\"path\":\"relative/path\",\"content\":\"...\",\"command\":\"npm\",\"args\":[\"run\",\"build\"],\"cwd\":\".\"}]} ```.",
  "For replaceRange include startLine, startCharacter, endLine, and endCharacter as zero-based positions.",
  "For runCommand, provide command and args separately. Use cwd as a workspace-relative path.",
  "Read-only tools: readFile {path, startLine?, endLine?} returns file text; listDir {path} lists entries; searchText {pattern, path?, maxResults?} greps the workspace with a regex.",
  "Prefer readFile/searchText to inspect current state BEFORE editing a file you have not seen, and after a failure to diagnose it.",
  "subagent {task, context?} spawns a read-only analysis agent with its own loop and returns its findings — use for research subtasks that would bloat this conversation.",
  "mcpTool {server, tool, arguments} calls a connected MCP tool. Available MCP tools, if any, are listed under 'MCP tools' below.",
  "Only use relative file paths. Do not operate outside the workspace.",
  "After tool results are provided, continue only if another concrete action is needed. Otherwise answer with the final result and no clarus-actions block.",
  "If context is missing, ask one targeted question instead of guessing recklessly."
].join("\n");

const MAX_MENTION_FILES = 80;
const MAX_MENTION_FILE_CHARS = 12000;
const MAX_MENTION_CONTEXT_CHARS = 50000;
// Absolute cap on model/action rounds per turn. The effective budget is dynamic:
// ClosedLoopController stretches from a soft budget of 4 up to this cap only
// while the loop is making progress (F.3 dual-process depth).
const HARD_AGENT_STEP_CAP = 8;
const FALLBACK_CHAT_MODELS = ["gpt-5.5", "5.5", "gpt-4.1", "gpt-4o", "gpt-4.1-mini", "gpt-4o-mini", "o4-mini", "o3"];
const execFileAsync = promisify(execFile);
let checkpoints: Checkpoint[] = [];
let extensionContext: vscode.ExtensionContext | undefined;

const CHECKPOINT_STATE_KEY = "clarusCode.checkpoints";
const COMMAND_HISTORY_STATE_KEY = "clarusCode.commandHistory";
const ENDPOINT_CACHE_STATE_KEY = "clarusCode.endpointCache";
const SESSION_STATE_KEY = "clarusCode.session";

interface CommandHistoryEntry {
  command: string;
  cwd: string;
  exit: string;
  at: string;
  durationMs: number;
}

/** Virtual documents for diff previews (proposed content / checkpoint content). */
const virtualDocuments = new Map<string, string>();

class VirtualDocumentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "clarus-virtual";
  provideTextDocumentContent(uri: vscode.Uri): string {
    return virtualDocuments.get(uri.toString()) ?? "";
  }
}

function makeVirtualUri(kind: string, label: string, content: string): vscode.Uri {
  const uri = vscode.Uri.parse(`${VirtualDocumentProvider.scheme}:/${kind}/${Date.now()}/${label.replace(/\\/g, "/")}`);
  virtualDocuments.set(uri.toString(), content);
  return uri;
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  checkpoints = context.workspaceState.get<Checkpoint[]>(CHECKPOINT_STATE_KEY, []);
  const output = vscode.window.createOutputChannel("NH-AX-CODE");
  output.appendLine("Activating NH-AX-CODE.");
  const provider = new ChatViewProvider(context.extensionUri, output);

  context.subscriptions.push(
    output,
    vscode.workspace.registerTextDocumentContentProvider(VirtualDocumentProvider.scheme, new VirtualDocumentProvider()),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),
    vscode.commands.registerCommand("clarusCode.openChat", async () => {
      output.appendLine("Opening NH-AX-CODE chat view.");
      await provider.revealChatView();
    }),
    vscode.commands.registerCommand("clarusCode.openPanel", () => provider.openPanel()),
    vscode.commands.registerCommand("clarusCode.restoreLastCheckpoint", async () => {
      await restoreLastCheckpoint();
    }),
    vscode.commands.registerCommand("clarusCode.listCheckpoints", async () => {
      await showCheckpointList();
    }),
    vscode.commands.registerCommand("clarusCode.showCommandHistory", async () => {
      await showCommandHistory();
    }),
    vscode.commands.registerCommand("clarusCode.probeEndpoints", async () => {
      await probeEndpoints(output);
    }),
    vscode.commands.registerCommand("clarusCode.editPermissionRules", async () => {
      await editPermissionRules();
    }),
    vscode.commands.registerCommand("clarusCode.gitCommit", async () => {
      const result = await gitCommitWithAiMessage();
      output.appendLine(result);
      void vscode.window.showInformationMessage(result.split("\n")[0]);
    }),
    vscode.commands.registerCommand("clarusCode.reloadMcpServers", async () => {
      await mcpManager?.restart(getMcpServerConfigs());
      const tools = mcpManager?.allTools() ?? [];
      void vscode.window.showInformationMessage(`MCP 재시작 완료: 도구 ${tools.length}개`);
    })
  );

  mcpManager = new McpManager((line) => output.appendLine(line));
  void mcpManager.sync(getMcpServerConfigs());
  context.subscriptions.push({ dispose: () => mcpManager?.dispose() });

  output.appendLine(`Registered WebviewViewProvider: ${ChatViewProvider.viewType}`);
}

let mcpManager: McpManager | undefined;

function getMcpServerConfigs(): Record<string, McpServerConfig> {
  return vscode.workspace.getConfiguration("clarusCode").get<Record<string, McpServerConfig>>("mcpServers", {});
}

/** QuickPick-based editor for command allow/deny rules. */
async function editPermissionRules(): Promise<void> {
  const config = vscode.workspace.getConfiguration("clarusCode");

  while (true) {
    const listPick = await vscode.window.showQuickPick(
      [
        { label: `commandAllowlist (${config.get<string[]>("commandAllowlist", []).length})`, key: "commandAllowlist" as const },
        { label: `commandDenylist (${config.get<string[]>("commandDenylist", []).length})`, key: "commandDenylist" as const }
      ],
      { placeHolder: "편집할 규칙 목록 선택 (Esc: 종료)" }
    );
    if (!listPick) {
      return;
    }

    const rules = [...config.get<string[]>(listPick.key, [])];
    const rulePick = await vscode.window.showQuickPick(
      [
        { label: "$(add) 규칙 추가", action: "add" as const, rule: "" },
        ...rules.map((rule) => ({ label: `$(trash) ${rule}`, action: "remove" as const, rule }))
      ],
      { placeHolder: `${listPick.key} — 추가하거나 삭제할 규칙 선택` }
    );
    if (!rulePick) {
      continue;
    }

    if (rulePick.action === "add") {
      const value = await vscode.window.showInputBox({ prompt: "명령 접두사 (예: npm run, git status)" });
      if (value?.trim()) {
        rules.push(value.trim());
        await config.update(listPick.key, rules, vscode.ConfigurationTarget.Workspace);
      }
    } else {
      await config.update(listPick.key, rules.filter((rule) => rule !== rulePick.rule), vscode.ConfigurationTarget.Workspace);
    }
  }
}

/** Git workflow: stage everything, generate a commit message with the model, commit. */
async function gitCommitWithAiMessage(): Promise<string> {
  const status = await runApprovedCommand({ type: "runCommand", command: "git", args: ["status", "--porcelain"], cwd: "." });
  if (!/stdout:/.test(status)) {
    return "커밋할 변경이 없습니다.";
  }

  const diffStat = await runApprovedCommand({ type: "runCommand", command: "git", args: ["diff", "HEAD", "--stat"], cwd: "." });
  const diff = await runApprovedCommand({ type: "runCommand", command: "git", args: ["diff", "HEAD"], cwd: "." });

  const result = await callModel([
    { role: "system", content: "You write git commit messages. Reply with ONLY the commit message: an imperative summary line under 72 chars, then optionally a blank line and short body. No code fences." },
    { role: "user", content: `git status:\n${status.slice(0, 4000)}\n\n${diffStat.slice(0, 4000)}\n\ndiff (truncated):\n${diff.slice(0, 24000)}` }
  ]);
  const commitMessage = result.content.trim().replace(/^```[\s\S]*?\n|```$/g, "").trim();
  if (!commitMessage) {
    return "커밋 메시지 생성에 실패했습니다.";
  }

  const addResult = await runApprovedCommand({ type: "runCommand", command: "git", args: ["add", "-A"], cwd: "." });
  if (!/exit 0 /.test(addResult)) {
    return `git add 실패:\n${addResult}`;
  }
  const commitResult = await runApprovedCommand({ type: "runCommand", command: "git", args: ["commit", "-m", commitMessage], cwd: "." });
  return [`커밋 메시지:\n${commitMessage}`, commitResult].join("\n\n");
}

async function persistCheckpoints(): Promise<void> {
  await extensionContext?.workspaceState.update(CHECKPOINT_STATE_KEY, checkpoints);
}

async function recordCommandHistory(entry: CommandHistoryEntry): Promise<void> {
  if (!extensionContext) {
    return;
  }
  const history = extensionContext.globalState.get<CommandHistoryEntry[]>(COMMAND_HISTORY_STATE_KEY, []);
  history.push(entry);
  while (history.length > 100) {
    history.shift();
  }
  await extensionContext.globalState.update(COMMAND_HISTORY_STATE_KEY, history);
}

async function showCommandHistory(): Promise<void> {
  const history = extensionContext?.globalState.get<CommandHistoryEntry[]>(COMMAND_HISTORY_STATE_KEY, []) ?? [];
  if (!history.length) {
    void vscode.window.showInformationMessage("명령 실행 히스토리가 없습니다.");
    return;
  }
  await vscode.window.showQuickPick(
    [...history].reverse().map((entry) => ({
      label: entry.command,
      description: `exit ${entry.exit} · ${entry.durationMs}ms`,
      detail: `${entry.at} · cwd ${entry.cwd}`
    })),
    { placeHolder: "명령 실행 히스토리 (최근 100건)" }
  );
}

async function showCheckpointList(): Promise<void> {
  if (!checkpoints.length) {
    void vscode.window.showInformationMessage("저장된 체크포인트가 없습니다.");
    return;
  }

  const picked = await vscode.window.showQuickPick(
    [...checkpoints].reverse().map((checkpoint) => ({
      label: checkpoint.summary || checkpoint.id,
      description: checkpoint.createdAt,
      detail: checkpoint.files.map((file) => file.path).join(", "),
      checkpoint
    })),
    { placeHolder: "체크포인트 선택" }
  );
  if (!picked) {
    return;
  }

  const action = await vscode.window.showQuickPick(
    [
      { label: "$(diff) 복원 전 diff 보기", value: "diff" as const },
      { label: "$(history) 이 체크포인트로 복원", value: "restore" as const }
    ],
    { placeHolder: picked.checkpoint.summary }
  );
  if (!action) {
    return;
  }

  if (action.value === "diff") {
    for (const file of picked.checkpoint.files) {
      const uri = resolveWorkspaceUri(file.path);
      const checkpointContent = file.existed ? file.content ?? "" : "";
      const virtualUri = makeVirtualUri("checkpoint", file.path, checkpointContent);
      const exists = await fileExists(uri);
      const currentUri = exists ? uri : makeVirtualUri("empty", file.path, "");
      await vscode.commands.executeCommand("vscode.diff", currentUri, virtualUri, `${file.path}: 현재 ↔ 체크포인트`);
    }
    return;
  }

  await restoreCheckpoint(picked.checkpoint);
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

  private readonly cancelledRequests = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();

  private async handleMessage(message: { type: string; value?: unknown; requestId?: string; query?: string }) {
    switch (message.type) {
      case "chatRequest":
        await this.handleChatRequest(message as unknown as WebviewChatRequestMessage);
        break;
      case "chatCancel":
        if (message.requestId) {
          this.cancelledRequests.add(message.requestId);
          this.abortControllers.get(message.requestId)?.abort();
        }
        break;
      case "listModels":
        await this.handleListModels(message as unknown as WebviewListModelsMessage);
        break;
      case "listWorkspaceEntries":
        await this.handleListWorkspaceEntries(message as unknown as WebviewListWorkspaceEntriesMessage);
        break;
      case "saveSession":
        await extensionContext?.workspaceState.update(SESSION_STATE_KEY, message.value ?? null);
        break;
      case "loadSession": {
        const session = extensionContext?.workspaceState.get(SESSION_STATE_KEY) ?? null;
        this.postBridgeMessage({ type: "sessionData", requestId: message.requestId, value: session });
        break;
      }
      case "compactSession":
        await this.handleCompactSession(message as unknown as WebviewChatRequestMessage);
        break;
      case "gitCommit": {
        const requestId = message.requestId ?? "";
        try {
          const result = await gitCommitWithAiMessage();
          this.postBridgeMessage({ type: "chatChunk", requestId, value: result });
        } catch (error) {
          this.postBridgeMessage({ type: "chatChunk", requestId, value: `커밋 실패: ${error instanceof Error ? error.message : String(error)}` });
        }
        this.postBridgeMessage({ type: "chatDone", requestId });
        break;
      }
      case "listSkills": {
        const skills = await loadSkills();
        this.postBridgeMessage({ type: "skillList", requestId: message.requestId, value: skills });
        break;
      }
      case "clipboardWrite": {
        if (typeof message.value === "string") {
          await vscode.env.clipboard.writeText(message.value);
          vscode.window.setStatusBarMessage("NH-AX-CODE: 클립보드에 복사됨", 2000);
        }
        break;
      }
      case "saveFile": {
        const payload = message.value as { name?: string; content?: string } | undefined;
        if (!payload?.name) {
          break;
        }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const defaultUri = workspaceFolder
          ? vscode.Uri.joinPath(workspaceFolder.uri, payload.name)
          : vscode.Uri.file(payload.name);
        const target = await vscode.window.showSaveDialog({ defaultUri, saveLabel: "저장" });
        if (target) {
          await vscode.workspace.fs.writeFile(target, Buffer.from(payload.content ?? "", "utf8"));
          vscode.window.setStatusBarMessage(`NH-AX-CODE: ${path.basename(target.fsPath)} 저장됨`, 3000);
        }
        break;
      }
    }
  }

  /** /compact: summarize the conversation into one context block via the model. */
  private async handleCompactSession(message: WebviewChatRequestMessage) {
    const requestId = message.requestId;
    try {
      const settings = normalizeAgentSettings(message.settings);
      const transcript = (message.messages ?? [])
        .map((item) => `${item.role === "user" ? "사용자" : "어시스턴트"}: ${item.content}`)
        .join("\n\n");
      const result = await callModel([
        { role: "system", content: "You compress conversations. Summarize the following coding-session transcript into a compact Korean context note that preserves: the task goal, decisions made, files touched, current state, and open items. No preamble." },
        { role: "user", content: transcript.slice(0, 60000) }
      ], settings.model, settings.endpointMode, false);
      this.postBridgeMessage({ type: "sessionCompacted", requestId, value: result.content });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.postBridgeMessage({ type: "chatError", requestId, value: `컴팩트 실패: ${text}` });
    }
  }

  private async handleChatRequest(message: WebviewChatRequestMessage) {
    const requestId = message.requestId;

    const abortController = new AbortController();
    this.abortControllers.set(requestId, abortController);

    try {
      const settings = normalizeAgentSettings(message.settings);
      const mentionContext = await buildMentionContext(message.messages ?? []);
      const instructions = await loadProjectInstructions();
      const dynamicContext = await buildDynamicContext();
      const policy = {
        mode: settings.permissionMode,
        scopePaths: mentionContext.scopePaths
      };
      let chatMessages: ChatMessage[] = [
        {
          role: "system",
          content: [buildSystemPrompt(settings, mentionContext), instructions, dynamicContext].filter(Boolean).join("\n\n")
        },
        ...(message.messages ?? []).map((chatMessage) => ({
          role: chatMessage.role,
          content: formatWebviewMessageContent(chatMessage)
        }))
      ];

      // Automatic context compaction before the loop starts.
      try {
        chatMessages = await autoCompactMessages(chatMessages, settings.model, settings.endpointMode);
      } catch {
        // Compaction is best-effort; a failure must not kill the request.
      }

      // Closed-loop agent controller (docs/7_AGI/17_AgentLoop.md, Layer F).
      const controller = new ClosedLoopController();
      const nativeMode = getProviderConfig().toolMode === "native";
      for (let step = 0; step < HARD_AGENT_STEP_CAP; step += 1) {
        if (this.cancelledRequests.has(requestId)) {
          this.postBridgeMessage({ type: "chatChunk", requestId, value: "\n\n요청이 취소되었습니다." });
          break;
        }

        if (nativeMode) {
          const flow = await this.runNativeToolStep(requestId, chatMessages, settings, policy, controller, step, abortController.signal);
          if (flow === "break") {
            break;
          }
          continue;
        }

        const streamFilter = createActionBlockStreamFilter((chunk) => {
          this.postBridgeMessage({ type: "chatChunk", requestId, value: chunk });
        });
        const result = await callModel(chatMessages, settings.model, settings.endpointMode, settings.streamResponses, (chunk) => {
          streamFilter.push(chunk);
        }, abortController.signal);
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

        const observation = await this.applyActionsForAgentStep(requestId, answer, policy, settings.planMode)
          ?? { hasActions: false, planSignature: "", resultText: "", applyError: false };

        // Verification loop: run the configured verify command after mutations and
        // feed its outcome into the observation so the critic (F.4) can see it.
        if (observation.hasActions && !observation.applyError && observation.mutated) {
          const verifyResult = await runVerifyCommand(requestId, (event) => this.postBridgeMessage(event));
          if (verifyResult) {
            observation.resultText = `${observation.resultText}\n\n검증 명령 결과:\n${verifyResult}`;
          }
        }

        const decision = controller.step(step, observation);
        // F.-1.4: surface recursion-quality metrics so the loop is observable.
        this.postBridgeMessage({
          type: "loopMetrics",
          requestId,
          value: { ...decision.metrics, reason: decision.reason }
        });

        if (decision.action === "halt") {
          if (!observation.hasActions) {
            break; // model produced a final answer — nothing to report.
          }
          this.postBridgeMessage({
            type: "chatChunk",
            requestId,
            value: `\n\n루프 종료 (${decision.reason}). 현재 결과를 확인한 뒤 이어서 요청하세요.`
          });
          break;
        }

        chatMessages.push({ role: "assistant", content: answer });
        chatMessages.push({
          role: "user",
          content: ["작업 결과:", observation.resultText, "", decision.directive].join("\n")
        });
      }

      this.postBridgeMessage({ type: "chatDone", requestId });
    } catch (error) {
      if (this.cancelledRequests.has(requestId)) {
        this.postBridgeMessage({ type: "chatChunk", requestId, value: "\n\n요청이 취소되었습니다." });
        this.postBridgeMessage({ type: "chatDone", requestId });
        return;
      }
      const text = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Chat request error: ${text}`);
      this.postBridgeMessage({ type: "chatError", requestId, value: text });
    } finally {
      this.abortControllers.delete(requestId);
      this.cancelledRequests.delete(requestId);
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

  /**
   * One native function-calling round: call the model with tool schemas,
   * execute returned tool calls, append protocol-correct tool results, and
   * run the closed-loop controller on the observation.
   */
  private async runNativeToolStep(
    requestId: string,
    chatMessages: ChatMessage[],
    settings: Required<WebviewAgentSettings>,
    policy: FileActionPolicy,
    controller: ClosedLoopController,
    step: number,
    signal: AbortSignal
  ): Promise<"continue" | "break"> {
    const result = await callModelWithTools(chatMessages, settings.model, signal);
    this.postUsageIfNeeded(requestId, result.usage);

    if (result.content) {
      this.postBridgeMessage({ type: "chatChunk", requestId, value: step === 0 ? result.content : `\n\n${result.content}` });
    }

    if (!result.toolCalls?.length) {
      const decision = controller.step(step, { hasActions: false, planSignature: "", resultText: "", applyError: false });
      this.postBridgeMessage({ type: "loopMetrics", requestId, value: { ...decision.metrics, reason: decision.reason } });
      return "break";
    }

    const postToolEvent = (label: string, status: string, detail?: string) => {
      this.postBridgeMessage({ type: "toolEvent", requestId, value: { label, status, detail } });
    };

    const operations = result.toolCalls.map(toolCallToOperation);
    const perCallTexts: string[] = [];
    let anyMutated = false;
    let anyApplyError = false;

    for (let index = 0; index < result.toolCalls.length; index += 1) {
      const call = result.toolCalls[index];
      const operation = operations[index];

      if (!operation) {
        perCallTexts.push(`알 수 없는 도구: ${call.name}`);
        anyApplyError = true;
        continue;
      }

      if (settings.planMode && !isReadOnlyOperation(operation)) {
        perCallTexts.push(`계획 모드: ${call.name} 차단됨 (읽기 도구만 허용)`);
        postToolEvent(describeOperationLabel(operation), "blocked", "plan mode");
        continue;
      }

      const mutating = !isReadOnlyOperation(operation) && operation.type !== "mcpTool";
      if (mutating) {
        const preHook = await runHook("preAction", { summary: call.name, operations: operation.type });
        if (preHook && !preHook.ok) {
          perCallTexts.push(`preAction 훅이 ${call.name}을 차단했습니다:\n${preHook.output}`);
          postToolEvent(describeOperationLabel(operation), "blocked", preHook.output);
          continue;
        }
      }

      try {
        const text = await applyFileActionPlan({ operations: [operation] }, policy, postToolEvent);
        perCallTexts.push(text);
        if (mutating) {
          anyMutated = true;
          void runHook("postAction", { summary: call.name, result: text.slice(0, 4000) });
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        perCallTexts.push(`작업 적용 실패: ${text}`);
        anyApplyError = true;
        void runHook("onError", { error: text });
      }
    }

    // Verification loop feeds the critic in native mode too.
    if (anyMutated && !anyApplyError) {
      const verifyResult = await runVerifyCommand(requestId, (event) => this.postBridgeMessage(event));
      if (verifyResult) {
        perCallTexts.push(`검증 명령 결과:\n${verifyResult}`);
      }
    }

    const combined = perCallTexts.join("\n\n");
    this.postBridgeMessage({ type: "chatChunk", requestId, value: `\n\n${fenceToolResult(combined)}` });

    // Protocol-correct tool-result feedback.
    if (getProviderConfig().provider === "anthropic") {
      chatMessages.push({ role: "assistant", content: result.content, anthropicContent: result.rawAssistant });
      chatMessages.push({
        role: "user",
        content: combined,
        anthropicContent: result.toolCalls.map((call, index) => ({
          type: "tool_result",
          tool_use_id: call.id,
          content: [{ type: "text", text: perCallTexts[index]?.slice(0, 20000) ?? "" }]
        }))
      });
    } else {
      chatMessages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls.map((call) => call.raw) });
      for (let index = 0; index < result.toolCalls.length; index += 1) {
        chatMessages.push({ role: "tool", tool_call_id: result.toolCalls[index].id, content: perCallTexts[index]?.slice(0, 20000) ?? "" });
      }
    }

    const validOperations = operations.filter((operation): operation is FileOperation => Boolean(operation));
    const observation: StepObservation = {
      hasActions: true,
      planSignature: planSignature(validOperations as unknown as Array<Record<string, unknown>>),
      resultText: combined,
      applyError: anyApplyError,
      mutated: anyMutated
    };
    const decision = controller.step(step, observation);
    this.postBridgeMessage({ type: "loopMetrics", requestId, value: { ...decision.metrics, reason: decision.reason } });

    if (decision.action === "halt") {
      this.postBridgeMessage({ type: "chatChunk", requestId, value: `\n\n루프 종료 (${decision.reason}).` });
      return "break";
    }

    if (decision.directive) {
      chatMessages.push({ role: "user", content: decision.directive });
    }
    return "continue";
  }

  private async applyActionsForAgentStep(requestId: string, answer: string, policy: FileActionPolicy, planMode: boolean): Promise<StepObservation | undefined> {
    let plan = parseFileActionPlan(answer);
    if (!plan) {
      return undefined;
    }

    // Real plan mode: read-only tools stay available; mutations are blocked.
    if (planMode) {
      const readOnly = plan.operations.filter(isReadOnlyOperation);
      const blocked = plan.operations.length - readOnly.length;
      if (!readOnly.length) {
        const message = "계획 모드: 수정 작업은 차단되었습니다. readFile/listDir/searchText로 조사하거나 계획을 제시하세요.";
        this.postBridgeMessage({ type: "chatChunk", requestId, value: `\n\n${message}` });
        return blocked
          ? { hasActions: true, planSignature: planSignature(plan.operations as unknown as Array<Record<string, unknown>>), resultText: message, applyError: false, mutated: false }
          : undefined;
      }
      plan = { summary: plan.summary, operations: readOnly };
      if (blocked > 0) {
        this.postBridgeMessage({ type: "chatChunk", requestId, value: `\n\n계획 모드: 수정 작업 ${blocked}건은 차단하고 읽기 작업만 실행합니다.` });
      }
    }

    // Partial accept: when auto-apply is off, let the user pick operations (with diff preview).
    if (!planMode && !getProviderConfig().autoApplyFileActions) {
      const selected = await selectOperationsForApproval(plan);
      if (!selected) {
        const message = "사용자가 작업 적용을 거부했습니다.";
        this.postBridgeMessage({ type: "chatChunk", requestId, value: `\n\n${message}` });
        return { hasActions: true, planSignature: planSignature(plan.operations as unknown as Array<Record<string, unknown>>), resultText: message, applyError: false, mutated: false };
      }
      plan = selected;
    }

    const signature = planSignature(plan.operations as unknown as Array<Record<string, unknown>>);
    const mutated = plan.operations.some((operation) => !isReadOnlyOperation(operation));
    const postToolEvent = (label: string, status: string, detail?: string) => {
      this.postBridgeMessage({ type: "toolEvent", requestId, value: { label, status, detail } });
    };

    // preAction hook: a non-zero exit blocks the plan.
    if (mutated) {
      const preHook = await runHook("preAction", { summary: plan.summary ?? "", operations: JSON.stringify(plan.operations.map((operation) => operation.type)) });
      if (preHook && !preHook.ok) {
        const result = `preAction 훅이 작업을 차단했습니다:\n${preHook.output}`;
        this.postBridgeMessage({ type: "chatChunk", requestId, value: `\n\n${result}` });
        postToolEvent("hook:preAction", "blocked", preHook.output);
        return { hasActions: true, planSignature: signature, resultText: result, applyError: false, mutated: false };
      }
    }

    // Capture thrown apply errors so the closed loop can self-correct (F.4 c_pred)
    // instead of the whole turn dying on the first bad operation.
    try {
      const result = await applyFileActionPlan(plan, policy, postToolEvent);
      this.postBridgeMessage({ type: "chatChunk", requestId, value: `\n\n${fenceToolResult(result)}` });
      if (mutated) {
        void runHook("postAction", { summary: plan.summary ?? "", result: result.slice(0, 4000) });
      }
      return { hasActions: true, planSignature: signature, resultText: result, applyError: false, mutated };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const result = `작업 적용 실패: ${text}`;
      this.postBridgeMessage({ type: "chatChunk", requestId, value: `\n\n${fenceToolResult(result)}` });
      void runHook("onError", { error: text });
      return { hasActions: true, planSignature: signature, resultText: result, applyError: true, mutated };
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
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal
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
      content: await callAnthropic(config, messages, requestedModel, signal),
      requestedModel,
      usedModel: requestedModel
    };
  }

  return callOpenAICompatible(config, messages, modelOverride, onChunk, signal);
}

async function callOpenAICompatible(config: ProviderConfig, messages: ChatMessage[], modelOverride?: string, onChunk?: (chunk: string) => void, signal?: AbortSignal): Promise<ModelCallResult> {
  const baseUrl = config.provider === "openai" ? "https://api.openai.com/v1" : config.compatibleBaseUrl.replace(/\/$/, "");
  const model = modelOverride || config.model;
  return callOpenAIEndpointRouter(baseUrl, config, messages, model, onChunk, signal);
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

type EndpointName = Exclude<OpenAIEndpointMode, "auto">;

interface ModelEndpointCapability {
  ok?: EndpointName;
  failed: EndpointName[];
}

function getEndpointCache(): Record<string, ModelEndpointCapability> {
  return extensionContext?.globalState.get<Record<string, ModelEndpointCapability>>(ENDPOINT_CACHE_STATE_KEY, {}) ?? {};
}

async function updateEndpointCache(model: string, mutate: (entry: ModelEndpointCapability) => void): Promise<void> {
  if (!extensionContext) {
    return;
  }
  const cache = getEndpointCache();
  const entry = cache[model] ?? { failed: [] };
  mutate(entry);
  cache[model] = entry;
  await extensionContext.globalState.update(ENDPOINT_CACHE_STATE_KEY, cache);
}

/** Per-model capability cache + failed-endpoint blacklist applied to the try order. */
function orderEndpointsWithCache(model: string, endpoints: EndpointName[]): EndpointName[] {
  const entry = getEndpointCache()[model];
  if (!entry) {
    return endpoints;
  }
  const usable = endpoints.filter((endpoint) => !entry.failed.includes(endpoint));
  const pool = usable.length ? usable : endpoints; // never blacklist everything
  if (entry.ok && pool.includes(entry.ok)) {
    return [entry.ok, ...pool.filter((endpoint) => endpoint !== entry.ok)];
  }
  return pool;
}

async function callOpenAIEndpointRouter(
  baseUrl: string,
  config: ProviderConfig,
  messages: ChatMessage[],
  model: string,
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal
): Promise<ModelCallResult> {
  const errors: string[] = [];
  const endpoints = orderEndpointsWithCache(model, getOpenAIEndpointOrder(config.endpointMode));

  for (const endpoint of endpoints) {
    const response = await requestOpenAIEndpoint(baseUrl, config, messages, model, endpoint, config.streamResponses, signal);
    if (response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const isSse = contentType.includes("text/event-stream");
      const parsed = await readOpenAIEndpointResponseWithUsage(response, endpoint, onChunk);
      void updateEndpointCache(model, (entry) => {
        entry.ok = endpoint;
        entry.failed = entry.failed.filter((item) => item !== endpoint);
      });
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
    if (isEndpointFallbackError(response.status, text)) {
      // Structural mismatch (wrong endpoint for this model) — blacklist it.
      void updateEndpointCache(model, (entry) => {
        if (!entry.failed.includes(endpoint)) {
          entry.failed.push(endpoint);
        }
        if (entry.ok === endpoint) {
          entry.ok = undefined;
        }
      });
    }
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
  stream: boolean,
  signal?: AbortSignal
): Promise<Response> {
  const pathByEndpoint: Record<Exclude<OpenAIEndpointMode, "auto">, string> = {
    "chat-completions": "chat/completions",
    completions: "completions",
    responses: "responses"
  };

  return fetch(`${baseUrl}/${pathByEndpoint[endpoint]}`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...config.requestHeaders,
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
    },
    body: JSON.stringify(buildOpenAIEndpointBody(endpoint, messages, model, stream))
  });
}

/** Probe each endpoint with a tiny prompt and report a diagnostics table. */
async function probeEndpoints(output: vscode.OutputChannel): Promise<void> {
  const config = getProviderConfig();
  if (config.provider === "anthropic") {
    void vscode.window.showInformationMessage("Anthropic 제공자는 단일 messages 엔드포인트를 사용합니다. 진단이 필요 없습니다.");
    return;
  }

  const baseUrl = config.provider === "openai" ? "https://api.openai.com/v1" : config.compatibleBaseUrl.replace(/\/$/, "");
  const model = config.model;
  const probeMessages: ChatMessage[] = [{ role: "user", content: "ping" }];
  const lines: string[] = [`엔드포인트 진단 — model=${model}, baseUrl=${baseUrl}`];

  for (const endpoint of ["chat-completions", "responses", "completions"] as const) {
    const started = Date.now();
    try {
      const response = await requestOpenAIEndpoint(baseUrl, config, probeMessages, model, endpoint, false);
      lines.push(`${endpoint}: ${response.ok ? "OK" : `실패 ${response.status}`} (${Date.now() - started}ms)`);
      if (response.ok) {
        await updateEndpointCache(model, (entry) => {
          entry.ok = entry.ok ?? endpoint;
          entry.failed = entry.failed.filter((item) => item !== endpoint);
        });
      } else {
        const text = await response.text();
        if (isEndpointFallbackError(response.status, text)) {
          await updateEndpointCache(model, (entry) => {
            if (!entry.failed.includes(endpoint)) {
              entry.failed.push(endpoint);
            }
          });
        }
      }
    } catch (error) {
      lines.push(`${endpoint}: 오류 ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const cacheEntry = getEndpointCache()[model];
  lines.push(`캐시: ok=${cacheEntry?.ok ?? "-"}, blacklist=[${cacheEntry?.failed.join(", ") ?? ""}]`);
  output.appendLine(lines.join("\n"));
  output.show(true);
  void vscode.window.showInformationMessage(lines.join(" · "));
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

async function callAnthropic(config: ProviderConfig, messages: ChatMessage[], modelOverride?: string, signal?: AbortSignal): Promise<string> {
  const system = messages.find((message) => message.role === "system")?.content ?? SYSTEM_PROMPT;
  const chatMessages = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, content: message.content }));

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
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

// ---------------------------------------------------------------------------
// Native function-calling (toolMode: "native")
// ---------------------------------------------------------------------------

interface NativeToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

function buildNativeToolSchemas(): NativeToolSchema[] {
  const stringProp = { type: "string" };
  const base: NativeToolSchema[] = [
    { name: "create_file", description: "Create a new file with content.", parameters: { type: "object", properties: { path: stringProp, content: stringProp }, required: ["path", "content"] } },
    { name: "replace_file", description: "Replace an entire file's content.", parameters: { type: "object", properties: { path: stringProp, content: stringProp }, required: ["path", "content"] } },
    { name: "replace_range", description: "Replace a zero-based position range in a file.", parameters: { type: "object", properties: { path: stringProp, startLine: { type: "number" }, startCharacter: { type: "number" }, endLine: { type: "number" }, endCharacter: { type: "number" }, content: stringProp }, required: ["path", "startLine", "startCharacter", "endLine", "endCharacter", "content"] } },
    { name: "delete_file", description: "Delete a file.", parameters: { type: "object", properties: { path: stringProp }, required: ["path"] } },
    { name: "run_command", description: "Run a shell command in the workspace.", parameters: { type: "object", properties: { command: stringProp, args: { type: "array", items: stringProp }, cwd: stringProp }, required: ["command"] } },
    { name: "read_file", description: "Read a file (optionally a line range).", parameters: { type: "object", properties: { path: stringProp, startLine: { type: "number" }, endLine: { type: "number" } }, required: ["path"] } },
    { name: "list_dir", description: "List a directory.", parameters: { type: "object", properties: { path: stringProp }, required: ["path"] } },
    { name: "search_text", description: "Regex search across the workspace.", parameters: { type: "object", properties: { pattern: stringProp, path: stringProp, maxResults: { type: "number" } }, required: ["pattern"] } },
    { name: "subagent", description: "Spawn a read-only research subagent; returns its findings.", parameters: { type: "object", properties: { task: stringProp, context: stringProp }, required: ["task"] } }
  ];

  const mcp = (mcpManager?.allTools() ?? []).map((tool) => ({
    name: `mcp__${tool.server}__${tool.name}`,
    description: tool.description.slice(0, 500) || `MCP tool ${tool.name} on ${tool.server}`,
    parameters: tool.inputSchema ?? { type: "object", properties: {} }
  }));

  return [...base, ...mcp];
}

function toolCallToOperation(call: NativeToolCall): FileOperation | undefined {
  const args = call.arguments as Record<string, unknown>;
  const str = (key: string) => String(args[key] ?? "");
  const num = (key: string) => Number(args[key] ?? 0);

  switch (call.name) {
    case "create_file":
      return { type: "create", path: str("path"), content: str("content") };
    case "replace_file":
      return { type: "replace", path: str("path"), content: str("content") };
    case "replace_range":
      return { type: "replaceRange", path: str("path"), startLine: num("startLine"), startCharacter: num("startCharacter"), endLine: num("endLine"), endCharacter: num("endCharacter"), content: str("content") };
    case "delete_file":
      return { type: "delete", path: str("path") };
    case "run_command":
      return { type: "runCommand", command: str("command"), args: Array.isArray(args.args) ? args.args.map(String) : undefined, cwd: args.cwd ? str("cwd") : undefined };
    case "read_file":
      return { type: "readFile", path: str("path"), startLine: args.startLine ? num("startLine") : undefined, endLine: args.endLine ? num("endLine") : undefined };
    case "list_dir":
      return { type: "listDir", path: str("path") };
    case "search_text":
      return { type: "searchText", pattern: str("pattern"), path: args.path ? str("path") : undefined, maxResults: args.maxResults ? num("maxResults") : undefined };
    case "subagent":
      return { type: "subagent", task: str("task"), context: args.context ? str("context") : undefined };
    default: {
      if (call.name.startsWith("mcp__")) {
        const [, server, ...rest] = call.name.split("__");
        if (server && rest.length) {
          return { type: "mcpTool", server, tool: rest.join("__"), arguments: args };
        }
      }
      return undefined;
    }
  }
}

/**
 * Model call with native tool schemas. OpenAI/compatible uses chat-completions
 * function calling; Anthropic uses tool_use blocks. Streaming is disabled.
 */
async function callModelWithTools(messages: ChatMessage[], modelOverride?: string, signal?: AbortSignal): Promise<ModelCallResult> {
  const config = getProviderConfig();
  const tools = buildNativeToolSchemas();
  const model = modelOverride || config.model;

  if (config.provider === "anthropic") {
    const system = messages.find((message) => message.role === "system")?.content;
    const anthropicMessages = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "tool" ? "user" : message.role,
        content: message.anthropicContent ?? message.content
      }));

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...config.requestHeaders,
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        system,
        messages: anthropicMessages,
        max_tokens: 8192,
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic 요청 실패: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>; usage?: { input_tokens?: number; output_tokens?: number } };
    const blocks = data.content ?? [];
    const content = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("").trim();
    const toolCalls: NativeToolCall[] = blocks
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ id: block.id ?? "", name: block.name ?? "", arguments: block.input ?? {}, raw: block }));

    return {
      content,
      requestedModel: model,
      usedModel: model,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      rawAssistant: blocks,
      usage: data.usage ? { input: data.usage.input_tokens, output: data.usage.output_tokens } : undefined
    };
  }

  // OpenAI / OpenAI-compatible: chat-completions function calling.
  const baseUrl = config.provider === "openai" ? "https://api.openai.com/v1" : config.compatibleBaseUrl.replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...config.requestHeaders,
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {})
      })),
      tools: tools.map((tool) => ({ type: "function", function: tool }))
    })
  });

  if (!response.ok) {
    throw new Error(`제공자 요청 실패 (native tools): ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const assistantMessage = data.choices?.[0]?.message;
  const toolCalls: NativeToolCall[] = (assistantMessage?.tool_calls ?? []).map((call) => {
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(call.function?.arguments || "{}");
    } catch {
      parsedArgs = { _raw: call.function?.arguments };
    }
    return { id: call.id ?? "", name: call.function?.name ?? "", arguments: parsedArgs, raw: call };
  });

  return {
    content: (assistantMessage?.content ?? "").toString().trim(),
    requestedModel: model,
    usedModel: model,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    rawAssistant: assistantMessage,
    usage: data.usage ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens, total: data.usage.total_tokens } : undefined
  };
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
    streamResponses: config.get<boolean>("streamResponses", true),
    toolMode: config.get<"actions-block" | "native">("toolMode", "actions-block")
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
      case "readFile":
      case "listDir":
      case "searchText":
      case "subagent":
        return describeReadOnlyOperation(operation);
      case "mcpTool":
        return `MCP ${operation.server}/${operation.tool}`;
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

    if (isReadOnlyOperation(operation)) {
      sections.push(`읽기: \`${describeReadOnlyOperation(operation)}\``, "");
      return;
    }

    if (operation.type === "mcpTool") {
      sections.push(`MCP: \`${operation.server}/${operation.tool}\``, "");
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

    if (isReadOnlyOperation(operation) || operation.type === "mcpTool") {
      return {
        type: operation.type,
        label: describeOperation(operation)
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
    case "readFile":
    case "listDir":
    case "searchText":
    case "subagent":
      return `읽기 ${describeReadOnlyOperation(operation)}`;
    case "mcpTool":
      return `MCP ${operation.server}/${operation.tool}`;
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

/**
 * Wrap raw tool output in a markdown code fence so the webview renderer keeps
 * line breaks and monospacing. The fence is grown past any backtick run inside
 * the content (readFile results contain ``` fences of their own).
 */
function fenceToolResult(text: string): string {
  const longestBacktickRun = text.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = "`".repeat(Math.max(4, longestBacktickRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}

type ToolEventPoster = (label: string, status: string, detail?: string) => void;

async function applyFileActionPlan(plan: FileActionPlan, policy: FileActionPolicy, postToolEvent?: ToolEventPoster): Promise<string> {
  const touched: string[] = [];
  const commands: Extract<FileOperation, { type: "runCommand" }>[] = [];
  const readResults: string[] = [];
  const checkpoint = await createCheckpoint(plan);

  for (const operation of plan.operations) {
    if (operation.type === "runCommand") {
      commands.push(operation);
      continue;
    }

    if (operation.type === "mcpTool") {
      const label = `mcp:${operation.server}/${operation.tool}`;
      postToolEvent?.(label, "running");
      try {
        if (!mcpManager) {
          throw new Error("MCP 매니저가 초기화되지 않았습니다.");
        }
        const text = await mcpManager.callTool(operation.server, operation.tool, operation.arguments ?? {});
        readResults.push(`${label} 결과:\n${text.slice(0, 24000)}`);
        postToolEvent?.(label, "done");
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        readResults.push(`${label} 실패: ${text}`);
        postToolEvent?.(label, "error", text);
      }
      continue;
    }

    if (isReadOnlyOperation(operation)) {
      const label = describeReadOnlyOperation(operation);
      postToolEvent?.(label, "running");
      try {
        readResults.push(await runReadOnlyOperation(operation));
        postToolEvent?.(label, "done");
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        readResults.push(`${label} 실패: ${text}`);
        postToolEvent?.(label, "error", text);
      }
      continue;
    }

    assertFileActionAllowed(operation.path, policy);
    const uri = resolveWorkspaceUri(operation.path);
    touched.push(`${operation.type} ${operation.path}`);
    postToolEvent?.(`${operation.type} ${operation.path}`, "done");

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
    const label = formatCommandForDisplay(command);
    const ruling = evaluateCommandRules(label);
    if (ruling.blocked) {
      commandResults.push(`$ ${label}\n차단되었습니다: ${ruling.reason}`);
      postToolEvent?.(`$ ${label}`, "blocked", ruling.reason);
      continue;
    }
    postToolEvent?.(`$ ${label}`, "running");
    const result = await runApprovedCommand(command, (chunk) => postToolEvent?.(`$ ${label}`, "output", chunk));
    postToolEvent?.(`$ ${label}`, /\nexit 0 /.test(`\n${result}`) ? "done" : "error");
    commandResults.push(result);
  }

  const sections = [];
  if (checkpoint) {
    sections.push(`체크포인트 생성: ${checkpoint.id}`);
  }
  if (touched.length) {
    sections.push(`적용된 파일 작업:\n${touched.map((item) => `- ${item}`).join("\n")}`);
  }
  if (readResults.length) {
    sections.push(`읽기 도구 결과:\n${readResults.join("\n\n")}`);
  }
  if (commandResults.length) {
    sections.push(`명령 실행 결과:\n${commandResults.join("\n\n")}`);
  }

  return sections.join("\n\n") || "적용된 파일 작업이 없습니다.";
}

function describeReadOnlyOperation(operation: ReadOnlyOperation): string {
  if (operation.type === "readFile") {
    return `readFile ${operation.path}`;
  }
  if (operation.type === "listDir") {
    return `listDir ${operation.path}`;
  }
  if (operation.type === "subagent") {
    return `subagent "${operation.task.slice(0, 80)}"`;
  }
  return `searchText /${operation.pattern}/${operation.path ? ` in ${operation.path}` : ""}`;
}

async function runReadOnlyOperation(operation: ReadOnlyOperation): Promise<string> {
  if (operation.type === "subagent") {
    const findings = await runSubagent(operation.task, operation.context);
    return `subagent 결과 (task: ${operation.task.slice(0, 120)}):\n${findings.slice(0, 24000)}`;
  }

  if (operation.type === "readFile") {
    const uri = resolveWorkspaceUri(operation.path);
    const text = await readWorkspaceTextFile(uri, 200000);
    const lines = text.split(/\r?\n/);
    const start = Math.max(0, (operation.startLine ?? 1) - 1);
    const end = Math.min(lines.length, operation.endLine ?? Math.min(lines.length, start + 400));
    const slice = lines.slice(start, end).map((line, index) => `${start + index + 1}\t${line}`).join("\n");
    return [`readFile ${operation.path} (${start + 1}-${end}/${lines.length}줄)`, "```", slice.slice(0, 24000), "```"].join("\n");
  }

  if (operation.type === "listDir") {
    const uri = resolveWorkspaceUri(operation.path || ".");
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const listing = entries
      .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] === vscode.FileType.Directory ? -1 : 1))
      .map(([name, type]) => `${type === vscode.FileType.Directory ? "dir " : "file"} ${name}`)
      .slice(0, 300)
      .join("\n");
    return `listDir ${operation.path}\n${listing || "(비어 있음)"}`;
  }

  // searchText: bounded workspace grep.
  const pattern = new RegExp(operation.pattern, "i");
  const maxResults = Math.min(Math.max(operation.maxResults ?? 40, 1), 200);
  const include = operation.path ? `${normalizeRelativePath(operation.path)}/**/*` : "**/*";
  const files = await vscode.workspace.findFiles(include, "{**/node_modules/**,**/dist/**,**/.git/**}", 800);
  const hits: string[] = [];
  for (const file of files) {
    if (hits.length >= maxResults) {
      break;
    }
    let text: string;
    try {
      text = await readWorkspaceTextFile(file, 300000);
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length && hits.length < maxResults; index += 1) {
      if (pattern.test(lines[index])) {
        hits.push(`${vscode.workspace.asRelativePath(file, false)}:${index + 1}: ${lines[index].trim().slice(0, 200)}`);
      }
    }
  }
  return `searchText /${operation.pattern}/ → ${hits.length}건\n${hits.join("\n") || "(일치 없음)"}`;
}

function evaluateCommandRules(commandLabel: string): { blocked: boolean; reason: string } {
  const config = vscode.workspace.getConfiguration("clarusCode");
  const denylist = config.get<string[]>("commandDenylist", []);
  const allowlist = config.get<string[]>("commandAllowlist", []);
  const normalized = commandLabel.trim().toLowerCase();

  const denied = denylist.find((rule) => rule.trim() && normalized.startsWith(rule.trim().toLowerCase()));
  if (denied) {
    return { blocked: true, reason: `denylist 규칙 '${denied}'` };
  }

  if (allowlist.length && !allowlist.some((rule) => rule.trim() && normalized.startsWith(rule.trim().toLowerCase()))) {
    return { blocked: true, reason: "allowlist에 없는 명령" };
  }

  return { blocked: false, reason: "" };
}

/** Partial accept: per-operation selection with on-demand diff preview. */
async function selectOperationsForApproval(plan: FileActionPlan): Promise<FileActionPlan | undefined> {
  interface OperationItem extends vscode.QuickPickItem {
    operation: FileOperation;
  }

  const items: OperationItem[] = plan.operations.map((operation) => ({
    label: operation.type === "runCommand" ? `$ ${formatCommandForDisplay(operation)}` : describeOperationLabel(operation),
    picked: true,
    operation,
    buttons: hasDiffPreview(operation) ? [{ iconPath: new vscode.ThemeIcon("diff"), tooltip: "diff 미리보기" }] : []
  }));

  const quickPick = vscode.window.createQuickPick<OperationItem>();
  quickPick.title = plan.summary || "제안된 작업";
  quickPick.placeholder = "적용할 작업을 선택하세요 (diff 버튼으로 미리보기)";
  quickPick.canSelectMany = true;
  quickPick.items = items;
  quickPick.selectedItems = items;

  quickPick.onDidTriggerItemButton(async (event) => {
    await showOperationDiff(event.item.operation);
  });

  const selection = await new Promise<readonly OperationItem[] | undefined>((resolve) => {
    quickPick.onDidAccept(() => resolve(quickPick.selectedItems));
    quickPick.onDidHide(() => resolve(undefined));
    quickPick.show();
  });
  quickPick.dispose();

  if (!selection || !selection.length) {
    return undefined;
  }

  return { summary: plan.summary, operations: selection.map((item) => item.operation) };
}

function describeOperationLabel(operation: FileOperation): string {
  if (isReadOnlyOperation(operation)) {
    return describeReadOnlyOperation(operation);
  }
  if (operation.type === "runCommand") {
    return `$ ${formatCommandForDisplay(operation)}`;
  }
  if (operation.type === "mcpTool") {
    return `mcp:${operation.server}/${operation.tool}`;
  }
  return `${operation.type} ${operation.path}`;
}

function hasDiffPreview(operation: FileOperation): boolean {
  return operation.type === "create" || operation.type === "replace" || operation.type === "replaceRange" || operation.type === "delete";
}

async function showOperationDiff(operation: FileOperation): Promise<void> {
  if (operation.type !== "create" && operation.type !== "replace" && operation.type !== "replaceRange" && operation.type !== "delete") {
    return;
  }

  const uri = resolveWorkspaceUri(operation.path);
  const exists = await fileExists(uri);
  const current = exists ? await readWorkspaceTextFile(uri, Number.MAX_SAFE_INTEGER) : "";

  let proposed = "";
  if (operation.type === "create" || operation.type === "replace") {
    proposed = operation.content;
  } else if (operation.type === "replaceRange") {
    proposed = replaceTextRange(current, operation);
  } // delete → proposed stays ""

  const leftUri = exists ? uri : makeVirtualUri("empty", operation.path, "");
  const rightUri = makeVirtualUri("proposed", operation.path, proposed);
  await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, `${operation.path}: 현재 ↔ 제안`);
}

/** Load AGENTS.md / CLAUDE.md / NH-AX-CODE.md instructions from the workspace root. */
async function loadProjectInstructions(): Promise<string> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return "";
  }

  const chunks: string[] = [];
  let remaining = 16000;
  for (const name of ["NH-AX-CODE.md", "AGENTS.md", "CLAUDE.md"]) {
    if (remaining <= 0) {
      break;
    }
    try {
      const uri = vscode.Uri.joinPath(workspaceFolder.uri, name);
      const text = (await readWorkspaceTextFile(uri, remaining)).trim();
      if (text) {
        chunks.push(`## ${name}\n${text}`);
        remaining -= text.length;
      }
    } catch {
      continue;
    }
  }

  return chunks.length ? `Project instructions (follow these):\n${chunks.join("\n\n")}` : "";
}

interface HookConfig {
  preAction?: string;
  postAction?: string;
  onError?: string;
}

/**
 * Run a configured hook command. Returns { ok, output }. A non-zero preAction
 * exit blocks the pending plan (Claude Code hook semantics).
 */
async function runHook(name: keyof HookConfig, payload: Record<string, string>): Promise<{ ok: boolean; output: string } | undefined> {
  const hooks = vscode.workspace.getConfiguration("clarusCode").get<HookConfig>("hooks", {});
  const command = hooks[name]?.trim();
  if (!command) {
    return undefined;
  }

  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
  if (!parts.length) {
    return undefined;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return new Promise((resolve) => {
    const child = spawn(parts[0], parts.slice(1), {
      cwd: workspaceFolder?.uri.fsPath,
      windowsHide: true,
      shell: process.platform === "win32",
      env: {
        ...process.env,
        ...Object.fromEntries(Object.entries(payload).map(([key, value]) => [`CLARUS_${key.toUpperCase()}`, value.slice(0, 8000)]))
      }
    });
    let output = "";
    child.stdout?.on("data", (data: Buffer) => { output += data.toString("utf8"); });
    child.stderr?.on("data", (data: Buffer) => { output += data.toString("utf8"); });
    const timer = setTimeout(() => child.kill(), 30000);
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, output: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: output.trim().slice(0, 4000) }); });
  });
}

interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

/** Discover skills: .nhax/skills/*.md — first non-empty line is the description. */
async function loadSkills(): Promise<SkillInfo[]> {
  const files = await vscode.workspace.findFiles(".nhax/skills/*.md", undefined, 50);
  const skills: SkillInfo[] = [];
  for (const file of files) {
    try {
      const text = await readWorkspaceTextFile(file, 2000);
      const description = text.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
      const relativePath = vscode.workspace.asRelativePath(file, false).replace(/\\/g, "/");
      skills.push({ name: path.basename(file.fsPath, ".md"), description, path: relativePath });
    } catch {
      continue;
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Dynamic capability context appended to the system prompt: MCP tools + skills. */
async function buildDynamicContext(): Promise<string> {
  const sections: string[] = [];

  const mcpTools = mcpManager?.allTools() ?? [];
  if (mcpTools.length) {
    sections.push([
      "MCP tools (call via mcpTool operation):",
      ...mcpTools.map((tool) => `- server=${tool.server} tool=${tool.name}: ${tool.description.slice(0, 200)}`)
    ].join("\n"));
  }

  const skills = await loadSkills();
  if (skills.length) {
    sections.push([
      "Skills (load the file with readFile when the task matches):",
      ...skills.map((skill) => `- ${skill.name}: ${skill.description.slice(0, 160)} (${skill.path})`)
    ].join("\n"));
  }

  return sections.join("\n\n");
}

/**
 * Automatic context compaction: when the transcript exceeds the configured
 * character budget, summarize everything but the newest turns into one note.
 */
async function autoCompactMessages(chatMessages: ChatMessage[], model: string, endpointMode: OpenAIEndpointMode): Promise<ChatMessage[]> {
  const threshold = vscode.workspace.getConfiguration("clarusCode").get<number>("autoCompactThreshold", 120000);
  if (!threshold) {
    return chatMessages;
  }

  const total = chatMessages.reduce((sum, message) => sum + message.content.length, 0);
  if (total <= threshold) {
    return chatMessages;
  }

  const keepTail = 4;
  const system = chatMessages[0];
  const middle = chatMessages.slice(1, Math.max(1, chatMessages.length - keepTail));
  const tail = chatMessages.slice(Math.max(1, chatMessages.length - keepTail));
  if (!middle.length) {
    return chatMessages;
  }

  const transcript = middle.map((message) => `${message.role}: ${message.content}`).join("\n\n").slice(0, 80000);
  const summary = await callModel([
    { role: "system", content: "Summarize this coding-session transcript into a compact context note preserving: goal, decisions, files touched, current state, open items. Korean. No preamble." },
    { role: "user", content: transcript }
  ], model, endpointMode, false);

  return [
    system,
    { role: "user", content: `이전 대화 자동 요약 (컨텍스트 절약):\n${summary.content}` },
    ...tail
  ];
}

/**
 * Subagent: nested read-only analysis loop with its own context.
 * Mutating and mcpTool operations are ignored; read tools run for real.
 */
async function runSubagent(task: string, context: string | undefined, signal?: AbortSignal): Promise<string> {
  const subMessages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You are a read-only research subagent inside NH-AX-CODE.",
        "You may use ONLY readFile/listDir/searchText via clarus-actions blocks to inspect the workspace.",
        "Never propose create/replace/delete/runCommand — they will be ignored.",
        "When done, answer with your findings as plain text and NO clarus-actions block.",
        SYSTEM_PROMPT
      ].join("\n")
    },
    { role: "user", content: [task, context ? `\n추가 컨텍스트:\n${context}` : ""].join("") }
  ];

  let lastContent = "";
  for (let step = 0; step < 4; step += 1) {
    const result = await callModel(subMessages, undefined, undefined, false, undefined, signal);
    lastContent = stripActionBlocks(result.content).trim() || lastContent;
    const plan = parseFileActionPlan(result.content);
    const readOps = plan?.operations.filter((operation): operation is Exclude<ReadOnlyOperation, { type: "subagent" }> =>
      operation.type === "readFile" || operation.type === "listDir" || operation.type === "searchText") ?? [];
    if (!readOps.length) {
      break;
    }

    const results: string[] = [];
    for (const operation of readOps.slice(0, 8)) {
      try {
        results.push(await runReadOnlyOperation(operation));
      } catch (error) {
        results.push(`${describeReadOnlyOperation(operation)} 실패: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    subMessages.push({ role: "assistant", content: result.content });
    subMessages.push({ role: "user", content: `도구 결과:\n${results.join("\n\n").slice(0, 30000)}\n\n조사가 끝났으면 clarus-actions 없이 결론만 답하세요.` });
  }

  return lastContent || "서브에이전트가 결과를 내지 못했습니다.";
}

/** Run the configured verify command; returns its output or undefined when unset. */
async function runVerifyCommand(requestId: string, post: (message: unknown) => void): Promise<string | undefined> {
  const raw = vscode.workspace.getConfiguration("clarusCode").get<string>("verifyCommand", "").trim();
  if (!raw) {
    return undefined;
  }

  const parts = raw.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
  if (!parts.length) {
    return undefined;
  }

  post({ type: "toolEvent", requestId, value: { label: `verify: ${raw}`, status: "running" } });
  const result = await runApprovedCommand({ type: "runCommand", command: parts[0], args: parts.slice(1), cwd: "." });
  post({ type: "toolEvent", requestId, value: { label: `verify: ${raw}`, status: /\nexit 0 /.test(`\n${result}`) ? "done" : "error" } });
  return result;
}

async function createCheckpoint(plan: FileActionPlan): Promise<Checkpoint | undefined> {
  const targetPaths = uniqueStrings(plan.operations
    .filter((operation): operation is Extract<FileOperation, { type: "create" | "replace" | "replaceRange" | "delete" }> =>
      operation.type === "create" || operation.type === "replace" || operation.type === "replaceRange" || operation.type === "delete")
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
  await persistCheckpoints();

  return checkpoint;
}

async function restoreLastCheckpoint(): Promise<void> {
  const checkpoint = checkpoints.at(-1);
  if (!checkpoint) {
    void vscode.window.showInformationMessage("복원할 체크포인트가 없습니다.");
    return;
  }

  await restoreCheckpoint(checkpoint);
}

async function restoreCheckpoint(checkpoint: Checkpoint): Promise<void> {
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

async function runApprovedCommand(
  operation: Extract<FileOperation, { type: "runCommand" }>,
  onOutput?: (chunk: string) => void
): Promise<string> {
  const commandLabel = formatCommandForDisplay(operation);
  const cwdUri = resolveCommandCwd(operation.cwd ?? ".");

  // Integrated terminal mode: hand off to a visible terminal (no output capture).
  if (vscode.workspace.getConfiguration("clarusCode").get<boolean>("runCommandsInTerminal", false)) {
    const terminal = vscode.window.terminals.find((item) => item.name === "NH-AX-CODE")
      ?? vscode.window.createTerminal({ name: "NH-AX-CODE", cwd: cwdUri.fsPath });
    terminal.show(true);
    terminal.sendText(commandLabel, true);
    void recordCommandHistory({ command: commandLabel, cwd: cwdUri.fsPath, exit: "terminal", at: new Date().toISOString(), durationMs: 0 });
    return `$ ${commandLabel}\n통합 터미널에서 실행했습니다 (출력은 터미널에서 확인).`;
  }

  const started = Date.now();
  const timeout = Math.min(Math.max(operation.timeoutMs ?? 120000, 1000), 600000);

  return new Promise<string>((resolve) => {
    const child = spawn(operation.command, operation.args ?? [], {
      cwd: cwdUri.fsPath,
      windowsHide: true,
      shell: process.platform === "win32"
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill();
      }
    }, timeout);

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      stdout += text;
      onOutput?.(text);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      stderr += text;
      onOutput?.(text);
    });

    const finish = (exit: string, extra?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      void recordCommandHistory({ command: commandLabel, cwd: cwdUri.fsPath, exit, at: new Date().toISOString(), durationMs });
      resolve([
        `$ ${commandLabel}`,
        `exit ${exit} in ${durationMs}ms`,
        extra ? `error:\n${extra}` : "",
        formatCommandOutput("stdout", stdout),
        formatCommandOutput("stderr", stderr)
      ].filter(Boolean).join("\n"));
    };

    child.on("error", (error) => finish("error", error.message));
    child.on("close", (code, signal) => finish(String(code ?? signal ?? "error")));
  });
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
