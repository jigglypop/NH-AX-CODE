import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import DatePicker, { registerLocale } from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import { ko } from 'date-fns/locale/ko';
import { useAtom } from 'jotai';
import type { UtilityTool } from '../../components/ChatHeader/types';
import { MessageList } from '../../components/MessageList';
import { ChatInput } from '../../components/ChatInput';
import SettingsModal from '../SettingsModal';
import { useAIChat } from '../../hooks/useAIChat';
import { useSettings } from '../../hooks/useSettings';
import { APP_NAME, APP_VERSION, type ModelUseCase } from '../../config/app';
import { inputAtom, messagesAtom } from '../../atoms/chatAtoms';
import { createWelcomeMessage } from '../../atoms/messageAtoms';
import type { ImageAttachment } from '../../types/message';
import { parseReferenceDocument } from '../../services/documentParser';
import {
  filterMessages,
  createEmptyMessageDateTimeRange,
  formatMessageDateTimeRangeLabel,
  getHistoryMessages,
  type MessageFilter,
  type MessageDateTimeRange,
} from './messageFilters';
import {
  ENABLE_REFERENCE_LINK_MOCK,
  REFERENCE_LINK_MOCK_MESSAGE_ID,
  REFERENCE_LINK_MOCK_MESSAGES,
  REFERENCE_LINK_MOCK_SOURCES,
  type ReferenceLinkMockSource,
} from './constant';

type PanelView = 'chat' | 'settings';

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_REFERENCE_DOCUMENT_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCE_CONTEXT_CHARS = 30000;
const REFERENCE_VIEWER_PREVIEW_CHARS = 12000;
const REFERENCE_DOCUMENT_ACCEPT = '.pdf,.xlsx,.csv,.txt';
const REFERENCE_DOCUMENT_EXTENSIONS = new Set(['pdf', 'xlsx', 'csv', 'txt']);
const DATE_TIME_FILTER_START_LABEL = '시작 일시';
const DATE_TIME_FILTER_END_LABEL = '종료 일시';
const DATE_TIME_FILTER_CLEAR_LABEL = '일시 필터 초기화';
const HISTORY_SUMMARY_PROMPT = '지금까지의 대화 히스토리를 핵심 결정사항, 미해결 질문, 다음 작업으로 정리해줘.';

registerLocale('ko', ko);

type PageContextResponse = {
  context?: string;
};

type ReferenceDocumentStatus = 'parsing' | 'ready' | 'error';

type ReferenceDocument = {
  id: string;
  name: string;
  type: string;
  size: number;
  status: ReferenceDocumentStatus;
  sourceUrl?: string;
  text?: string;
  detail?: string;
  truncated?: boolean;
  error?: string;
};

async function requestActivePageContext() {
  return undefined as PageContextResponse['context'];
}

function hasDraggedFiles(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes('Files');
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))}KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

function isSupportedReferenceDocument(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase();

  return Boolean(extension && REFERENCE_DOCUMENT_EXTENSIONS.has(extension));
}

