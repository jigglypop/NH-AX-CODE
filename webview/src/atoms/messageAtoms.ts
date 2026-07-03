import { atom } from 'jotai';
import type { Message } from '../types/message';
import { APP_NAME } from '../config/app';

export const createWelcomeMessage = (): Message => ({
  id: 'welcome',
  role: 'assistant',
  content: `안녕하세요. ${APP_NAME}입니다. 코드 변경, 분석, 문서 참조, 내부망 모델 연동을 도와드릴 수 있습니다.`,
  timestamp: new Date(),
});

export const messagesAtom = atom<Message[]>([
  {
    ...createWelcomeMessage(),
  },
]);

export const inputAtom = atom<string>('');
