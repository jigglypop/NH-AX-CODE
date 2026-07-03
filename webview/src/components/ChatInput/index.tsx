import { useEffect, useRef, useState, type FC, type KeyboardEventHandler } from 'react';
import type { ChatInputProps } from './types';
import type { UtilityTool } from '../ChatHeader/types';
import { MODEL_PRESET_GROUPS, type ModelUseCase } from '../../config/app';

type MenuAction = 'image' | 'reset' | UtilityTool | 'settings';

const iconClass = 'h-[18px] w-[18px]';

const PlusIcon = () => (
  <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
  </svg>
);

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
    <path
      d="m6.5 15 3.25-3.25 2.5 2.5 1.75-1.75L17.5 16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    />
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

const SendIcon = () => (
  <svg aria-hidden="true" className={iconClass} fill="currentColor" viewBox="0 0 24 24">
    <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
  </svg>
);

const actionItems: Array<{ id: MenuAction; label: string; icon: FC }> = [
  { id: 'image', label: '이미지 참조', icon: ImageIcon },
  { id: 'reset', label: '세션 초기화', icon: ResetIcon },
  { id: 'filter', label: '필터', icon: FilterIcon },
  { id: 'references', label: '참조 문서', icon: ImageIcon },
  { id: 'history', label: '대화 히스토리', icon: HistoryIcon },
  { id: 'mcp', label: 'MCP 어댑터', icon: AdapterIcon },
  { id: 'settings', label: '설정', icon: SettingsIcon },
];

