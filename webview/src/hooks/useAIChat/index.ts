import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAtom } from 'jotai';
import { useEffect } from 'react';
import { checkAPIConnection, streamOpenAIChatCompletion } from '../../services/openai';
import { hasCheckedConnectionAtom, isConnectedAtom, messagesAtom } from '../../atoms/chatAtoms';
import type { ImageAttachment, Message } from '../../types/message';
import { useSettings } from '../useSettings';

const getExtensionStorage = () =>
  typeof chrome !== 'undefined' && chrome.storage?.onChanged ? chrome.storage : undefined;

export const useAIChat = () => {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useAtom(messagesAtom);
  const [isConnected, setIsConnected] = useAtom(isConnectedAtom);
  const [hasCheckedConnection, setHasCheckedConnection] = useAtom(hasCheckedConnectionAtom);
  const { getAPISettings } = useSettings();

  useEffect(() => {
    if (hasCheckedConnection) {
      return;
    }

    const checkConnection = async () => {
      try {
        const connected = await checkAPIConnection(getAPISettings());
        setIsConnected(connected);
      } catch (error) {
        console.error('Connection check error:', error);
        setIsConnected(false);
      } finally {
        setHasCheckedConnection(true);
      }
    };

    const timer = window.setTimeout(checkConnection, 100);

    return () => window.clearTimeout(timer);
  }, [getAPISettings, hasCheckedConnection, setHasCheckedConnection, setIsConnected]);

  useEffect(() => {
    const storage = getExtensionStorage();

    if (!storage) {
      return;
    }

    const handleStorageChange = async (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (!changes.settings) {
        return;
      }

      setIsConnected(null);
      const connected = await checkAPIConnection(getAPISettings());
      setIsConnected(connected);
    };

    storage.onChanged.addListener(handleStorageChange);
    return () => storage.onChanged.removeListener(handleStorageChange);
  }, [getAPISettings, setIsConnected]);

  useEffect(() => {
    const interval = window.setInterval(async () => {
      if (hasCheckedConnection) {
        const connected = await checkAPIConnection(getAPISettings());
        setIsConnected(connected);
      }
    }, 30000);

    return () => window.clearInterval(interval);
  }, [getAPISettings, hasCheckedConnection, setIsConnected]);

  const mutation = useMutation({
    mutationFn: async (newMessages: Message[]) => {
      const assistantMessageId = (Date.now() + 1).toString();

      setMessages((prev) => [
        ...prev,
        {
          id: assistantMessageId,
          role: 'assistant',
          content: '',
          isStreaming: true,
          timestamp: new Date(),
        },
      ]);

      try {
        await streamOpenAIChatCompletion(newMessages, getAPISettings(), (chunk) => {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantMessageId
                ? { ...message, content: message.content + chunk }
                : message,
            ),
          );
        });

        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantMessageId ? { ...message, isStreaming: false } : message,
          ),
        );
      } catch (error) {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantMessageId
              ? {
                  ...message,
                  content: `Error: ${
                    /* v8 ignore next */
                    error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.'
                  }`,
                  isStreaming: false,
                }
              : message,
          ),
        );
        throw error;
      } finally {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantMessageId ? { ...message, isStreaming: false } : message,
          ),
        );
      }
    },
    onSuccess: () => {
      setIsConnected(true);
      queryClient.invalidateQueries({ queryKey: ['messages'] });
    },
    onError: (error) => {
      console.error('AI Chat Error:', error);
      setIsConnected(false);
    },
  });

  const sendMessage = (input: string, attachments: ImageAttachment[] = [], pageContext?: string) => {
    const userText = input.trim();

    if (!userText && !attachments.length) {
      return;
    }

    /* v8 ignore next */
    const content = userText || '첨부한 이미지를 참고해서 답변해줘.';

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,
      attachments,
      timestamp: new Date(),
    };

    const apiUserMessage: Message = pageContext
      ? {
          ...userMessage,
          content: `${pageContext}\n\n사용자 요청: ${content}`,
        }
      : userMessage;

    setMessages([...messages, userMessage]);
    mutation.mutate([...messages, apiUserMessage]);
  };

  return {
    sendMessage,
    isLoading: mutation.isPending,
    isConnected: isConnected as boolean | null,
  };
};
