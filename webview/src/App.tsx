import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown, type PluginConfig } from "streamdown";
import { code } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";
import { mermaid } from "@streamdown/mermaid";
import { getVsCodeApi } from "./vscode";
import "streamdown/styles.css";
import "./styles.css";

// Streaming markdown pipeline: shiki code highlighting, CJK-aware incomplete-
// markdown repair (Korean streaming), mermaid diagrams.
const streamdownPlugins: PluginConfig = { code, cjk, mermaid };

type ChatRole = "user" | "assistant";
type PermissionMode = "workspace" | "plan-only";
type EndpointMode = "auto" | "chat-completions" | "completions" | "responses";

interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface WorkspaceEntry {
  path: string;
  type: "file" | "folder";
}

interface ModelFallback {
  failedModel: string;
  usedModel: string;
}

interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
  estimated?: boolean;
}

interface HostMessage {
  type:
    | "chatChunk"
    | "chatDone"
    | "chatError"
    | "chatUsage"
    | "modelList"
    | "modelListError"
    | "modelFallback"
    | "workspaceEntries"
    | "workspaceEntriesError"
    | "loopMetrics"
    | "toolEvent"
    | "sessionData"
    | "sessionCompacted"
    | "skillList";
  requestId: string;
  value?: string | string[] | WorkspaceEntry[] | ModelFallback | TokenUsage | LoopMetrics | ToolEvent | SessionData | null;
}

interface ToolEvent {
  label: string;
  status: string;
  detail?: string;
}

interface SessionData {
  messages: ChatMessage[];
  model?: string;
  permissionMode?: PermissionMode;
  planMode?: boolean;
}

function isToolEvent(value: unknown): value is ToolEvent {
  return typeof value === "object" && value !== null && "label" in value && "status" in value;
}

function isSessionData(value: unknown): value is SessionData {
  return typeof value === "object" && value !== null && "messages" in value && Array.isArray((value as SessionData).messages);
}

interface LoopMetrics {
  cBar: number;
  rhoHat: number;
  step: number;
  converged: boolean;
  reason: string;
}

function isLoopMetrics(value: unknown): value is LoopMetrics {
  return typeof value === "object" && value !== null && "cBar" in value && "step" in value;
}

