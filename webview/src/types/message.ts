export interface ImageAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  attachments?: ImageAttachment[];
  isStreaming?: boolean;
  read?: boolean;
}