function createReferenceDocument(file: File): ReferenceDocument {
  const documentId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${file.name}`;

  return {
    id: documentId,
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    status: 'parsing',
    sourceUrl:
      typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(file) : undefined,
  };
}

function getReferenceTextSize(text: string) {
  if (typeof Blob !== 'undefined') {
    return new Blob([text]).size;
  }

  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length;
  }

  return text.length;
}

function createReferenceTextUrl(text: string) {
  if (typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    return undefined;
  }

  return URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
}

function createReferenceLinkMockDocument(
  source: ReferenceLinkMockSource,
  index: number,
): ReferenceDocument {
  return {
    id: `reference-link-mock-${index + 1}`,
    name: source.name,
    type: 'text/plain',
    size: getReferenceTextSize(source.text),
    status: 'ready',
    sourceUrl: createReferenceTextUrl(source.text),
    text: source.text,
    detail: 'TXT',
  };
}

function createInitialReferenceDocuments() {
  if (!ENABLE_REFERENCE_LINK_MOCK) {
    return [];
  }

  return REFERENCE_LINK_MOCK_SOURCES.map(createReferenceLinkMockDocument);
}

function createResetMessages() {
  if (!ENABLE_REFERENCE_LINK_MOCK) {
    return [createWelcomeMessage()];
  }

  return [createWelcomeMessage(), ...REFERENCE_LINK_MOCK_MESSAGES];
}

function revokeReferenceDocumentUrl(referenceDocument: ReferenceDocument) {
  if (referenceDocument.sourceUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
    URL.revokeObjectURL(referenceDocument.sourceUrl);
  }
}

function getReadyReferenceDocuments(referenceDocuments: ReferenceDocument[]) {
  return referenceDocuments.filter(
    (referenceDocument) => referenceDocument.status === 'ready' && referenceDocument.text?.trim(),
  );
}

function getReferenceStatusLabel(referenceDocument: ReferenceDocument) {
  if (referenceDocument.status === 'parsing') {
    return '분석 중';
  }

  if (referenceDocument.status === 'error') {
    /* v8 ignore next */
    return referenceDocument.error || '분석 실패';
  }

  /* v8 ignore next */
  return `${referenceDocument.detail || '분석 완료'}${referenceDocument.truncated ? ' · 일부만' : ''}`;
}

function buildReferenceContext(referenceDocuments: ReferenceDocument[]) {
  const readyDocuments = getReadyReferenceDocuments(referenceDocuments);

  if (!readyDocuments.length) {
    return undefined;
  }

  const blocks: string[] = [];
  let usedLength = 0;

  for (const [index, referenceDocument] of readyDocuments.entries()) {
    const block = [
      `[참조 문서 ${index + 1}: ${referenceDocument.name}]`,
      /* v8 ignore next */
      `형식: ${referenceDocument.detail || '문서'}`,
      referenceDocument.text,
    ].join('\n');
    const remainingLength = MAX_REFERENCE_CONTEXT_CHARS - usedLength;

    if (remainingLength <= 0) {
      break;
    }

    if (block.length > remainingLength) {
      blocks.push(`${block.slice(0, remainingLength)}\n\n[전체 참조 문서 내용 중 일부만 포함했습니다.]`);
      break;
    }

    blocks.push(block);
    usedLength += block.length;
  }

  return `첨부 참조 문서 내용입니다. 답변할 때 아래 내용을 우선 참고하세요.\n\n${blocks.join('\n\n')}`;
}

function createImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const attachmentId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${file.name}`;

    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('이미지를 읽을 수 없습니다.'));
        return;
      }

      resolve({
        id: attachmentId,
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl: reader.result,
      });
    };

    reader.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.'));
    reader.readAsDataURL(file);
  });
}

export const __testing = {
  requestActivePageContext,
  hasDraggedFiles,
  formatFileSize,
  isSupportedReferenceDocument,
  createReferenceDocument,
  getReferenceTextSize,
  createReferenceTextUrl,
  createReferenceLinkMockDocument,
  createInitialReferenceDocuments,
  createResetMessages,
  revokeReferenceDocumentUrl,
  getReadyReferenceDocuments,
  getReferenceStatusLabel,
  buildReferenceContext,
  createImageAttachment,
};