export const ChatInput: FC<ChatInputProps> = ({
  value,
  onChange,
  onSend,
  activeTool = null,
  appVersion,
  disabled = false,
  isConnected = null,
  isSettingsActive = false,
  modelName,
  modelUseCase,
  placeholder = '메시지를 입력하세요',
  imageAttachments = [],
  attachmentError,
  canSend: canSendOverride,
  onSessionReset,
  onSelectImages,
  onModelChange,
  onSettingsClick,
  onToolClick,
  onRemoveImage,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const shouldRestoreFocusRef = useRef(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [openModelGroup, setOpenModelGroup] = useState<ModelUseCase | null>(null);
  const canSend = canSendOverride ?? Boolean(value.trim() || imageAttachments.length);
  const connectionLabel = isConnected === null ? '점검 중' : isConnected ? '연결됨' : '미연결';
  const connectionDotClass =
    isConnected === null ? 'bg-[#fbbc04]' : isConnected ? 'bg-[#188038]' : 'bg-[#d93025]';
  const selectedModelUseCase =
    modelUseCase ||
    MODEL_PRESET_GROUPS.find((group) =>
      group.presets.some((preset) => preset.value === modelName),
    )?.value;

  useEffect(() => {
    if (!isMenuOpen && !isModelMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsMenuOpen(false);
        setIsModelMenuOpen(false);
        setOpenModelGroup(null);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMenuOpen(false);
        setIsModelMenuOpen(false);
        setOpenModelGroup(null);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isMenuOpen, isModelMenuOpen]);

  useEffect(() => {
    if (disabled || !shouldRestoreFocusRef.current) {
      return;
    }

    shouldRestoreFocusRef.current = false;
    textareaRef.current?.focus();
  }, [disabled]);

  const focusTextareaSoon = () => {
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  };

  const handleSubmit = () => {
    if (!canSend || disabled) {
      return;
    }

    shouldRestoreFocusRef.current = true;
    onSend();
    focusTextareaSoon();
  };

  const handleKeyPress: KeyboardEventHandler = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  const handleMenuAction = (action: MenuAction) => {
    setIsMenuOpen(false);
    setIsModelMenuOpen(false);
    setOpenModelGroup(null);

    if (action === 'image') {
      fileInputRef.current?.click();
      return;
    }

    if (action === 'reset') {
      onSessionReset?.();
      return;
    }

    if (action === 'settings') {
      onSettingsClick?.();
      return;
    }

    onToolClick?.(action);
  };

  const handleModelSelect = (nextModelName: string, nextModelUseCase: ModelUseCase) => {
    setIsModelMenuOpen(false);
    setOpenModelGroup(null);
    onModelChange?.(nextModelName, nextModelUseCase);
  };

  return (
    <div className="bg-[#f5f6f7] px-3 pb-3 pt-2">
      <div ref={rootRef} className="relative">
        {isMenuOpen ? (
          <div
            className="animate-drop-up-menu absolute bottom-[calc(100%+8px)] left-0 z-30 w-[236px] overflow-hidden rounded-xl border border-[#cfd4da] bg-[#f8f9fa] p-1.5"
            role="menu"
            aria-label="추가 작업"
          >
            {actionItems.map(({ id, label, icon: Icon }) => {
              const isActive = id === activeTool || (id === 'settings' && isSettingsActive);

              return (
                <button
                  key={id}
                  type="button"
                  className={`flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left text-[13px] font-semibold transition ${
                    isActive
                      ? 'bg-[#e8eaed] text-[#202124]'
                      : 'text-[#3c4043] hover:bg-[#eef0f2] hover:text-[#202124]'
                  }`}
                  role="menuitem"
                  onClick={() => handleMenuAction(id)}
                >
                  <Icon />
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="rounded-[28px] border border-[#cfd4da] bg-[#f6f7f8] px-3 pb-2 pt-2 focus-within:border-[#aeb4bc] focus-within:bg-white">
          <div className="mb-1.5 flex min-w-0 items-center gap-1.5">
            <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-white px-2 text-[10.5px] font-bold text-[#3c4043]">
              사용자
            </span>
            <button
              type="button"
              className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-white px-2 text-[10.5px] font-bold text-[#3c4043] transition hover:bg-[#eef0f2] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b9bec6]/55"
              onClick={onSettingsClick}
              aria-label={`연결 상태: ${connectionLabel}`}
              title={`연결 상태: ${connectionLabel}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${connectionDotClass}`} />
              <span>{connectionLabel}</span>
            </button>
            <span className="min-w-0 flex-1" />
            {appVersion ? (
              <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-white px-2 text-[10.5px] font-bold text-[#5f6368]">
                v{appVersion}
              </span>
            ) : null}
          </div>

          {imageAttachments.length > 0 && (
            <div className="mb-2 flex gap-2 overflow-x-auto pb-1" aria-label="참조 이미지">
              {imageAttachments.map((image) => (
                <div
                  className="relative grid w-[92px] shrink-0 grid-rows-[58px_auto] overflow-hidden rounded-md border border-[#dadde2] bg-white"
                  key={image.id}
                >
                  <img src={image.dataUrl} alt={image.name} className="h-[58px] w-full object-cover" />
                  <span className="truncate px-1.5 py-1 text-[10px] font-medium text-muted-ink">{image.name}</span>
                  <button
                    type="button"
                    className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/75 disabled:opacity-50"
                    aria-label={`${image.name} 제거`}
                    onClick={() => onRemoveImage?.(image.id)}
                    disabled={disabled}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M18 6 6 18M6 6l12 12"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {attachmentError ? (
            <p className="mb-2 text-[11px] font-semibold text-[#d84f3f]" role="alert">
              {attachmentError}
            </p>
          ) : null}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              onSelectImages?.(event.target.files);
              event.target.value = '';
            }}
            disabled={disabled}
          />

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyPress}
            placeholder={placeholder}
            rows={1}
            disabled={disabled}
            className="block max-h-32 min-h-10 w-full resize-none border-0 bg-transparent px-1 py-2 text-[14px] leading-5 text-[#202124] outline-none placeholder:text-[#8b949e] disabled:cursor-not-allowed"
          />

          <div className="mt-1 flex min-w-0 items-center gap-2">
            <button
              type="button"
              className={`flex h-9 w-9 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-45 ${
                isMenuOpen ? 'bg-[#e8eaed] text-[#202124]' : 'text-[#5f6368] hover:bg-[#eef0f2] hover:text-[#202124]'
              }`}
              onClick={() => {
                setIsModelMenuOpen(false);
                setOpenModelGroup(null);
                setIsMenuOpen((current) => !current);
              }}
              disabled={disabled}
              aria-label="추가 작업"
              title="추가 작업"
              aria-expanded={isMenuOpen}
              data-testid="add-menu-button"
            >
              <PlusIcon />
            </button>
            {modelName ? (
              <div className="relative min-w-0 shrink">
                {isModelMenuOpen ? (
                  <div
                    className="animate-drop-up-menu absolute bottom-[calc(100%+8px)] left-0 z-30 w-[260px] overflow-hidden rounded-xl border border-[#cfd4da] bg-[#f8f9fa] p-1.5"
                    role="menu"
                    aria-label="모델 선택"
                  >
                    {MODEL_PRESET_GROUPS.map((group) => {
                      const isGroupOpen = openModelGroup === group.value;
                      const isGroupSelected = selectedModelUseCase === group.value;

                      return (
                        <div key={group.value} className="py-0.5" role="group" aria-label={group.label}>
                          <button
                            type="button"
                            className={`flex h-10 w-full items-center justify-between gap-3 rounded-lg px-3 text-left transition ${
                              isGroupOpen || isGroupSelected
                                ? 'bg-[#e8eaed] text-[#202124]'
                                : 'text-[#3c4043] hover:bg-[#eef0f2] hover:text-[#202124]'
                            }`}
                            role="menuitem"
                            aria-expanded={isGroupOpen}
                            onClick={() =>
                              setOpenModelGroup((currentGroup) =>
                                /* v8 ignore next */
                                currentGroup === group.value ? null : group.value,
                              )
                            }
                          >
                            <span className="truncate text-[12px] font-bold">{group.label}</span>
                            <span className="shrink-0 text-[10px]" aria-hidden="true">
                              {isGroupOpen ? '▾' : '▸'}
                            </span>
                          </button>
                          {isGroupOpen ? (
                            <div className="mt-1 pl-3">
                              {group.presets.map((preset) => {
                          const isSelected =
                            preset.value === modelName && selectedModelUseCase === group.value;

                          return (
                            <button
                              key={`${group.value}-${preset.value}`}
                              type="button"
                              className={`flex min-h-10 w-full flex-col justify-center rounded-lg px-3 py-2 text-left transition ${
                                isSelected
                                  ? 'bg-[#e8eaed] text-[#202124]'
                                  : 'text-[#3c4043] hover:bg-[#eef0f2] hover:text-[#202124]'
                              }`}
                              role="menuitemradio"
                              aria-checked={isSelected}
                              onClick={() => handleModelSelect(preset.value, group.value)}
                            >
                              <span className="flex w-full min-w-0 items-center justify-between gap-3">
                                <span className="truncate text-[12px] font-bold">{preset.label}</span>
                                {isSelected ? (
                                  <span className="shrink-0 text-[11px] font-bold text-[#5f6368]">선택됨</span>
                                ) : null}
                              </span>
                              <span className="mt-0.5 truncate text-[11px] font-medium text-[#6b7280]">
                                {preset.value}
                              </span>
                            </button>
                          );
                              })}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                    <div className="my-1 border-t border-[#dfe3e7]" />
                    <button
                      type="button"
                      className="flex h-10 w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-[12px] font-bold text-[#5f6368] transition hover:bg-[#eef0f2] hover:text-[#202124]"
                      role="menuitem"
                      onClick={() => {
                        setIsModelMenuOpen(false);
                        setOpenModelGroup(null);
                        onSettingsClick?.();
                      }}
                    >
                      <span className="truncate">직접 입력 및 상세 설정</span>
                      <span aria-hidden="true">›</span>
                    </button>
                  </div>
                ) : null}
              <button
                type="button"
                className="inline-flex h-8 min-w-0 max-w-[190px] shrink items-center gap-1 rounded-full px-2.5 text-left text-[11px] font-bold text-[#5f6368] transition hover:bg-[#eceff1] hover:text-[#202124] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b9bec6]/55"
                onClick={() => {
                  setIsMenuOpen(false);
                  setIsModelMenuOpen((current) => {
                    const nextIsOpen = !current;

                    if (nextIsOpen) {
                      setOpenModelGroup(null);
                    }

                    return nextIsOpen;
                  });
                }}
                title={`현재 모델: ${modelName}`}
                aria-label={`현재 모델: ${modelName}`}
              >
                <span className="truncate">{modelName}</span>
                <span className="shrink-0 text-[10px]" aria-hidden="true">
                  ▴
                </span>
              </button>
              </div>
            ) : (
              null
            )}
            <span className="min-w-0 flex-1" />
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSend || disabled}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-[#202124] text-white transition hover:bg-[#3c4043] disabled:cursor-not-allowed disabled:bg-[#c4c7c5]"
              aria-label="전송"
              data-testid="send-button"
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
