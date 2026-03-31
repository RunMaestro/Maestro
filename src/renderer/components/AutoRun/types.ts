import type { BatchRunState, SessionState, Theme, Shortcut } from '../../types';
import type { DocumentTaskCount } from './AutoRunDocumentSelector';

export interface AutoRunProps {
	theme: Theme;
	sessionId: string; // Maestro session ID for per-session attachment storage

	// SSH Remote context (for remote sessions)
	sshRemoteId?: string; // SSH remote config ID - when set, all fs/autorun operations use SSH

	// Folder & document state
	folderPath: string | null;
	selectedFile: string | null;
	documentList: string[]; // Filenames without .md
	documentTree?: Array<{
		name: string;
		type: 'file' | 'folder';
		path: string;
		children?: unknown[];
	}>; // Tree structure for subfolders

	// Content state
	content: string;
	onContentChange: (content: string) => void;
	contentVersion?: number; // Incremented on external file changes to force-sync

	// Optional external draft content management (for sharing between panel and expanded modal)
	// When provided, the component uses these instead of internal localContent state
	externalLocalContent?: string;
	onExternalLocalContentChange?: (content: string) => void;
	externalSavedContent?: string;
	onExternalSavedContentChange?: (content: string) => void;

	// Mode state
	mode: 'edit' | 'preview';
	onModeChange: (mode: 'edit' | 'preview') => void;

	// Scroll/cursor state
	initialCursorPosition?: number;
	initialEditScrollPos?: number;
	initialPreviewScrollPos?: number;
	onStateChange?: (state: {
		mode: 'edit' | 'preview';
		cursorPosition: number;
		editScrollPos: number;
		previewScrollPos: number;
	}) => void;

	// Actions
	onOpenSetup: () => void;
	onRefresh: () => void;
	onSelectDocument: (filename: string) => void;
	onCreateDocument: (filename: string) => Promise<boolean>;
	isLoadingDocuments?: boolean;
	documentTaskCounts?: Map<string, DocumentTaskCount>; // Task counts per document path

	// Batch processing props
	batchRunState?: BatchRunState;
	onOpenBatchRunner?: () => void;
	onStopBatchRun?: (sessionId?: string) => void;

	// Auto-follow: when enabled during a batch run, suppresses focus-stealing and scrolls to active task
	autoFollowEnabled?: boolean;
	// Error handling callbacks (Phase 5.10)
	onSkipCurrentDocument?: () => void;
	onAbortBatchOnError?: () => void;
	onResumeAfterError?: () => void;

	// Session state for disabling Run when agent is busy
	sessionState?: SessionState;

	// Expand to modal callback
	onExpand?: () => void;

	// Open marketplace modal
	onOpenMarketplace?: () => void;

	// Launch inline wizard in new tab
	onLaunchWizard?: () => void;

	// Shortcuts for displaying hotkey hints
	shortcuts?: Record<string, Shortcut>;

	// Hide top controls (when rendered in expanded modal with controls in header)
	hideTopControls?: boolean;

	// Flash notification callback (for showing center-screen messages)
	onShowFlash?: (message: string) => void;
}

export interface AutoRunHandle {
	focus: () => void;
	switchMode: (mode: 'edit' | 'preview') => void;
	isDirty: () => boolean;
	save: () => Promise<void>;
	revert: () => void;
	openResetTasksModal: () => void;
	getCompletedTaskCount: () => number;
}
