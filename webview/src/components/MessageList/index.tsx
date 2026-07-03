import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import type { MessageListProps } from './types';
import { APP_NAME, QUICK_ACTIONS } from '../../config/app';
import { MarkdownContent } from '../MarkdownContent';

const COPY_LABEL = '\uBCF5\uC0AC';
const COPIED_LABEL = '\uBCF5\uC0AC\uB428';
const COPY_RESPONSE_LABEL = '\uC751\uB2F5 \uBCF5\uC0AC';
const COPY_MESSAGE_LABEL = '\uBA54\uC2DC\uC9C0 \uBCF5\uC0AC';
const ASSISTANT_AVATAR_SRC = 'icons/original.png';

const timestampFormatOptions: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
};

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

const CopyIcon = () => (
  <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 16 16">
    <rect height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" width="9" x="5" y="5" />
    <path d="M3.5 10.5H3A1.5 1.5 0 0 1 1.5 9V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
  </svg>
);

const CheckIcon = () => (
  <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 16 16">
    <path d="M3.25 8.25 6.5 11.5l6.25-7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
  </svg>
);

const formatMessageTimestamp = (timestamp: Date) => timestamp.toLocaleString('ko-KR', timestampFormatOptions);

const TypingIndicator = () => (
  <div className="flex items-center gap-1 py-1">
    <span className="h-1.5 w-1.5 animate-typing rounded-full bg-[#6f8b82]" />
    <span className="h-1.5 w-1.5 animate-typing rounded-full bg-[#6f8b82] [animation-delay:0.18s]" />
    <span className="h-1.5 w-1.5 animate-typing rounded-full bg-[#6f8b82] [animation-delay:0.36s]" />
  </div>
);

