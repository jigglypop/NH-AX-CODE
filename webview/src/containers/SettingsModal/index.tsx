import { type FC } from 'react';
import { useSettings } from '../../hooks/useSettings';
import type { SettingsModalProps } from './types';
import {
  APP_NAME,
  DEFAULT_API_ENDPOINT,
  MODEL_PRESET_GROUPS,
  MODEL_USE_CASES,
  type ModelUseCase,
} from '../../config/app';

const fieldClass =
  'h-10 w-full rounded-md border border-[#dfe8e4] bg-white px-3 text-[13px] text-ink outline-none transition placeholder:text-[#9aa8a2] focus:border-nh-teal focus:ring-2 focus:ring-nh-teal/10';

export const SettingsModal: FC<SettingsModalProps> = () => {
  const { settings, saveSettings } = useSettings();
  const selectedPresetGroup =
    MODEL_PRESET_GROUPS.find(
      (group) =>
        group.value === settings.modelUseCase &&
        group.presets.some((preset) => preset.value === settings.modelName),
    ) ||
    MODEL_PRESET_GROUPS.find((group) =>
      group.presets.some((preset) => preset.value === settings.modelName),
    );
  const selectedPreset = selectedPresetGroup
    ? `${selectedPresetGroup.value}:${settings.modelName}`
    : 'custom';
  const selectedUseCase = MODEL_USE_CASES.find((useCase) => useCase.value === settings.modelUseCase);

  const handleSettingChange = <K extends keyof typeof settings>(
    key: K,
    value: (typeof settings)[K],
  ) => {
    saveSettings({ [key]: value });
  };

  const handleModelPresetChange = (value: string) => {
    if (value === 'custom') {
      saveSettings({
        modelName: 'custom-model',
        modelUseCase: '',
      });
      return;
    }

    const [modelUseCase, modelName] = value.split(':') as [ModelUseCase, string];
    const hasPreset = MODEL_PRESET_GROUPS.some(
      (group) =>
        group.value === modelUseCase &&
        group.presets.some((preset) => preset.value === modelName),
    );

    if (!hasPreset) {
      return;
    }

    saveSettings({
      modelName,
      modelUseCase,
    });
  };

  const handleModelUseCaseChange = (value: ModelUseCase) => {
    if (!value) {
      saveSettings({ modelUseCase: '' });
      return;
    }

    const useCase = MODEL_USE_CASES.find((item) => item.value === value);

    if (!useCase) {
      return;
    }

    saveSettings({
      modelName: useCase.modelName,
      modelUseCase: useCase.value,
    });
  };

  return (
    <>
      <div className="space-y-5 px-4 py-5">
        <div>
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-nh-teal">AI Settings</span>
          <h2 className="mt-1 text-lg font-extrabold text-ink">{APP_NAME}</h2>
        </div>

        <section className="space-y-2">
          <span className="text-[12px] font-bold text-muted-ink">Provider</span>
          <div className="grid grid-cols-2 rounded-lg border border-[#dfe8e4] bg-[#f8fbfa] p-1">
            <button
              type="button"
              className={`h-9 rounded-md text-[13px] font-bold transition ${
                settings.modelType === 'openai'
                  ? 'bg-white text-nh-blue shadow-sm'
                  : 'text-muted-ink hover:text-nh-blue'
              }`}
              onClick={() => saveSettings({ modelType: 'openai', endpoint: DEFAULT_API_ENDPOINT })}
            >
              OpenAI 호환
            </button>
            <button
              type="button"
              className={`h-9 rounded-md text-[13px] font-bold transition ${
                settings.modelType === 'custom'
                  ? 'bg-white text-nh-blue shadow-sm'
                  : 'text-muted-ink hover:text-nh-blue'
              }`}
              onClick={() => handleSettingChange('modelType', 'custom')}
            >
              Custom
            </button>
          </div>
        </section>

        <section className="space-y-2">
          <label className="text-[12px] font-bold text-muted-ink" htmlFor="nh-model-preset">
            모델 직접 선택
          </label>
          <select
            id="nh-model-preset"
            value={selectedPreset}
            onChange={(event) => handleModelPresetChange(event.target.value)}
            className={fieldClass}
          >
            {MODEL_PRESET_GROUPS.map((group) => (
              <optgroup key={group.value} label={group.label}>
                {group.presets.map((preset) => (
                  <option key={`${group.value}-${preset.value}`} value={`${group.value}:${preset.value}`}>
                    {preset.label}
                  </option>
                ))}
              </optgroup>
            ))}
            <option value="custom">직접 입력</option>
          </select>
          <input
            type="text"
            value={settings.modelName}
            onChange={(event) => saveSettings({ modelName: event.target.value, modelUseCase: '' })}
            placeholder="model-name"
            className={fieldClass}
          />
        </section>

        <section className="space-y-2">
          <label className="text-[12px] font-bold text-muted-ink" htmlFor="nh-model-use-case">
            업무 기준 선택
          </label>
          <select
            id="nh-model-use-case"
            value={settings.modelUseCase}
            onChange={(event) => handleModelUseCaseChange(event.target.value as ModelUseCase)}
            className={fieldClass}
          >
            <option value="">업무 선택 안 함</option>
            {MODEL_USE_CASES.map((useCase) => (
              <option key={useCase.value} value={useCase.value}>
                {useCase.label} · {useCase.modelName}
              </option>
            ))}
          </select>
          {selectedUseCase ? (
            <p className="text-[11px] font-medium leading-4 text-muted-ink">
              {selectedUseCase.description}
            </p>
          ) : null}
        </section>

        <section className="space-y-2">
          <label className="text-[12px] font-bold text-muted-ink" htmlFor="nh-endpoint">
            Endpoint
          </label>
          <input
            id="nh-endpoint"
            type="text"
            value={settings.endpoint}
            onChange={(event) => handleSettingChange('endpoint', event.target.value)}
            placeholder="https://api.example.com/v1/chat/completions"
            className={fieldClass}
          />
        </section>

        <section className="space-y-2">
          <label className="text-[12px] font-bold text-muted-ink" htmlFor="nh-api-key">
            API Key
          </label>
          <input
            id="nh-api-key"
            type="password"
            value={settings.apiKey}
            onChange={(event) => handleSettingChange('apiKey', event.target.value)}
            placeholder="sk-..."
            className={fieldClass}
          />
        </section>

        <section className="space-y-2">
          <label className="flex items-center justify-between gap-3 rounded-lg border border-[#e6eeea] bg-[#fbfdfc] p-3">
            <span className="min-w-0">
              <strong className="block text-[13px] text-ink">현재 페이지 컨텍스트 공유</strong>
              <small className="mt-1 block text-[11px] leading-4 text-muted-ink">
                요청을 보낼 때 페이지 제목, URL, 본문 일부를 함께 전달합니다.
              </small>
            </span>
            <input
              type="checkbox"
              checked={settings.sharePageContext}
              onChange={(event) => handleSettingChange('sharePageContext', event.target.checked)}
              className="h-4 w-4 accent-nh-teal"
            />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-[#e6eeea] bg-[#fbfdfc] p-3">
            <span className="min-w-0">
              <strong className="block text-[13px] text-ink">Compact UI</strong>
              <small className="mt-1 block text-[11px] leading-4 text-muted-ink">
                채팅 화면의 여백을 줄입니다.
              </small>
            </span>
            <input
              type="checkbox"
              checked={settings.compactMode}
              onChange={(event) => handleSettingChange('compactMode', event.target.checked)}
              className="h-4 w-4 accent-nh-teal"
            />
          </label>
          <label className="block rounded-lg border border-[#e6eeea] bg-[#fbfdfc] p-3">
            <span className="block text-[13px] font-bold text-ink">Agent access</span>
            <small className="mt-1 block text-[11px] leading-4 text-muted-ink">
              Scoped mode only edits files inside @mentioned file or folder scopes.
            </small>
            <select
              value={settings.permissionMode}
              onChange={(event) =>
                handleSettingChange(
                  'permissionMode',
                  event.target.value as typeof settings.permissionMode,
                )
              }
              className={`${fieldClass} mt-2`}
            >
              <option value="scoped">@ scoped</option>
              <option value="workspace">Workspace</option>
              <option value="full">Full access</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-[#e6eeea] bg-[#fbfdfc] p-3">
            <span className="min-w-0">
              <strong className="block text-[13px] text-ink">Plan mode</strong>
              <small className="mt-1 block text-[11px] leading-4 text-muted-ink">
                Ask the agent to plan only and block generated file actions.
              </small>
            </span>
            <input
              type="checkbox"
              checked={settings.planMode}
              onChange={(event) => handleSettingChange('planMode', event.target.checked)}
              className="h-4 w-4 accent-nh-teal"
            />
          </label>
        </section>
      </div>
      <div className="border-t border-[#e6eeea] px-4 py-3">
        <span className="text-[11px] font-medium text-[#8a9993]">변경 사항은 자동 저장됩니다.</span>
      </div>
    </>
  );
};

export default SettingsModal;