const ChatApp = () => {
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const referenceDocumentsRef = useRef<ReferenceDocument[]>([]);
  const [activeView, setActiveView] = useState<PanelView>('chat');
  const [activeTool, setActiveTool] = useState<UtilityTool | null>(null);
  const [messageFilter, setMessageFilter] = useState<MessageFilter>('all');
  const [messageDateTimeRange, setMessageDateTimeRange] = useState<MessageDateTimeRange>(
    createEmptyMessageDateTimeRange,
  );
  const [referenceDocuments, setReferenceDocuments] =
    useState<ReferenceDocument[]>(createInitialReferenceDocuments);
  const [referenceError, setReferenceError] = useState('');
  const [activeReferenceNumber, setActiveReferenceNumber] = useState<number | null>(null);
  const [lastReferenceNumber, setLastReferenceNumber] = useState<number | null>(null);
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [messages, setMessages] = useAtom(messagesAtom);
  const [input, setInput] = useAtom(inputAtom);
  const { settings, saveSettings } = useSettings();
  const { sendMessage, isLoading, isConnected } = useAIChat();

  useEffect(() => {
    referenceDocumentsRef.current = referenceDocuments;
  }, [referenceDocuments]);

  useEffect(
    () => () => {
      referenceDocumentsRef.current.forEach(revokeReferenceDocumentUrl);
    },
    [],
  );

  useEffect(() => {
    if (!ENABLE_REFERENCE_LINK_MOCK) {
      return;
    }

    setMessages((currentMessages) => {
      const hasMockMessage = currentMessages.some(
        (message) => message.id === REFERENCE_LINK_MOCK_MESSAGE_ID,
      );

      if (hasMockMessage || currentMessages.length !== 1 || currentMessages[0]?.id !== 'welcome') {
        return currentMessages;
      }

      return [...currentMessages, ...REFERENCE_LINK_MOCK_MESSAGES];
    });
  }, [setMessages]);

  const displayMessages = useMemo(
    () => filterMessages(messages, messageFilter, messageDateTimeRange),
    [messageDateTimeRange, messageFilter, messages],
  );

  const historyMessages = getHistoryMessages(messages);
  const userMessageCount = historyMessages.filter((message) => message.role === 'user').length;
  const assistantMessageCount = historyMessages.filter((message) => message.role === 'assistant').length;
  const selectedDateTimeRangeLabel = formatMessageDateTimeRangeLabel(messageDateTimeRange);
  const latestMessage = historyMessages.at(-1);
  const readyReferenceDocuments = useMemo(
    () => getReadyReferenceDocuments(referenceDocuments),
    [referenceDocuments],
  );
  const referenceLinks = useMemo(
    () =>
      Object.fromEntries(
        readyReferenceDocuments.map((referenceDocument, index) =>
          [index + 1, { url: referenceDocument.sourceUrl, title: referenceDocument.name }],
        ),
      ) as Record<number, { url?: string; title: string }>,
    [readyReferenceDocuments],
  );
  const hasParsingReferenceDocuments = referenceDocuments.some(
    (referenceDocument) => referenceDocument.status === 'parsing',
  );
  const readyReferenceDocumentCount = readyReferenceDocuments.length;
  const canSendMessage = Boolean(input.trim() || imageAttachments.length || readyReferenceDocumentCount);

  useEffect(() => {
    /* v8 ignore next 4 */
    if (activeReferenceNumber && !readyReferenceDocuments[activeReferenceNumber - 1]) {
      setActiveReferenceNumber(null);
      setLastReferenceNumber(null);
    }
  }, [activeReferenceNumber, readyReferenceDocuments]);

  useEffect(() => {
    if (activeReferenceNumber && readyReferenceDocuments[activeReferenceNumber - 1]) {
      setLastReferenceNumber(activeReferenceNumber);
    }
  }, [activeReferenceNumber, readyReferenceDocuments]);

  const getPageContext = useCallback(async () => {
    if (!settings.sharePageContext) {
      return undefined;
    }

    return requestActivePageContext();
  }, [settings.sharePageContext]);

  const addImageFiles = useCallback(async (files: FileList | File[] | null) => {
    /* v8 ignore next */
    const incomingFiles = Array.from(files || []);

    if (!incomingFiles.length) {
      return;
    }

    const rejected: string[] = [];
    const validImages = incomingFiles.filter((file) => {
      if (!file.type.startsWith('image/')) {
        rejected.push(`${file.name}은 이미지 파일이 아닙니다.`);
        return false;
      }

      if (file.size > MAX_IMAGE_SIZE_BYTES) {
        rejected.push(`${file.name}은 5MB 이하만 참조할 수 있습니다.`);
        return false;
      }

      return true;
    });

    if (!validImages.length) {
      /* v8 ignore next */
      setAttachmentError(rejected[0] || '이미지 파일은 5MB 이하만 참조할 수 있습니다.');
      return;
    }

    try {
      const attachments = await Promise.all(validImages.map(createImageAttachment));
      setImageAttachments((prev) => [...prev, ...attachments]);
      setAttachmentError(rejected[0] || '');
    } catch (error) {
      /* v8 ignore next */
      setAttachmentError(error instanceof Error ? error.message : '이미지를 읽을 수 없습니다.');
    }
  }, []);

  const addReferenceFiles = useCallback((files: FileList | File[] | null) => {
    /* v8 ignore next */
    const incomingFiles = Array.from(files || []);

    if (!incomingFiles.length) {
      return;
    }

    const rejected: string[] = [];
    const validDocuments = incomingFiles.filter((file) => {
      if (!isSupportedReferenceDocument(file)) {
        rejected.push(`${file.name}은 PDF, XLSX, CSV, TXT 형식만 참조할 수 있습니다.`);
        return false;
      }

      if (file.size > MAX_REFERENCE_DOCUMENT_SIZE_BYTES) {
        rejected.push(`${file.name}은 20MB 이하만 참조할 수 있습니다.`);
        return false;
      }

      return true;
    });

    if (!validDocuments.length) {
      /* v8 ignore next */
      setReferenceError(rejected[0] || '참조 문서는 20MB 이하만 추가할 수 있습니다.');
      return;
    }

    const pendingDocuments = validDocuments.map(createReferenceDocument);

    setReferenceDocuments((prev) => [...prev, ...pendingDocuments]);
    setReferenceError(rejected[0] || '');

    pendingDocuments.forEach((document, index) => {
      const file = validDocuments[index];

      void parseReferenceDocument(file)
        .then((parsedDocument) => {
          if (!parsedDocument.text.trim()) {
            throw new Error('문서에서 추출할 텍스트가 없습니다.');
          }

          setReferenceDocuments((prev) =>
            prev.map((item) =>
              item.id === document.id
                ? {
                    ...item,
                    status: 'ready',
                    text: parsedDocument.text,
                    detail: parsedDocument.detail,
                    truncated: parsedDocument.truncated,
                    error: undefined,
                  }
                : item,
            ),
          );
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : '문서를 분석할 수 없습니다.';

          setReferenceDocuments((prev) =>
            prev.map((item) =>
              item.id === document.id
                ? {
                    ...item,
                    status: 'error',
                    error: message,
                  }
                : item,
            ),
          );
          setReferenceError(`${file.name}: ${message}`);
        });
    });
  }, []);

  const handleReferenceFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    addReferenceFiles(event.target.files);
    event.target.value = '';
  };

  const sendChatText = useCallback(
    async (text: string) => {
      const trimmedText = text.trim();
      const referenceContext = buildReferenceContext(referenceDocuments);

      /* v8 ignore next 3 */
      if ((!trimmedText && !imageAttachments.length && !referenceContext) || isLoading) {
        return;
      }

      /* v8 ignore next 4 */
      if (hasParsingReferenceDocuments) {
        setReferenceError('참조 문서 분석이 끝난 뒤 전송할 수 있습니다.');
        return;
      }

      setActiveView('chat');
      const pageContext = await getPageContext();
      const combinedContext = [referenceContext, pageContext].filter(Boolean).join('\n\n') || undefined;

      sendMessage(trimmedText || '첨부한 참조 문서를 분석해줘.', imageAttachments, combinedContext);
      setInput('');
      setImageAttachments([]);
      setAttachmentError('');
    },
    [
      getPageContext,
      hasParsingReferenceDocuments,
      imageAttachments,
      isLoading,
      referenceDocuments,
      sendMessage,
      setInput,
    ],
  );

  const handleSend = () => {
    void sendChatText(input);
  };

  const handleSessionReset = () => {
    setMessages(createResetMessages());
    setInput('');
    setImageAttachments([]);
    setAttachmentError('');
    referenceDocuments.forEach(revokeReferenceDocumentUrl);
    setReferenceDocuments(createInitialReferenceDocuments());
    setReferenceError('');
    setActiveReferenceNumber(null);
    setLastReferenceNumber(null);
    setMessageFilter('all');
    setMessageDateTimeRange(createEmptyMessageDateTimeRange());
    setActiveTool(null);
    setActiveView('chat');
  };

  const handleToolClick = (tool: UtilityTool) => {
    setActiveView('chat');
    setActiveTool((currentTool) => {
      /* v8 ignore next */
      const nextTool = currentTool === tool ? null : tool;

      if (nextTool === 'references') {
        window.setTimeout(() => referenceInputRef.current?.click(), 0);
      }

      return nextTool;
    });
  };

  const handleHistorySummary = () => {
    void sendChatText(HISTORY_SUMMARY_PROMPT);
    setActiveTool(null);
  };

  const openMcpSettings = () => {
    setActiveTool('mcp');
    setActiveView('settings');
  };

  const handleSettingsClick = () => {
    setActiveTool(null);
    setActiveView((currentView) => (currentView === 'settings' ? 'chat' : 'settings'));
  };

  const handleModelChange = useCallback(
    (modelName: string, modelUseCase: ModelUseCase = '') => {
      setActiveTool(null);
      setActiveView('chat');
      void saveSettings({ modelName, modelUseCase });
    },
    [saveSettings],
  );

  const handleReferenceLinkClick = useCallback((referenceNumber: number) => {
    setActiveView('chat');
    setActiveTool(null);
    setActiveReferenceNumber((currentNumber) =>
      /* v8 ignore next */
      currentNumber === referenceNumber ? null : referenceNumber,
    );
  }, []);

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsDraggingImage(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsDraggingImage(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    setIsDraggingImage(false);
    setActiveView('chat');
    void addImageFiles(event.dataTransfer.files);
  };

  const renderReferenceViewer = () => {
    const viewerReferenceNumber = activeReferenceNumber ?? lastReferenceNumber;
    const viewerReferenceDocument = viewerReferenceNumber
      ? readyReferenceDocuments[viewerReferenceNumber - 1]
      : undefined;
    const isReferenceViewerOpen = Boolean(activeReferenceNumber && viewerReferenceDocument);

    if (!viewerReferenceNumber || !viewerReferenceDocument) {
      return null;
    }

    /* v8 ignore next */
    const fullPreviewText = viewerReferenceDocument.text?.trim() || '';
    const previewText =
      fullPreviewText.length > REFERENCE_VIEWER_PREVIEW_CHARS
        ? `${fullPreviewText.slice(0, REFERENCE_VIEWER_PREVIEW_CHARS)}\n\n...`
        : fullPreviewText;

    return (
      <aside
        className={`absolute bottom-0 right-0 top-0 z-10 flex w-[min(340px,88%)] flex-col border-l border-[#cfd4da] bg-[#f8f9fa] transition-[opacity,transform] duration-200 ease-out ${
          isReferenceViewerOpen ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-full opacity-0'
        }`}
        aria-label="참고 문서 뷰어"
        aria-hidden={!isReferenceViewerOpen}
      >
        <div key={`viewer-header-${viewerReferenceNumber}`} className="flex h-12 shrink-0 animate-panel-content items-center gap-2 border-b border-[#dfe3e7] px-3">
          <span className="shrink-0 rounded border border-[#d7dbe0] bg-white px-1.5 py-0.5 text-[10px] font-bold text-[#5f6368]">
            참고 {viewerReferenceNumber}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-[12px] font-bold text-[#202124]"
            title={viewerReferenceDocument.name}
          >
            {viewerReferenceDocument.name}
          </span>
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#d7dbe0] bg-white text-[13px] font-bold text-[#5f6368] transition hover:bg-[#eef0f2] hover:text-[#202124]"
            aria-label="참고 문서 뷰어 닫기"
            onClick={() => setActiveReferenceNumber(null)}
          >
            ×
          </button>
        </div>
        <div key={`viewer-meta-${viewerReferenceNumber}`} className="flex shrink-0 animate-panel-content flex-wrap items-center gap-1.5 border-b border-[#e3e6ea] bg-white px-3 py-2">
          <span className="rounded border border-[#d7dbe0] bg-[#f8f9fa] px-1.5 py-0.5 text-[10px] font-bold text-[#5f6368]">
            {/* v8 ignore next */}
            {viewerReferenceDocument.name.split('.').pop()?.toUpperCase() || 'DOC'}
          </span>
          <span className="rounded border border-[#d7dbe0] bg-[#f8f9fa] px-1.5 py-0.5 text-[10px] font-semibold text-[#5f6368]">
            {formatFileSize(viewerReferenceDocument.size)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[#6b7280]">
            {getReferenceStatusLabel(viewerReferenceDocument)}
          </span>
        </div>
        <div key={`viewer-body-${viewerReferenceNumber}`} className="nh-scrollbar min-h-0 flex-1 animate-panel-content overflow-auto bg-white p-3">
          {/* v8 ignore next 9 */}
          {previewText ? (
            <pre className="m-0 whitespace-pre-wrap break-words font-sans text-[12px] leading-5 text-[#2f3337]">
              {previewText}
            </pre>
          ) : (
            <p className="m-0 rounded-md border border-[#d7dbe0] bg-[#f8f9fa] px-3 py-2 text-[12px] font-semibold text-[#5f6368]">
              미리보기 텍스트가 없습니다.
            </p>
          )}
        </div>
      </aside>
    );
  };

  const renderUtilityPanel = () => {
    const panelClass =
      'border-y border-[#e0e3e7] bg-[#fbfcfe] p-3';
    const titleClass = 'text-[13px] font-semibold text-[#202124]';
    const pillButtonClass =
      'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full border px-3 text-[13px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-45';
    const neutralPillClass = 'border-[#dadce0] bg-white text-[#3c4043] hover:border-[#c8d7ef] hover:bg-[#f8fbff]';
    const activePillClass = 'border-[#c9daf8] bg-[#eaf2ff] text-[#1a5fd2]';

    switch (activeTool) {
      case 'filter': {
        const filters: Array<{ value: MessageFilter; label: string; count: number }> = [
          { value: 'all', label: '전체', count: messages.length },
          { value: 'user', label: '질문', count: userMessageCount },
          { value: 'assistant', label: '응답', count: assistantMessageCount },
        ];

        return (
          <div className={panelClass} aria-label="대화 필터">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className={titleClass}>대화 필터</span>
              <span className="rounded-full bg-[#f1f3f4] px-2 py-1 text-[11px] font-semibold text-[#5f6368]">
                {historyMessages.length}개 메시지
              </span>
            </div>
            <div className="nh-scrollbar flex gap-2 overflow-x-auto pb-1">
              {filters.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  className={`${pillButtonClass} ${
                    messageFilter === filter.value ? activePillClass : neutralPillClass
                  }`}
                  aria-pressed={messageFilter === filter.value}
                  onClick={() => setMessageFilter(filter.value)}
                >
                  <span>{filter.label}</span>
                  <span className="rounded-full bg-white/80 px-1.5 py-0.5 text-[11px]">{filter.count}</span>
                </button>
              ))}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-[#5f6368]">
                <span>{DATE_TIME_FILTER_START_LABEL}</span>
                <DatePicker
                  selected={messageDateTimeRange.start}
                  onChange={(date) =>
                    setMessageDateTimeRange((currentRange) => ({
                      ...currentRange,
                      start: date,
                    }))
                  }
                  selectsStart
                  startDate={messageDateTimeRange.start}
                  endDate={messageDateTimeRange.end}
                  locale="ko"
                  showTimeSelect
                  timeIntervals={60}
                  timeCaption="시간"
                  todayButton="오늘"
                  dateFormat="yyyy.MM.dd HH:mm"
                  placeholderText="시작 일시 선택"
                  className="nh-date-time-input h-9 w-full rounded-md border border-[#dadce0] bg-white px-2 text-[13px] font-semibold text-[#3c4043] outline-none transition focus:border-[#8ab4f8] focus:ring-2 focus:ring-[#d2e3fc]"
                  wrapperClassName="nh-date-time-picker"
                  popperClassName="nh-date-time-popper"
                  calendarClassName="nh-date-time-calendar"
                  aria-label={DATE_TIME_FILTER_START_LABEL}
                />
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-[#5f6368]">
                <span>{DATE_TIME_FILTER_END_LABEL}</span>
                <DatePicker
                  selected={messageDateTimeRange.end}
                  onChange={(date) =>
                    setMessageDateTimeRange((currentRange) => ({
                      ...currentRange,
                      end: date,
                    }))
                  }
                  selectsEnd
                  startDate={messageDateTimeRange.start}
                  endDate={messageDateTimeRange.end}
                  minDate={messageDateTimeRange.start || undefined}
                  locale="ko"
                  showTimeSelect
                  timeIntervals={60}
                  timeCaption="시간"
                  todayButton="오늘"
                  dateFormat="yyyy.MM.dd HH:mm"
                  placeholderText="종료 일시 선택"
                  className="nh-date-time-input h-9 w-full rounded-md border border-[#dadce0] bg-white px-2 text-[13px] font-semibold text-[#3c4043] outline-none transition focus:border-[#8ab4f8] focus:ring-2 focus:ring-[#d2e3fc]"
                  wrapperClassName="nh-date-time-picker"
                  popperClassName="nh-date-time-popper"
                  calendarClassName="nh-date-time-calendar"
                  aria-label={DATE_TIME_FILTER_END_LABEL}
                />
              </label>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-[#f1f3f4] px-2 py-1 text-[11px] font-semibold text-[#5f6368]">
                {selectedDateTimeRangeLabel}
              </span>
              {messageDateTimeRange.start || messageDateTimeRange.end ? (
                <button
                  type="button"
                  className={`${pillButtonClass} ${neutralPillClass}`}
                  onClick={() => setMessageDateTimeRange(createEmptyMessageDateTimeRange())}
                >
                  {DATE_TIME_FILTER_CLEAR_LABEL}
                </button>
              ) : null}
            </div>
          </div>
        );
      }
      case 'references':
        return (
          <div className={panelClass} aria-label="참조 문서">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className={titleClass}>참조 문서</span>
              <span className="rounded-full bg-[#f1f3f4] px-2 py-1 text-[11px] font-semibold text-[#5f6368]">
                {referenceDocuments.length}개 선택
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={`${pillButtonClass} border-[#c9daf8] bg-[#eaf2ff] text-[#1a5fd2]`}
                onClick={() => referenceInputRef.current?.click()}
              >
                문서 추가
              </button>
              <span className="truncate text-[11px] font-medium text-[#5f6368]">PDF, XLSX, CSV/TXT 로컬 분석</span>
            </div>
            {referenceError ? (
              <p className="mt-2 text-[11px] font-semibold text-[#d84f3f]" role="alert">
                {referenceError}
              </p>
            ) : null}
            {referenceDocuments.length ? (
              <div className="nh-scrollbar mt-3 flex gap-2 overflow-x-auto pb-1">
                {referenceDocuments.map((referenceDocument) => (
                  <div
                    key={referenceDocument.id}
                    className="inline-flex h-11 min-w-[190px] max-w-[270px] items-center gap-2 rounded-full border border-[#dadce0] bg-white px-3 text-[#3c4043]"
                  >
                    <span className="rounded bg-[#f1f3f4] px-1.5 py-0.5 text-[10px] font-bold text-[#5f6368]">
                      {/* v8 ignore next */}
                      {referenceDocument.name.split('.').pop()?.toUpperCase() || 'DOC'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-semibold">{referenceDocument.name}</span>
                      <span
                        className={`block truncate text-[10px] font-semibold ${
                          referenceDocument.status === 'error'
                            ? 'text-[#d84f3f]'
                            : referenceDocument.status === 'parsing'
                              ? 'text-[#b26a00]'
                              : 'text-[#188038]'
                        }`}
                      >
                        {getReferenceStatusLabel(referenceDocument)}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] text-[#5f6368]">
                      {formatFileSize(referenceDocument.size)}
                    </span>
                    <button
                      type="button"
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[#5f6368] hover:bg-[#f1f3f4] hover:text-[#202124]"
                      aria-label={`${referenceDocument.name} 제거`}
                      onClick={() => {
                        revokeReferenceDocumentUrl(referenceDocument);
                        setActiveReferenceNumber(null);
                        setLastReferenceNumber(null);
                        setReferenceDocuments((prev) =>
                          prev.filter((item) => item.id !== referenceDocument.id),
                        );
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <span className="mt-3 inline-flex h-8 items-center rounded-full bg-[#f1f3f4] px-3 text-[12px] font-medium text-[#5f6368]">
                선택된 문서 없음
              </span>
            )}
          </div>
        );
      case 'history':
        return (
          <div className={panelClass} aria-label="대화 히스토리">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className={titleClass}>대화 히스토리</span>
              <button
                type="button"
                className={`${pillButtonClass} border-[#c9daf8] bg-[#eaf2ff] text-[#1a5fd2]`}
                onClick={handleHistorySummary}
                disabled={isLoading || !historyMessages.length}
              >
                대화 요약
              </button>
            </div>
            <div className="nh-scrollbar flex gap-2 overflow-x-auto pb-1">
              <div className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-[#dadce0] bg-white px-3">
                <span className="text-[12px] font-medium text-[#5f6368]">질문</span>
                <strong className="text-[13px] text-[#202124]">{userMessageCount}</strong>
              </div>
              <div className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-[#dadce0] bg-white px-3">
                <span className="text-[12px] font-medium text-[#5f6368]">응답</span>
                <strong className="text-[13px] text-[#202124]">{assistantMessageCount}</strong>
              </div>
              <div className="inline-flex h-9 min-w-0 shrink-0 items-center gap-2 rounded-full border border-[#dadce0] bg-white px-3">
                <span className="text-[12px] font-medium text-[#5f6368]">최근</span>
                <strong className="max-w-[96px] truncate text-[12px] text-[#202124]">
                  {latestMessage
                    ? latestMessage.timestamp.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
                    : '-'}
                </strong>
              </div>
            </div>
          </div>
        );
      case 'mcp': {
        const statusLabel = isConnected === null ? '점검 중' : isConnected ? '게이트웨이 연결됨' : '게이트웨이 미연결';
        const dotClass =
          isConnected === null ? 'bg-[#f3b237]' : isConnected ? 'bg-nh-green' : 'bg-[#d84f3f]';

        return (
          <div className={panelClass} aria-label="MCP 어댑터">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className={titleClass}>MCP 어댑터</span>
              <button
                type="button"
                className={`${pillButtonClass} border-[#c9daf8] bg-[#eaf2ff] text-[#1a5fd2]`}
                onClick={openMcpSettings}
              >
                설정
              </button>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className="inline-flex h-9 min-w-0 items-center gap-2 rounded-full border border-[#dadce0] bg-white px-3">
                <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
                <span className="truncate text-[12px] font-semibold text-[#3c4043]">{statusLabel}</span>
              </div>
              <div className="inline-flex h-9 items-center rounded-full border border-[#dadce0] bg-white px-3 text-[12px] font-semibold text-[#1a5fd2]">
                Streamable HTTP
              </div>
              <div className="inline-flex h-9 min-w-0 max-w-full items-center rounded-full bg-[#f1f3f4] px-3 text-[12px] font-medium text-[#5f6368]">
                {settings.modelName} · {settings.endpoint}
              </div>
            </div>
          </div>
        );
      }
    }
  };

  return (
    <div
      className={`relative flex h-full w-full flex-col overflow-hidden bg-[#fbfffd] text-ink ${
        settings.compactMode ? 'text-[13px]' : ''
      }`}
      data-compact={settings.compactMode ? 'true' : 'false'}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={referenceInputRef}
        type="file"
        accept={REFERENCE_DOCUMENT_ACCEPT}
        multiple
        className="hidden"
        onChange={handleReferenceFileChange}
      />

      {activeView === 'settings' ? (
        <div className="nh-scrollbar min-h-0 flex-1 overflow-y-auto bg-white">
          <SettingsModal />
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col bg-white">
          {isDraggingImage && (
            <div className="absolute inset-3 z-20 flex flex-col items-center justify-center rounded-lg border border-dashed border-nh-green/70 bg-white/90 text-center backdrop-blur">
              <span className="text-sm font-bold text-nh-teal">이미지를 놓아 참조로 추가</span>
              <small className="mt-1 text-xs font-medium text-muted-ink">파일당 5MB 이하</small>
            </div>
          )}

          <MessageList
            messages={displayMessages}
            isLoading={isLoading}
            referenceLinks={referenceLinks}
            onReferenceLinkClick={handleReferenceLinkClick}
            onQuickAction={sendChatText}
          />
          {renderReferenceViewer()}
          {activeTool ? (
            <section className="bg-white" aria-live="polite">
              {renderUtilityPanel()}
            </section>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5 border-t border-[#e6eeea] px-3 py-2 text-[11px] font-semibold text-muted-ink">
            <span className="rounded-full border border-[#e6eeea] px-2 py-1">
              access: {settings.permissionMode}
            </span>
            <span className="rounded-full border border-[#e6eeea] px-2 py-1">
              plan: {settings.planMode ? 'on' : 'off'}
            </span>
            {settings.permissionMode === 'scoped' ? (
              <span className="truncate rounded-full border border-[#e6eeea] px-2 py-1">
                use @folder or @file to grant edit scope
              </span>
            ) : null}
          </div>
        </div>
      )}

      <ChatInput
        value={input}
        onChange={setInput}
        onSend={handleSend}
        activeTool={activeTool}
        appVersion={APP_VERSION}
        disabled={isLoading}
        isConnected={isConnected}
        isSettingsActive={activeView === 'settings'}
        modelName={settings.modelName}
        modelUseCase={settings.modelUseCase}
        onModelChange={handleModelChange}
        placeholder={`${APP_NAME}에게 요청하기`}
        imageAttachments={imageAttachments}
        attachmentError={attachmentError}
        canSend={canSendMessage && !hasParsingReferenceDocuments}
        onSessionReset={handleSessionReset}
        onSelectImages={(files) => void addImageFiles(files)}
        onSettingsClick={handleSettingsClick}
        onToolClick={handleToolClick}
        onRemoveImage={(id) => setImageAttachments((prev) => prev.filter((image) => image.id !== id))}
      />
    </div>
  );
};

export default ChatApp;
