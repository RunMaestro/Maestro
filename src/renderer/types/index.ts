// Type definitions for Maestro renderer

export type ToolType = 'claude' | 'aider' | 'opencode' | 'terminal';
export type SessionState = 'idle' | 'busy' | 'waiting_input';
export type FileChangeType = 'modified' | 'added' | 'deleted';
export type RightPanelTab = 'files' | 'history' | 'scratchpad';
export type ScratchPadMode = 'raw' | 'preview' | 'wysiwyg';
export type ThemeId = 'dracula' | 'monokai' | 'github-light' | 'solarized-light' | 'nord' | 'tokyo-night' | 'one-light' | 'gruvbox-light';
export type FocusArea = 'sidebar' | 'main' | 'right';
export type LLMProvider = 'openrouter' | 'anthropic' | 'ollama';

export interface Theme {
  id: ThemeId;
  name: string;
  mode: 'light' | 'dark';
  colors: {
    bgMain: string;
    bgSidebar: string;
    bgActivity: string;
    border: string;
    textMain: string;
    textDim: string;
    accent: string;
    accentDim: string;
    accentText: string;
    success: string;
    warning: string;
    error: string;
  };
}

export interface Shortcut {
  id: string;
  label: string;
  keys: string[];
}

export interface FileArtifact {
  path: string;
  type: FileChangeType;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface LogEntry {
  id: string;
  timestamp: number;
  source: 'stdout' | 'stderr' | 'system' | 'user';
  text: string;
  interactive?: boolean;
  options?: string[];
  images?: string[];
}

export interface WorkLogItem {
  id: string;
  title: string;
  description: string;
  timestamp: number;
  relatedFiles?: number;
}

export interface Session {
  id: string;
  groupId?: string;
  name: string;
  toolType: ToolType;
  state: SessionState;
  cwd: string;
  fullPath: string;
  aiLogs: LogEntry[];
  shellLogs: LogEntry[];
  workLog: WorkLogItem[];
  scratchPadContent: string;
  contextUsage: number;
  inputMode: 'terminal' | 'ai';
  pid: number;
  port: number;
  tunnelActive: boolean;
  tunnelUrl?: string;
  changedFiles: FileArtifact[];
  isGitRepo: boolean;
  // File Explorer per-session state
  fileTree: any[];
  fileExplorerExpanded: string[];
  fileExplorerScrollPos: number;
  fileTreeError?: string;
  // Shell state tracking
  shellCwd: string;
  // Command history
  commandHistory: string[];
  // Scratchpad state tracking
  scratchPadCursorPosition?: number;
  scratchPadEditScrollPos?: number;
  scratchPadPreviewScrollPos?: number;
  scratchPadMode?: 'edit' | 'preview';
}

export interface Group {
  id: string;
  name: string;
  emoji: string;
  collapsed: boolean;
}