export const MessageList: FC<MessageListProps> = ({
  messages,
  isLoading,
  referenceLinks,
  onReferenceLinkClick,
  onQuickAction,
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const copyResetTimerRef = useRef<number | undefined>(undefined);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const hasOnlyWelcomeMessage = messages.length === 1 && messages[0]?.id === 'welcome';
  const showQuickActions = hasOnlyWelcomeMessage && !isLoading;
  const showIntro = hasOnlyWelcomeMessage;
  const visibleMessages = showIntro ? [] : messages;
  const showTyping = isLoading && !messages.some((message) => message.isStreaming);

  useEffect(() => {
    /* v8 ignore next */
    messagesEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [messages]);

  useEffect(
    () => () => {
      if (copyResetTimerRef.current) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    },
    [],
  );

  const handleCopyResponse = useCallback(async (messageId: string, content: string) => {
    await copyTextToClipboard(content);
    setCopiedMessageId(messageId);

    if (copyResetTimerRef.current) {
      window.clearTimeout(copyResetTimerRef.current);
    }

    copyResetTimerRef.current = window.setTimeout(() => {
      /* v8 ignore next */
      setCopiedMessageId((currentId) => (currentId === messageId ? null : currentId));
    }, 1500);
  }, []);

  return (
   <div className="nh-scrollbar min-h-0 flex-1 overflow-y-auto bg-white">
    {showIntro && (
     <div className="flex min-h-[220px] flex-col justify-center border-b border-[#edf2ef] px-[18px] py-7">
      <h1 className="m-0 flex flex-col gap-1 text-[24px] font-[780] leading-[1.28] tracking-normal">
       <span className="animate-intro-drop bg-gradient-to-r from-nh-blue via-nh-teal via-[44%] to-nh-sky bg-clip-text text-transparent">
        안녕하세요
       </span>
       <span className="animate-intro-drop bg-gradient-to-r from-nh-blue via-nh-teal via-[44%] to-nh-sky bg-clip-text text-transparent">
        NH-AX-Edge 어시스턴트입니다
       </span>
       <span className="animate-intro-drop bg-gradient-to-r from-nh-blue via-nh-green to-nh-sky bg-clip-text text-transparent [animation-delay:0.08s]">
        무엇을 도와드릴까요
       </span>
      </h1>
      <div className="mt-[18px] flex flex-col gap-1.5 text-[11px] font-medium leading-[1.55] text-[#7a8782]">
       <p>* 개인정보 및 부적절한 내용은 사용하지 마시기 바랍니다</p>
       <p>
        * 해당 답변은 제공된 데이터와 알고리즘에 기반하여 AI가 제공하는 답변으로 완전성을 보장하지
        않으므로, 중요 사항은 추가 확인이 필요합니다
       </p>
      </div>
     </div>
    )}

    {visibleMessages.map(message => {
     const isUser = message.role === 'user'
     const canCopyMessage = Boolean(message.content.trim())
     const copyLabel = isUser ? COPY_MESSAGE_LABEL : COPY_RESPONSE_LABEL
     const isCopied = copiedMessageId === message.id

     return (
      <div
       key={message.id}
       className={`flex w-full animate-fade-in gap-2.5 border-b border-[#edf2ef] px-[18px] py-3.5 ${
        isUser ? 'flex-row-reverse bg-[#fbfdfc]' : ''
       }`}
      >
       <div className="flex h-6 w-[30px] shrink-0 items-center justify-center">
        {isUser ? (
         <span className="text-[10px] font-extrabold text-nh-blue">ME</span>
        ) : (
         <img
          src={ASSISTANT_AVATAR_SRC}
          alt=""
          aria-hidden="true"
          className="h-6 w-6 rounded-md object-cover"
         />
        )}
       </div>
       <div
        className={`flex min-w-0 flex-1 flex-col gap-1.5 ${isUser ? 'items-end' : 'items-start'}`}
       >
        {message.attachments?.length ? (
         <div
          className={`grid grid-cols-[repeat(2,minmax(0,96px))] gap-1.5 ${
           /* v8 ignore next */
           isUser ? 'justify-end' : 'justify-start'
          }`}
          aria-label="참조 이미지"
         >
          {message.attachments.map(image => (
           <img
            key={image.id}
            src={image.dataUrl}
            alt={image.name}
            className="h-[72px] w-24 rounded-md border border-[#e2e8e4] object-cover"
           />
          ))}
         </div>
        ) : null}

        <div
         className={`max-w-full break-words text-[14px] leading-[1.62] ${
          isUser
           ? 'max-w-[min(100%,620px)] text-right text-[#102b24]'
           : 'w-full text-left text-[#17211d]'
         }`}
        >
         {message.role === 'assistant' ? (
          message.content ? (
           <MarkdownContent
            content={message.content}
            isStreaming={message.isStreaming}
            referenceLinks={referenceLinks}
            onReferenceLinkClick={onReferenceLinkClick}
           />
          ) : (
           <TypingIndicator />
          )
         ) : (
          <MarkdownContent
            content={message.content}
            referenceLinks={referenceLinks}
            onReferenceLinkClick={onReferenceLinkClick}
          />
         )}
        </div>
        <div
         className={`flex max-w-full items-center justify-between gap-2 ${
          isUser ? 'w-[min(100%,620px)] flex-row-reverse' : 'w-full'
         }`}
        >
         <span className={`text-[11px] text-[#889690] ${isUser ? 'text-right' : 'text-left'}`}>
          {formatMessageTimestamp(message.timestamp)}
         </span>
         {canCopyMessage ? (
          <button
           type="button"
           className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#889690] transition hover:bg-[#f7fbf9] hover:text-nh-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-nh-sky/35"
           aria-label={isCopied ? COPIED_LABEL : copyLabel}
           title={isCopied ? COPIED_LABEL : COPY_LABEL}
           onClick={() => void handleCopyResponse(message.id, message.content)}
          >
           {isCopied ? <CheckIcon /> : <CopyIcon />}
          </button>
         ) : null}
        </div>
       </div>
      </div>
     )
    })}

    {showQuickActions && (
     <div
      className="grid w-full grid-cols-2 gap-2 border-b border-[#edf2ef] px-[18px] py-3.5"
      aria-label={`${APP_NAME} quick actions`}
     >
      {QUICK_ACTIONS.map(action => (
       <button
        key={action.id}
        type="button"
        className="min-h-9 rounded-md border border-[#e2e8e4] bg-white px-2 text-[13px] font-semibold text-muted-ink transition hover:border-[#c8ddd6] hover:bg-[#f7fbf9] hover:text-nh-blue"
        onClick={() => onQuickAction?.(action.prompt)}
       >
        {action.label}
       </button>
      ))}
     </div>
    )}

    {showTyping && (
     <div className="flex w-full animate-fade-in gap-2.5 border-b border-[#edf2ef] px-[18px] py-3.5">
      <div className="flex h-6 w-[30px] shrink-0 items-center justify-center">
       <img
        src={ASSISTANT_AVATAR_SRC}
        alt=""
        aria-hidden="true"
        className="h-6 w-6 rounded-md object-cover"
       />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
       <TypingIndicator />
      </div>
     </div>
    )}

    <div ref={messagesEndRef} />
   </div>
  )
};
