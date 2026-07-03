import type { Message } from '../../types/message';
import type { ReferenceLinkTarget } from '../MarkdownContent';

export interface MessageListProps {
  messages: Message[];
  isLoading: boolean;
  referenceLinks?: Record<number, ReferenceLinkTarget>;
  onReferenceLinkClick?: (referenceNumber: number) => void;
  onQuickAction?: (prompt: string) => void;
}
