import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { getVsCodeApi } from "./vscode";
import "./styles.css";

type ChatRole = "user" | "assistant";

interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface WorkspaceEntry {
  path: string;
  type: "file" | "folder";
}

interface HostMessage {
  type: "chatChunk" | "chatDone" | "chatError" | "modelList" | "modelListError" | "workspaceEntries" | "workspaceEntriesError";
  requestId: string;
  value?: string | string[] | WorkspaceEntry[];
}

const defaultModels = ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini"];

export function App() {
  const vscode = useMemo(() => getVsCodeApi(), []);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("gpt-4.1");
  const [modelOptions, setModelOptions] = useState(defaultModels);
  const [modelStatus, setModelStatus] = useState("");
  const [permissionMode, setPermissionMode] = useState<"scoped" | "workspace" | "full">("scoped");
  const [planMode, setPlanMode] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
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
        const models = message.value
          .filter((item): item is string => typeof item === "string")
          .filter(isChatModel);
        const nextModels = [...new Set([...models, ...defaultModels.filter(isChatModel)])];
        setModelOptions(nextModels);
        if (nextModels[0] && !nextModels.includes(model)) {
          setModel(nextModels[0]);
        } else if (models[0] && model === defaultModels[0]) {
          setModel(models[0]);
        }
        setModelStatus(models.length ? `${models.length}개` : "모델 없음");
        return;
      }

      if (message.type === "modelListError") {
        setModelStatus(typeof message.value === "string" ? message.value : "목록 실패");
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

      if (message.requestId !== pendingRequestId) {
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
  }, [mentionRequestId, model, pendingRequestId]);

  useEffect(() => {
    refreshModels();
  }, []);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [messages]);

  function refreshModels() {
    const requestId = createRequestId();
    setModelStatus("불러오는 중...");
    vscode.postMessage({ type: "listModels", requestId });
  }

  function send(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text) {
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
        <div>
          <strong>NH-AX-CODE</strong>
        </div>
        <button className="icon-button" type="button" title="대화 지우기" onClick={() => setMessages([])}>
          x
        </button>
      </header>

      <section ref={messagesRef} className="messages" aria-live="polite">
        {messages.length === 0 ? (
          <div className="empty">
            코드 분석, 생성, 수정, 삭제를 요청하세요. @로 파일이나 폴더 범위를 지정할 수 있습니다.
          </div>
        ) : (
          messages.map((message, index) => (
            <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
              <span>{message.role === "user" ? "나" : "응답"}</span>
              <p>{message.content}</p>
            </article>
          ))
        )}
      </section>

      <form className="composer" onSubmit={send}>
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
        <textarea
          ref={textareaRef}
          value={input}
          placeholder="@로 범위를 지정하고 요청하세요"
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
        <div className="bottom-bar">
          <div className="bottom-controls">
            <select className="model-select" value={model} onChange={(event) => setModel(event.target.value)} title={modelStatus || "모델"}>
              {modelOptions.map((option) => (
                <option value={option} key={option}>{option}</option>
              ))}
            </select>
            <button type="button" onClick={refreshModels} title="모델 목록 새로고침">
              새로고침
            </button>
            <select value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as typeof permissionMode)}>
              <option value="scoped">@범위</option>
              <option value="workspace">워크스페이스</option>
              <option value="full">전체</option>
            </select>
            <label className="toggle">
              <input type="checkbox" checked={planMode} onChange={(event) => setPlanMode(event.target.checked)} />
              계획
            </label>
          </div>
          <button className="send-button" type="submit" disabled={Boolean(pendingRequestId)}>
            전송
          </button>
        </div>
      </form>
    </main>
  );
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

function isChatModel(model: string) {
  const id = model.toLowerCase();
  const blocked = ["embedding", "whisper", "tts", "dall-e", "moderation", "babbage", "davinci", "curie", "ada", "instruct", "transcribe", "realtime", "image", "audio", "rerank", "clip"];
  return !blocked.some((token) => id.includes(token));
}

function createRequestId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
