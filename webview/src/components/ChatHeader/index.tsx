import { type FC } from 'react';
import type { ChatHeaderProps, UtilityTool } from './types';

const iconClass = 'h-[18px] w-[18px]';

const ResetIcon = () => (
  <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
    <path
      d="M4.75 6.75v4.5h4.5M5.2 11.25A7 7 0 1 0 7 6.1"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    />
  </svg>
);

const FilterIcon = () => (
  <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
    <path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
  </svg>
);

const ImageIcon = () => (
  <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
    <path
      d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17V7A1.5 1.5 0 0 1 5 5.5Z"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="2"
    />
    <path d="m6.5 15 3.25-3.25 2.5 2.5 1.75-1.75L17.5 16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    <path d="M15.75 9.25h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
  </svg>
);

const HistoryIcon = () => (
  <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
    <path
      d="M5 5.75V10h4.25M5.35 10A7 7 0 1 0 7 6.35"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    />
    <path d="M12 8.5v4.1l2.6 1.7" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
  </svg>
);

const AdapterIcon = () => (
  <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
    <path
      d="M8 7V4M16 7V4M7 9h10v4.5A5 5 0 0 1 12 18.5v0A5 5 0 0 1 7 13.5V9Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    />
    <path d="M12 18.5V21" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
  </svg>
);

const SettingsIcon = () => (
  <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
    <path
      d="M12 8.25A3.75 3.75 0 1 1 12 15.75 3.75 3.75 0 0 1 12 8.25Z"
      stroke="currentColor"
      strokeWidth="2"
    />
    <path
      d="M18.55 13.2a6.6 6.6 0 0 0 .04-2.35l2.02-1.54-2-3.46-2.38.98a6.8 6.8 0 0 0-2.03-1.18L13.88 3h-4l-.36 2.65a6.8 6.8 0 0 0-2.03 1.18l-2.34-.98-2 3.46 1.98 1.54a6.6 6.6 0 0 0 .04 2.35l-2.02 1.54 2 3.46 2.38-.98a6.8 6.8 0 0 0 2.03 1.18l.32 2.6h4l.36-2.6a6.8 6.8 0 0 0 2.03-1.18l2.34.98 2-3.46-2.06-1.54Z"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.7"
    />
  </svg>
);

const utilityButtons: Array<{
  id: UtilityTool;
  label: string;
  icon: FC;
}> = [
  { id: 'filter', label: '필터', icon: FilterIcon },
  { id: 'references', label: '참조 문서', icon: ImageIcon },
  { id: 'history', label: '히스토리', icon: HistoryIcon },
  { id: 'mcp', label: 'MCP 어댑터', icon: AdapterIcon },
];

const toolButtonClass =
  'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]/45';

export const ChatHeader: FC<ChatHeaderProps> = ({
  activeTool,
  appVersion,
  isConnected,
  isSettingsActive,
  modelName,
  onSessionReset,
  onSettingsClick,
  onToolClick,
}) => {
  const connectionLabel = isConnected === null ? '점검 중' : isConnected ? '연결됨' : '미연결';
  const connectionDotClass =
    isConnected === null ? 'bg-[#fbbc04]' : isConnected ? 'bg-[#188038]' : 'bg-[#d93025]';

  const getToolClass = (tool: UtilityTool) =>
    activeTool === tool
      ? `${toolButtonClass} border-[#c9daf8] bg-[#e8f0fe] text-[#1a73e8]`
      : `${toolButtonClass} border-transparent bg-transparent text-[#5f6368] hover:bg-[#f1f3f4] hover:text-[#202124]`;

  return (
    <footer className="bg-white px-3 pb-1 pt-2" aria-label="하단 작업 도구">
      <div className="mb-1.5 flex h-8 min-w-0 items-center gap-1.5 overflow-hidden rounded-full bg-white px-1">
        <span className="inline-flex h-7 shrink-0 items-center rounded-full bg-[#f1f3f4] px-2.5 text-[11px] font-bold text-[#3c4043]">
          사용자
        </span>
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-[#dadce0] bg-white px-2.5 text-[11px] font-bold text-[#3c4043] transition hover:border-[#c8d7ef] hover:bg-[#f8fbff] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]/45"
          onClick={onSettingsClick}
          aria-label={`연결 상태: ${connectionLabel}`}
          title={`연결 상태: ${connectionLabel}`}
        >
          <span className={`h-2 w-2 rounded-full ${connectionDotClass}`} />
          <span>{connectionLabel}</span>
        </button>
        <span
          className="inline-flex h-7 min-w-0 flex-1 items-center rounded-full bg-[#f8fafd] px-2.5 text-[11px] font-semibold text-[#5f6368]"
          title={`현재 모델: ${modelName}`}
        >
          <span className="truncate">모델 {modelName}</span>
        </span>
        <span className="inline-flex h-7 shrink-0 items-center rounded-full bg-[#f1f3f4] px-2 text-[11px] font-bold text-[#5f6368]">
          v{appVersion}
        </span>
        <button
          type="button"
          onClick={onSettingsClick}
          className={`${toolButtonClass} h-8 w-8 ${
            isSettingsActive
              ? 'border-[#c9daf8] bg-[#e8f0fe] text-[#1a73e8]'
              : 'border-transparent bg-transparent text-[#5f6368] hover:bg-[#f1f3f4] hover:text-[#202124]'
          }`}
          aria-label="설정"
          title="설정"
          aria-pressed={isSettingsActive}
          data-testid="settings-tool-button"
        >
          <SettingsIcon />
          <span className="sr-only">설정</span>
        </button>
      </div>
      <div className="flex h-11 items-center gap-1.5 rounded-full bg-[#f8fafd] px-1.5">
        <button
          type="button"
          onClick={onSessionReset}
          className={`${toolButtonClass} border-transparent bg-transparent text-[#5f6368] hover:bg-[#f1f3f4] hover:text-[#202124]`}
          aria-label="세션 초기화"
          title="세션 초기화"
          data-testid="session-reset-button"
        >
          <ResetIcon />
          <span className="sr-only">세션 초기화</span>
        </button>
        {utilityButtons.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => onToolClick(id)}
            className={getToolClass(id)}
            aria-label={label}
            title={label}
            aria-pressed={activeTool === id}
            data-testid={`${id}-tool-button`}
          >
            <Icon />
            <span className="sr-only">{label}</span>
          </button>
        ))}
      </div>
    </footer>
  );
};

export default ChatHeader;
