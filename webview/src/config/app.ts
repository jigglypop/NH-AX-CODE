export const APP_NAME = 'NH-AX-Edge';
export const APP_VERSION = '1.0.3';

export const DEFAULT_API_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_MODEL_NAME = 'gpt-4o-mini';
export const BUILD_OPENAI_API_KEY = '';

export type ModelType = 'openai' | 'custom';
export type ModelUseCase = '' | 'kms' | 'general' | 'document-code' | 'high-accuracy';
export type AgentPermissionMode = 'scoped' | 'workspace' | 'full';

export interface AppSettings {
  modelType: ModelType;
  endpoint: string;
  apiKey: string;
  modelName: string;
  modelUseCase: ModelUseCase;
  sharePageContext: boolean;
  compactMode: boolean;
  permissionMode: AgentPermissionMode;
  planMode: boolean;
}

const OPENAI_MODEL_FALLBACKS: Record<string, string> = {
  gptoss: DEFAULT_MODEL_NAME,
  gemma4: 'gpt-4.1-mini',
};

export const normalizeOpenAIModelName = (modelName?: string): string => {
  const trimmedModelName = modelName?.trim();

  if (!trimmedModelName) {
    return DEFAULT_MODEL_NAME;
  }

  return OPENAI_MODEL_FALLBACKS[trimmedModelName] || trimmedModelName;
};

export const MODEL_PRESET_GROUPS = [
  {
    value: 'kms',
    label: 'KMS',
    presets: [
      {
        value: 'gpt-4o-mini',
        label: 'GPT-4o mini',
        description: 'KMS',
      },
    ],
  },
  {
    value: 'general',
    label: '일반모델',
    presets: [
      {
        value: 'gpt-4o-mini',
        label: 'GPT-4o mini',
        description: '일반모델',
      },
      {
        value: 'gpt-4.1-mini',
        label: 'GPT-4.1 mini',
        description: '일반모델',
      },
    ],
  },
] as const;

export const MODEL_PRESETS = [
  ...MODEL_PRESET_GROUPS.flatMap((group) => group.presets),
  {
    value: 'custom',
    label: '직접 입력',
    description: '사내 게이트웨이 호환 모델',
  },
] as const;

export const LEGACY_MODEL_PRESETS = [
  {
    value: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    description: '일반 업무용 기본값',
  },
  {
    value: 'gpt-4.1-mini',
    label: 'GPT-4.1 mini',
    description: '빠른 문서 및 코드 처리',
  },
  {
    value: 'gpt-4.1',
    label: 'GPT-4.1',
    description: '정확도를 우선하는 작업',
  },
  {
    value: 'custom',
    label: '직접 입력',
    description: '사내 게이트웨이 호환 모델',
  },
] as const;

export const MODEL_USE_CASES: Array<{
  value: Exclude<ModelUseCase, '' | 'document-code' | 'high-accuracy'>;
  label: string;
  modelName: string;
  description: string;
}> = [
  {
    value: 'kms',
    label: 'KMS',
    modelName: 'gpt-4o-mini',
    description: 'KMS 기본 모델',
  },
  {
    value: 'general',
    label: '일반모델',
    modelName: 'gpt-4o-mini',
    description: 'GPT-4o mini, GPT-4.1 mini',
  },
];

export const LEGACY_MODEL_USE_CASES: Array<{
  value: Exclude<ModelUseCase, ''>;
  label: string;
  modelName: string;
  description: string;
}> = [
  {
    value: 'general',
    label: '일반 업무',
    modelName: 'gpt-4o-mini',
    description: '요약, 질의응답, 초안 작성',
  },
  {
    value: 'document-code',
    label: '문서/코드 빠른 처리',
    modelName: 'gpt-4.1-mini',
    description: '긴 문서 정리와 코드 검토',
  },
  {
    value: 'high-accuracy',
    label: '정확도 우선 분석',
    modelName: 'gpt-4.1',
    description: '비교, 의사결정, 복잡한 추론',
  },
];

export const QUICK_ACTIONS = [
  {
    id: 'summary',
    label: '페이지 요약',
    prompt: '현재 페이지의 핵심 내용을 5줄 이내로 요약해줘.',
  },
  {
    id: 'explain',
    label: '쉽게 설명',
    prompt: '현재 페이지에서 어려운 개념을 찾아 쉬운 말로 설명해줘.',
  },
  {
    id: 'compare',
    label: '비교 정리',
    prompt: '현재 페이지 내용을 업무 의사결정에 필요한 비교 포인트로 정리해줘.',
  },
  {
    id: 'draft',
    label: '답변 초안',
    prompt: '현재 페이지 맥락을 바탕으로 업무용 답변 초안을 작성해줘.',
  },
] as const;

export const DEFAULT_AI_SETTINGS: AppSettings = {
  modelType: 'openai',
  endpoint: DEFAULT_API_ENDPOINT,
  apiKey: '',
  modelName: DEFAULT_MODEL_NAME,
  modelUseCase: 'kms',
  sharePageContext: true,
  compactMode: false,
  permissionMode: 'scoped',
  planMode: false,
} as const;
