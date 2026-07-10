import type React from 'react';
import type { Session, Theme, LogEntry, FocusArea, AgentError, QueuedItem } from '../../types';
import type { FileNode } from '../../types/fileTree';
import type Convert from 'ansi-to-html';

/** Structured result from summarizeToolInput for richer rendering */
export interface ToolSummary {
	/** Human-readable description (e.g. Bash description field) */
	description?: string;
	/** Primary content - command text or generic summary */
	detail: string;
}

export interface LogItemProps {
	log: LogEntry;
	index: number;
	isTerminal: boolean;
	isAIMode: boolean;
	theme: Theme;
	fontFamily: string;
	maxOutputLines: number;
	lastUserCommand?: string;
	// Expansion state
	isExpanded: boolean;
	onToggleExpanded: (logId: string) => void;
	// Local filter state
	localFilterQuery: string;
	filterMode: { mode: 'include' | 'exclude'; regex: boolean };
	activeLocalFilter: string | null;
	onToggleLocalFilter: (logId: string) => void;
	onSetLocalFilterQuery: (logId: string, query: string) => void;
	onSetFilterMode: (
		logId: string,
		update: (current: { mode: 'include' | 'exclude'; regex: boolean }) => {
			mode: 'include' | 'exclude';
			regex: boolean;
		}
	) => void;
	onClearLocalFilter: (logId: string) => void;
	// Delete state
	deleteConfirmLogId: string | null;
	onDeleteLog?: (logId: string) => number | null;
	onSetDeleteConfirmLogId: (logId: string | null) => void;
	scrollContainerRef: React.RefObject<HTMLDivElement>;
	// Other callbacks
	setLightboxImage: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
	copyToClipboard: (text: string) => void;
	// ANSI converter
	ansiConverter: Convert;
	// Markdown rendering mode for AI responses (when true, shows raw text)
	markdownEditMode: boolean;
	onToggleMarkdownEditMode: () => void;
	// Replay message callback (AI mode only)
	onReplayMessage?: (text: string, images?: string[]) => void;
	// File linking support
	fileTree?: FileNode[];
	cwd?: string;
	projectRoot?: string;
	onFileClick?: (path: string) => void;
	// SSH remote ID for resolving image/file paths emitted by an agent running
	// on a remote host. Without it, LocalImage reads the path from the local
	// filesystem (which doesn't have the remote file) and the image fails.
	sshRemoteId?: string;
	// Error details callback - receives the specific AgentError from the log entry
	onShowErrorDetails?: (error: AgentError) => void;
	// Save to file callback (AI mode only, non-user messages)
	onSaveToFile?: (text: string) => void;
	// Publish to GitHub Gist (AI mode only, non-user messages, requires gh CLI)
	ghCliAvailable?: boolean;
	onPublishGist?: (text: string, messageId?: string) => void;
	publishedGistUrl?: string;
	// Fork conversation from this message (AI mode only, user messages and AI responses - source 'user' | 'ai' | 'stdout')
	onForkConversation?: (logId: string) => void;
	bionifyReadingMode: boolean;
	bionifyIntensity: number;
	bionifyAlgorithm: string;
	// Message alignment
	userMessageAlignment: 'left' | 'right';
	// Claude mode pill - both passed as primitives so LogItem memo equality stays cheap.
	isClaudeCode: boolean;
	isAdaptiveMode: boolean;
	// Session recovery (session_not_found inline card). Only consumed when
	// log.recoveryAction is set; otherwise these props are ignored.
	sessionId: string;
	onSessionRecover?: (opts: {
		sessionId: string;
		tabId: string;
		lastUserPrompt: string;
		groomContext: boolean;
	}) => void;
	isRecoveringSession?: boolean;
	sessionRecoveryError?: string | null;
}

export interface TerminalOutputProps {
	session: Session;
	theme: Theme;
	fontFamily: string;
	activeFocus: FocusArea;
	outputSearchOpen: boolean;
	outputSearchQuery: string;
	outputSearchRegex: boolean;
	setOutputSearchOpen: (open: boolean) => void;
	setOutputSearchQuery: (query: string) => void;
	setOutputSearchRegex: (regex: boolean) => void;
	setActiveFocus: (focus: FocusArea) => void;
	setLightboxImage: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
	inputRef: React.RefObject<HTMLTextAreaElement>;
	logsEndRef: React.RefObject<HTMLDivElement>;
	maxOutputLines: number;
	onDeleteLog?: (logId: string) => number | null; // Returns the index to scroll to after deletion
	onRemoveQueuedItem?: (itemId: string) => void; // Callback to remove a queued item from execution queue
	onTogglePauseQueuedItem?: (itemId: string) => void; // Callback to toggle held/paused state of a queued item
	onEditQueuedItem?: (itemId: string, patch: { text: string; images: string[] }) => void; // Edit a queued message's text + images
	onReorderQueuedItem?: (fromIndex: number, toIndex: number, tabId?: string) => void; // Reorder a queued item within the active tab's queue
	onForceSendQueuedItem?: (itemId: string) => void; // Callback to Force Send a queued item (parallel execution)
	forcedParallelEnabled?: boolean; // Whether forcedParallelExecution setting is on (gates Force Send button)
	getForceSendContext?: (
		item: QueuedItem
	) => { targetTabBusy: boolean; otherBusyTabs: { id: string; displayName: string }[] } | null;
	onInterrupt?: () => void; // Callback to interrupt the current process
	onScrollPositionChange?: (scrollTop: number) => void; // Callback to save scroll position
	onAtBottomChange?: (isAtBottom: boolean) => void; // Callback when user scrolls to/away from bottom
	initialScrollTop?: number; // Initial scroll position to restore
	markdownEditMode: boolean; // Whether to show raw markdown or rendered markdown for AI responses
	setMarkdownEditMode: (value: boolean) => void; // Toggle markdown mode
	onReplayMessage?: (text: string, images?: string[]) => void; // Replay a user message
	onForkConversation?: (logId: string) => void; // Fork conversation from a specific message
	fileTree?: FileNode[]; // File tree for linking file references
	cwd?: string; // Current working directory for proximity-based matching
	projectRoot?: string; // Project root absolute path for converting absolute paths to relative
	onFileClick?: (path: string) => void; // Callback when a file link is clicked
	onShowErrorDetails?: (error: AgentError) => void; // Callback to show the error modal (for error log entries)
	onFileSaved?: () => void; // Callback when markdown content is saved to file (e.g., to refresh file list)
	userMessageAlignment?: 'left' | 'right'; // User message bubble alignment (default: right)
	ghCliAvailable?: boolean; // Whether gh CLI is available for gist publishing
	onPublishMessageGist?: (text: string, messageId?: string) => void; // Callback to publish a single message as a gist
	onOpenInTab?: (file: {
		path: string;
		name: string;
		content: string;
		sshRemoteId?: string;
	}) => void; // Callback to open saved file in a tab
	// In-place recovery from session_not_found errors. Invoked by the
	// SessionRecoveryCard that renders inside system log entries carrying a
	// `recoveryAction` payload.
	onSessionRecover?: (opts: {
		sessionId: string;
		tabId: string;
		lastUserPrompt: string;
		groomContext: boolean;
	}) => void;
	isRecoveringSession?: boolean;
	sessionRecoveryError?: string | null;
}