const defaultModels = ["gpt-5.5", "5.5", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini"];

export function App() {
  const vscode = useMemo(() => getVsCodeApi(), []);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(defaultModels[0]);
  const [customModel, setCustomModel] = useState("");
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [modelOptions, setModelOptions] = useState(defaultModels);
  const [modelStatus, setModelStatus] = useState("");
  const [endpointMode, setEndpointMode] = useState<EndpointMode>("auto");
  const [streamResponses, setStreamResponses] = useState(true);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("workspace");
  const [planMode, setPlanMode] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [lastUsage, setLastUsage] = useState<TokenUsage | null>(null);
  const [loopMetrics, setLoopMetrics] = useState<LoopMetrics | null>(null);
  const [toolTimeline, setToolTimeline] = useState<ToolEvent[]>([]);
  const [statusNote, setStatusNote] = useState("");
  const [mentionOptions, setMentionOptions] = useState<WorkspaceEntry[]>([]);
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number } | null>(null);
  const [mentionRequestId, setMentionRequestId] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      if (!message) {
        return;
      }

      if (message.type === "modelList" && Array.isArray(message.value)) {
        const models = message.value.filter((item): item is string => typeof item === "string").filter(isChatModel);
        const nextModels = uniqueModels([...models, ...customModels, ...modelOptions, ...defaultModels]);
        setModelOptions(nextModels);
        if (!nextModels.includes(model) && nextModels[0]) {
          setModel(nextModels[0]);
        }
        setModelStatus(models.length ? `${models.length}개 로드됨` : "모델 없음");
        return;
      }

      if (message.type === "modelListError") {
        setModelStatus(typeof message.value === "string" ? message.value : "모델 목록 실패");
        return;
      }

      if (message.type === "workspaceEntries" && message.requestId === mentionRequestId && Array.isArray(message.value)) {
        setMentionOptions(message.value.filter(isWorkspaceEntry));
        return;
      }

      if (message.type === "workspaceEntriesError" && message.requestId === mentionRequestId) {
        setMentionOptions([]);
        return;
      }

      if (message.type === "modelFallback" && message.requestId === pendingRequestId && isModelFallback(message.value)) {
        const fallback = message.value;
        setModelOptions((current) => uniqueModels(current.filter((item) => item !== fallback.failedModel).concat(fallback.usedModel)));
        setModel(fallback.usedModel);
        setModelStatus(`${fallback.usedModel} 사용 중`);
        return;
      }

      if (message.type === "sessionData") {
        const session = isSessionData(message.value) ? message.value : null;
        if (session && session.messages.length) {
          setMessages(session.messages);
          if (session.model) {
            const restoredModel = session.model;
            setModel(restoredModel);
            setModelOptions((current) => uniqueModels([restoredModel, ...current]));
          }
          if (session.permissionMode) {
            setPermissionMode(session.permissionMode);
          }
          if (typeof session.planMode === "boolean") {
            setPlanMode(session.planMode);
          }
          setStatusNote("이전 세션을 복원했습니다");
        }
        return;
      }

      if (message.requestId !== pendingRequestId) {
        return;
      }

      if (message.type === "chatUsage" && isTokenUsage(message.value)) {
        setLastUsage(message.value);
        return;
      }

      if (message.type === "loopMetrics" && isLoopMetrics(message.value)) {
        setLoopMetrics(message.value);
        return;
      }

      if (message.type === "toolEvent" && isToolEvent(message.value)) {
        const event = message.value;
        setToolTimeline((current) => {
          // Collapse streaming "output" updates into the existing entry.
          if (event.status === "output") {
            return current;
          }
          const next = [...current.filter((item) => !(item.label === event.label && item.status === "running")), event];
          return next.slice(-30);
        });
        return;
      }

      if (message.type === "skillList") {
        const skills = Array.isArray(message.value) ? message.value as Array<{ name?: string; description?: string; path?: string }> : [];
        const text = skills.length
          ? `사용 가능한 스킬:\n${skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`).join("\n")}`
          : "스킬이 없습니다. .nhax/skills/*.md 파일을 추가하세요.";
        setMessages((current) =>
          current.map((item, index) =>
            index === current.length - 1 && item.role === "assistant" ? { ...item, content: text } : item,
          ),
        );
        setPendingRequestId(null);
        return;
      }

      if (message.type === "sessionCompacted" && typeof message.value === "string") {
        const compacted: ChatMessage[] = [{ role: "assistant", content: `이전 대화 요약:\n${message.value}` }];
        setMessages(compacted);
        setPendingRequestId(null);
        setStatusNote("대화를 압축했습니다");
        vscode.postMessage({ type: "saveSession", value: { messages: compacted } });
        return;
      }

      if (message.type === "chatChunk") {
        setMessages((current) =>
          current.map((item, index) =>
            index === current.length - 1 && item.role === "assistant"
              ? { ...item, content: item.content + (typeof message.value === "string" ? message.value : "") }
              : item,
          ),
        );
      }

      if (message.type === "chatDone") {
        setPendingRequestId(null);
        setMessages((current) => {
          vscode.postMessage({ type: "saveSession", value: { messages: current, model, permissionMode, planMode } });
          return current;
        });
      }

      if (message.type === "chatError") {
        setMessages((current) =>
          current.map((item, index) =>
            index === current.length - 1 && item.role === "assistant"
              ? { ...item, content: `오류: ${typeof message.value === "string" ? message.value : "요청 실패"}` }
              : item,
          ),
        );
        setPendingRequestId(null);
      }
    };

    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [customModels, mentionRequestId, model, modelOptions, pendingRequestId]);

  useEffect(() => {
    refreshModels();
    vscode.postMessage({ type: "loadSession", requestId: createRequestId() });
  }, []);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [messages]);

  function refreshModels() {
    const requestId = createRequestId();
    setModelStatus("불러오는 중");
    vscode.postMessage({ type: "listModels", requestId });
  }

  function addCustomModel() {
    const nextModel = customModel.trim();
    if (!nextModel) {
      return;
    }

    setCustomModels((current) => uniqueModels([nextModel, ...current]));
    setModelOptions((current) => uniqueModels([nextModel, ...current]));
    setModel(nextModel);
    setCustomModel("");
    setModelStatus("직접 추가됨");
  }

  function cancelRequest() {
    if (pendingRequestId) {
      vscode.postMessage({ type: "chatCancel", requestId: pendingRequestId });
      setStatusNote("취소 요청됨");
    }
  }

  /** Slash commands: /clear /compact /model /plan /permissions. Returns true when handled. */
  function handleSlashCommand(text: string): boolean {
    if (!text.startsWith("/")) {
      return false;
    }

    const [command, ...rest] = text.slice(1).split(/\s+/);
    const argument = rest.join(" ").trim();

    switch (command) {
      case "clear":
        setMessages([]);
        setToolTimeline([]);
        setLoopMetrics(null);
        vscode.postMessage({ type: "saveSession", value: { messages: [] } });
        setStatusNote("대화를 지웠습니다");
        return true;
      case "model":
        if (argument) {
          setModelOptions((current) => uniqueModels([argument, ...current]));
          setModel(argument);
          setStatusNote(`모델: ${argument}`);
        } else {
          setStatusNote(`현재 모델: ${model}`);
        }
        return true;
      case "plan": {
        const next = argument === "off" ? false : argument === "on" ? true : !planMode;
        setPlanMode(next);
        setStatusNote(`계획 모드 ${next ? "켜짐" : "꺼짐"}`);
        return true;
      }
      case "permissions": {
        if (argument === "workspace" || argument === "plan-only") {
          setPermissionMode(argument);
          setStatusNote(`권한 모드: ${argument}`);
        } else {
          setStatusNote(`권한 모드: ${permissionMode} (workspace | plan-only)`);
        }
        return true;
      }
      case "compact": {
        if (!messages.length) {
          setStatusNote("압축할 대화가 없습니다");
          return true;
        }
        const requestId = createRequestId();
        setPendingRequestId(requestId);
        setStatusNote("대화 압축 중…");
        vscode.postMessage({
          type: "compactSession",
          requestId,
          messages,
          settings: { permissionMode, planMode, model, endpointMode, streamResponses },
        });
        return true;
      }
      case "commit": {
        const requestId = createRequestId();
        setMessages((current) => [...current, { role: "user", content: "/commit" }, { role: "assistant", content: "" }]);
        setPendingRequestId(requestId);
        setStatusNote("AI 커밋 진행 중…");
        vscode.postMessage({ type: "gitCommit", requestId });
        return true;
      }
      case "skills": {
        const requestId = createRequestId();
        setPendingRequestId(requestId);
        setMessages((current) => [...current, { role: "user", content: "/skills" }, { role: "assistant", content: "" }]);
        vscode.postMessage({ type: "listSkills", requestId });
        return true;
      }
      default:
        setStatusNote(`알 수 없는 명령: /${command} (clear·compact·model·plan·permissions·commit·skills)`);
        return true;
    }
  }

  function send(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || pendingRequestId) {
      return;
    }

    if (handleSlashCommand(text)) {
      setInput("");
      return;
    }

    const selectedModel = isChatModel(model) ? model : modelOptions.find(isChatModel) ?? defaultModels[0];
    const requestId = createRequestId();
    const nextMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: text },
      { role: "assistant", content: "" },
    ];

    setInput("");
    setMentionRange(null);
    setMentionOptions([]);
    setLastUsage(null);
    setLoopMetrics(null);
    setToolTimeline([]);
    setStatusNote("");
    setMessages(nextMessages);
    setPendingRequestId(requestId);
    vscode.postMessage({
      type: "chatRequest",
      requestId,
      messages: nextMessages.filter((message) => message.role !== "assistant" || message.content.trim()),
      settings: {
        permissionMode,
        planMode,
        model: selectedModel,
        endpointMode,
        streamResponses,
      },
    });
  }

  function updateInput(value: string, cursorPosition: number) {
    setInput(value);
    const mention = findActiveMention(value, cursorPosition);

    if (!mention) {
      setMentionRange(null);
      setMentionOptions([]);
      return;
    }

    const requestId = createRequestId();
    setMentionRange({ start: mention.start, end: cursorPosition });
    setMentionRequestId(requestId);
    vscode.postMessage({ type: "listWorkspaceEntries", requestId, query: mention.query });
  }

  function insertMention(entry: WorkspaceEntry) {
    if (!mentionRange) {
      return;
    }

    const before = input.slice(0, mentionRange.start);
    const after = input.slice(mentionRange.end);
    const nextInput = `${before}@${entry.path} ${after}`;
    const cursor = before.length + entry.path.length + 2;

    setInput(nextInput);
    setMentionRange(null);
    setMentionOptions([]);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <strong>NH-AX-CODE</strong>
        <div className="topbar-actions">
          <span>{pendingRequestId ? "실행 중" : `${model} / ${endpointModeLabel(endpointMode)}`}</span>
          <span>{streamResponses ? "실시간" : "일괄"}</span>
          {lastUsage ? <span>{formatUsage(lastUsage)}</span> : null}
          {loopMetrics ? (
            <span title={loopMetrics.reason}>
              {`루프 ${loopMetrics.step + 1} · c̄ ${loopMetrics.cBar.toFixed(2)} · ${loopMetrics.converged ? "수렴" : loopMetrics.rhoHat < 1 ? "수축" : "발산"}`}
            </span>
          ) : null}
          {statusNote ? <span>{statusNote}</span> : null}
          {pendingRequestId ? (
            <button className="ghost-button" type="button" title="요청 중지" onClick={cancelRequest}>
              중지
            </button>
          ) : null}
          <button className="ghost-button" type="button" title="대화 지우기" onClick={() => handleSlashCommand("/clear")}>
            지우기
          </button>
        </div>
      </header>

      <section ref={messagesRef} className="messages" aria-live="polite">
        {messages.length === 0 ? (
          <div className="empty">
            <strong>무엇을 작업할까요?</strong>
            <span>@로 파일이나 폴더 범위를 지정한 뒤 요청하세요.</span>
          </div>
        ) : (
          messages.map((message, index) => {
            const isLast = index === messages.length - 1;
            const isStreamingNow = Boolean(pendingRequestId) && isLast && message.role === "assistant";
            return (
              <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
                <span>{message.role === "user" ? "나" : "NH-AX-CODE"}</span>
                {message.role === "assistant" ? (
                  message.content ? (
                    <Streamdown
                      className="markdown-body"
                      mode={isStreamingNow ? "streaming" : "static"}
                      isAnimating={isStreamingNow}
                      caret={isStreamingNow ? "block" : undefined}
                      plugins={streamdownPlugins}
                      controls={{ code: true, table: true }}
                    >
                      {message.content}
                    </Streamdown>
                  ) : isStreamingNow ? (
                    <div className="thinking" aria-label="생각 중">
                      <span className="thinking-dot" />
                      <span className="thinking-dot" />
                      <span className="thinking-dot" />
                      <em>생각 중…</em>
                    </div>
                  ) : null
                ) : (
                  <p>{message.content}</p>
                )}
              </article>
            );
          })
        )}
        {toolTimeline.length ? (
          <div className="tool-timeline">
            {toolTimeline.map((event, index) => (
              <div className={`tool-event ${event.status}`} key={`${event.label}-${index}`} title={event.detail ?? ""}>
                <span>{event.status === "running" ? "…" : event.status === "done" ? "✓" : event.status === "blocked" ? "⛔" : "✗"}</span>
                {event.label}
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <form className="composer-wrap" onSubmit={send}>
        {mentionRange && mentionOptions.length > 0 ? (
          <div className="mention-menu">
            {mentionOptions.map((entry) => (
              <button type="button" key={`${entry.type}-${entry.path}`} onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention(entry)}>
                <span>{entry.type === "folder" ? "폴더" : "파일"}</span>
                @{entry.path}
              </button>
            ))}
          </div>
        ) : null}

        <div className="composer">
          <textarea
            ref={textareaRef}
            value={input}
            placeholder="@경로 입력 후 작업 요청"
            spellCheck={false}
            onChange={(event) => updateInput(event.target.value, event.target.selectionStart)}
            onKeyUp={(event) => updateInput(event.currentTarget.value, event.currentTarget.selectionStart)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !(event.nativeEvent as KeyboardEvent).isComposing) {
                event.preventDefault();
                send();
              }
            }}
          />

          <div className="composer-toolbar">
            <div className="left-tools">
              <select value={model} onChange={(event) => setModel(event.target.value)} title={modelStatus || "모델"}>
                {modelOptions.map((option) => (
                  <option value={option} key={option}>{option}</option>
                ))}
              </select>
              <button type="button" onClick={refreshModels} title="모델 목록 새로고침">
                모델
              </button>
              <input
                className="custom-model"
                value={customModel}
                placeholder="모델 직접 입력"
                spellCheck={false}
                onChange={(event) => setCustomModel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addCustomModel();
                  }
                }}
              />
              <button type="button" onClick={addCustomModel}>
                추가
              </button>
              <select value={endpointMode} onChange={(event) => setEndpointMode(event.target.value as EndpointMode)}>
                <option value="auto">자동 엔드포인트</option>
                <option value="chat-completions">채팅</option>
                <option value="responses">응답</option>
                <option value="completions">완성</option>
              </select>
              <select value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}>
                <option value="workspace">워크스페이스 수정</option>
                <option value="plan-only">계획만</option>
              </select>
              <label className="toggle" title="파일 변경 없이 계획만 받습니다.">
                <input type="checkbox" checked={planMode} onChange={(event) => setPlanMode(event.target.checked)} />
                계획
              </label>
              <label className="toggle" title="지원되는 서버에서는 답변을 실시간으로 받습니다.">
                <input type="checkbox" checked={streamResponses} onChange={(event) => setStreamResponses(event.target.checked)} />
                실시간
              </label>
            </div>
            <button className="send-button" type="submit" disabled={Boolean(pendingRequestId) || !input.trim()}>
              전송
            </button>
          </div>
        </div>
      </form>
    </main>
  );
}

function endpointModeLabel(endpointMode: EndpointMode) {
  if (endpointMode === "chat-completions") {
    return "채팅";
  }
  if (endpointMode === "responses") {
    return "응답";
  }
  if (endpointMode === "completions") {
    return "완성";
  }
  return "자동";
}

function formatUsage(usage: TokenUsage) {
  const prefix = usage.estimated ? "토큰 약 " : "토큰 ";
  if (typeof usage.total === "number") {
    return `${prefix}${usage.total.toLocaleString()}`;
  }
  const parts = [
    typeof usage.input === "number" ? `입력 ${usage.input.toLocaleString()}` : "",
    typeof usage.output === "number" ? `출력 ${usage.output.toLocaleString()}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : "토큰 -";
}

