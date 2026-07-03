import { getVsCodeApi } from '../vscode';
import type { APISettings } from '../hooks/useSettings';
import type { Message } from '../types/message';

type ChatBridgeMessage =
  | { type: 'chatChunk'; requestId: string; value: string }
  | { type: 'chatDone'; requestId: string }
  | { type: 'chatError'; requestId: string; value: string };

type PendingChatRequest = {
  onChunk: (chunk: string) => void;
  resolve: () => void;
  reject: (error: Error) => void;
};

const pendingRequests = new Map<string, PendingChatRequest>();

let bridgeInitialized = false;

function initializeBridge() {
  if (bridgeInitialized) {
    return;
  }

  bridgeInitialized = true;
  window.addEventListener('message', (event: MessageEvent<ChatBridgeMessage>) => {
    const message = event.data;

    if (!message || !('requestId' in message)) {
      return;
    }

    const pendingRequest = pendingRequests.get(message.requestId);

    if (!pendingRequest) {
      return;
    }

    if (message.type === 'chatChunk') {
      pendingRequest.onChunk(message.value);
      return;
    }

    pendingRequests.delete(message.requestId);

    if (message.type === 'chatDone') {
      pendingRequest.resolve();
      return;
    }

    pendingRequest.reject(new Error(message.value || 'Model request failed.'));
  });
}

function createRequestId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const checkAPIConnection = async (_settings?: APISettings): Promise<boolean> => true;

export const createOpenAIChatCompletion = async (
  messages: Message[],
  settings: APISettings | undefined,
): Promise<string> => {
  let content = '';

  await streamOpenAIChatCompletion(messages, settings, (chunk) => {
    content += chunk;
  });

  return content;
};

export const streamOpenAIChatCompletion = async (
  messages: Message[],
  settings: APISettings | undefined,
  onChunk: (chunk: string) => void,
): Promise<void> => {
  initializeBridge();

  const requestId = createRequestId();
  const vscode = getVsCodeApi();

  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { onChunk, resolve, reject });
    vscode.postMessage({
      type: 'chatRequest',
      requestId,
      messages,
      settings,
    });
  });
};
