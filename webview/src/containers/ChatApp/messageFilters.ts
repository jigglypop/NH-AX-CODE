import type { Message } from '../../types/message';

export type MessageFilter = 'all' | 'user' | 'assistant';

export interface MessageDateTimeRange {
  start: Date | null;
  end: Date | null;
}

const WELCOME_MESSAGE_ID = 'welcome';

const padDatePart = (value: number) => String(value).padStart(2, '0');

export const createEmptyMessageDateTimeRange = (): MessageDateTimeRange => ({
  start: null,
  end: null,
});

export const hasMessageDateTimeRange = (range: MessageDateTimeRange) =>
  Boolean(range.start || range.end);

export const formatMessageDateTimeLabel = (date: Date) =>
  `${date.getFullYear()}.${padDatePart(date.getMonth() + 1)}.${padDatePart(date.getDate())} ${padDatePart(
    date.getHours(),
  )}:00`;

export const formatMessageDateTimeRangeLabel = (range: MessageDateTimeRange) => {
  if (!range.start && !range.end) {
    return '전체 일시';
  }

  if (range.start && range.end) {
    return `${formatMessageDateTimeLabel(range.start)} - ${formatMessageDateTimeLabel(range.end)}`;
  }

  if (range.start) {
    return `${formatMessageDateTimeLabel(range.start)} 이후`;
  }

  return `${formatMessageDateTimeLabel(range.end as Date)} 이전`;
};

export const getHistoryMessages = (messages: Message[]) =>
  messages.filter((message) => message.id !== WELCOME_MESSAGE_ID);

const isMessageInDateTimeRange = (timestamp: Date, range: MessageDateTimeRange) => {
  const time = timestamp.getTime();
  const startTime = range.start?.getTime();
  const endTime = range.end?.getTime();

  return (startTime === undefined || time >= startTime) && (endTime === undefined || time <= endTime);
};

export const filterMessages = (
  messages: Message[],
  messageFilter: MessageFilter,
  dateTimeRange: MessageDateTimeRange,
) => {
  if (messageFilter === 'all' && !hasMessageDateTimeRange(dateTimeRange)) {
    return messages;
  }

  return getHistoryMessages(messages).filter((message) => {
    const matchesRole = messageFilter === 'all' || message.role === messageFilter;
    const matchesDateTime = isMessageInDateTimeRange(message.timestamp, dateTimeRange);

    return matchesRole && matchesDateTime;
  });
};