function findActiveMention(value: string, cursorPosition: number) {
  const beforeCursor = value.slice(0, cursorPosition);
  const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/);

  if (!match) {
    return undefined;
  }

  const token = match[2];
  return {
    query: token,
    start: cursorPosition - token.length - 1
  };
}

function isWorkspaceEntry(value: unknown): value is WorkspaceEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as WorkspaceEntry;
  return typeof entry.path === "string" && (entry.type === "file" || entry.type === "folder");
}

function isModelFallback(value: unknown): value is ModelFallback {
  if (!value || typeof value !== "object") {
    return false;
  }

  const fallback = value as ModelFallback;
  return typeof fallback.failedModel === "string" && typeof fallback.usedModel === "string";
}

function isTokenUsage(value: unknown): value is TokenUsage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const usage = value as TokenUsage;
  return typeof usage.input === "number" || typeof usage.output === "number" || typeof usage.total === "number";
}

function isChatModel(model: string) {
  const id = model.toLowerCase();
  const blocked = ["embedding", "whisper", "tts", "dall-e", "moderation", "babbage", "davinci", "curie", "ada", "instruct", "transcribe", "realtime", "image", "audio", "rerank", "clip"];
  return Boolean(model.trim()) && !blocked.some((token) => id.includes(token));
}

function uniqueModels(models: string[]) {
  return [...new Set(models.map((model) => model.trim()).filter(isChatModel))];
}

function createRequestId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
