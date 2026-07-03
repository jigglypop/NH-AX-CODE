import type { Message } from '../../types/message';

export type ReferenceLinkMockSource = {
  name: string;
  text: string;
};

export const ENABLE_REFERENCE_LINK_MOCK =
  import.meta.env.VITE_ENABLE_REFERENCE_LINK_MOCK !== 'false';

export const REFERENCE_LINK_MOCK_MESSAGE_ID = 'reference-link-mock-assistant';

export const REFERENCE_LINK_MOCK_SOURCES: ReferenceLinkMockSource[] = [
  {
    name: 'reference-link-source-1.txt',
    text: [
      '참조 문서 1',
      '',
      '원문 HTML code 태그 안의 참조 표기는 MarkdownContent에서 참조 링크로 바뀌어야 합니다.',
      '예: <code>참조 1, 2</code>',
    ].join('\n'),
  },
  {
    name: 'reference-link-source-2.txt',
    text: [
      '참조 문서 2',
      '',
      'TS/JS/TSX 코드 블록 안의 <code>참조 1, 2</code> 문자열은 실제 코드 예제로 유지되어야 합니다.',
      '참조 링크 변환은 inline code와 raw HTML code 태그에만 적용됩니다.',
    ].join('\n'),
  },
];

export const REFERENCE_LINK_MOCK_MESSAGES: Message[] = [
  {
    id: 'reference-link-mock-user',
    role: 'user',
    content: '참조 링크 렌더링 예제를 확인해줘.',
    timestamp: new Date(Date.now() - 60_000),
  },
  {
    id: REFERENCE_LINK_MOCK_MESSAGE_ID,
    role: 'assistant',
    content: [
      'raw HTML code 태그도 참조 링크로 동작해야 합니다: <code>참조 1, 2</code>',
      '',
      '아래 TSX 템플릿은 실제 코드 블록이라 그대로 보여야 합니다.',
      '',
      '```tsx',
      'const label = "<code>참조 1, 2</code>";',
      '',
      'export function ReferenceLabel() {',
      '  return <code>{label}</code>;',
      '}',
      '```',
    ].join('\n'),
    timestamp: new Date(),
  },
];
