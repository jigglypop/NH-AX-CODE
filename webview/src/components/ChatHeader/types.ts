export type UtilityTool = 'filter' | 'references' | 'history' | 'mcp';

export interface ChatHeaderProps {
  activeTool: UtilityTool | null;
  appVersion: string;
  isConnected: boolean | null;
  isSettingsActive: boolean;
  modelName: string;
  onSessionReset: () => void;
  onSettingsClick: () => void;
  onToolClick: (tool: UtilityTool) => void;
}
