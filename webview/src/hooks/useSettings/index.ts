import { useAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import { settingsAtom } from '../../atoms/chatAtoms';
import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_API_ENDPOINT,
  MODEL_USE_CASES,
  normalizeOpenAIModelName,
  type AgentPermissionMode,
  type AppSettings,
  type ModelUseCase,
} from '../../config/app';

export type APISettings = AppSettings;

const STORAGE_KEY = 'clarusCode.settings';

const normalizeModelUseCase = (value?: string): ModelUseCase => {
  if (MODEL_USE_CASES.some((useCase) => useCase.value === value)) {
    return value as ModelUseCase;
  }

  return DEFAULT_AI_SETTINGS.modelUseCase;
};

const normalizePermissionMode = (value?: string): AgentPermissionMode => {
  if (value === 'workspace' || value === 'full') {
    return value;
  }

  return 'scoped';
};

const normalizeSettings = (rawSettings?: Partial<AppSettings>): AppSettings => ({
  ...DEFAULT_AI_SETTINGS,
  ...rawSettings,
  modelType: rawSettings?.modelType === 'custom' ? 'custom' : 'openai',
  modelName:
    rawSettings?.modelType === 'custom' ||
    (Boolean(rawSettings?.endpoint) && rawSettings?.endpoint !== DEFAULT_API_ENDPOINT)
      ? rawSettings?.modelName || DEFAULT_AI_SETTINGS.modelName
      : normalizeOpenAIModelName(rawSettings?.modelName),
  modelUseCase: normalizeModelUseCase(rawSettings?.modelUseCase),
  endpoint: rawSettings?.endpoint || DEFAULT_AI_SETTINGS.endpoint,
  apiKey: rawSettings?.apiKey || DEFAULT_AI_SETTINGS.apiKey,
  sharePageContext: rawSettings?.sharePageContext ?? DEFAULT_AI_SETTINGS.sharePageContext,
  compactMode: rawSettings?.compactMode ?? DEFAULT_AI_SETTINGS.compactMode,
  permissionMode: normalizePermissionMode(rawSettings?.permissionMode),
  planMode: rawSettings?.planMode ?? DEFAULT_AI_SETTINGS.planMode,
});

export const useSettings = () => {
  const [settings, setSettings] = useAtom(settingsAtom);

  const loadSettings = useCallback(async () => {
    try {
      const rawSettings = window.localStorage.getItem(STORAGE_KEY);

      if (rawSettings) {
        setSettings(normalizeSettings(JSON.parse(rawSettings) as Partial<AppSettings>));
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }, [setSettings]);

  const saveSettings = useCallback(
    async (newSettings: Partial<AppSettings>) => {
      try {
        const updatedSettings = normalizeSettings({ ...settings, ...newSettings });

        setSettings(updatedSettings);
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedSettings));
      } catch (error) {
        console.error('Failed to save settings:', error);
      }
    },
    [settings, setSettings],
  );

  const getAPISettings = useCallback((): APISettings => normalizeSettings(settings), [settings]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  return {
    settings,
    saveSettings,
    getAPISettings,
    loadSettings,
  };
};
