import type { ImageAttachment } from '../../types/message';
import type { ModelUseCase } from '../../config/app';
import type { UtilityTool } from '../ChatHeader/types';

export interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  activeTool?: UtilityTool | null;
  appVersion?: string;
  disabled?: boolean;
  isConnected?: boolean | null;
  isSettingsActive?: boolean;
  modelName?: string;
  modelUseCase?: ModelUseCase;
  placeholder?: string;
  imageAttachments?: ImageAttachment[];
  attachmentError?: string;
  canSend?: boolean;
  onSessionReset?: () => void;
  onSelectImages?: (files: FileList | null) => void;
  onModelChange?: (modelName: string, modelUseCase?: ModelUseCase) => void;
  onSettingsClick?: () => void;
  onToolClick?: (tool: UtilityTool) => void;
  onRemoveImage?: (id: string) => void;
}
