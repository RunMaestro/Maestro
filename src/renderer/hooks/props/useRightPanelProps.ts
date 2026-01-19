/**
 * useRightPanelProps Hook
 *
 * Extracts and memoizes all props for the RightPanel component.
 * This prevents React from re-evaluating ~60 props on every state change
 * in MaestroConsoleInner by only recomputing when actual dependencies change.
 *
 * Key optimization: Uses primitive values in dependency arrays (e.g., session?.id
 * instead of session) to minimize re-renders.
 */

import { useMemo } from 'react';
import type {
	Session,
	Theme,
	Shortcut,
	FocusArea,
	RightPanelTab,
	BatchRunState,
} from '../../types';
import type { FileTreeChanges } from '../../utils/fileExplorer';
import type { DocumentTaskCount } from '../../components/AutoRunDocumentSelector';

/**
 * Dependencies for computing RightPanel props.
 * Separated from the props interface to ensure clear inputs vs outputs.
 */
export interface UseRightPanelPropsDeps {
	// Session & Theme
	activeSession: Session | null;
	theme: Theme;
	shortcuts: Record<string, Shortcut>;

	// Panel state
	rightPanelOpen: boolean;
	rightPanelWidth: number;

	// Tab state
	activeRightTab: RightPanelTab;

	// Focus management
	activeFocus: FocusArea;

	// File explorer state
	fileTreeFilter: string;
	fileTreeFilterOpen: boolean;
	filteredFileTree: any[];
	selectedFileIndex: number;
	previewFile: { name: string; content: string; path: string } | null;
	showHiddenFiles: boolean;

	// Auto Run state
	autoRunDocumentList: string[];
	autoRunDocumentTree:
		| Array<{ name: string; type: 'file' | 'folder'; path: string; children?: unknown[] }>
		| undefined;
	autoRunIsLoadingDocuments: boolean;
	autoRunDocumentTaskCounts: Map<string, DocumentTaskCount> | undefined;

	// Batch processing
	activeBatchRunState: BatchRunState | undefined;
	currentSessionBatchState: BatchRunState | undefined;

	// Document Graph
	lastGraphFocusFilePath: string | undefined;

	// Refs
	fileTreeContainerRef: React.RefObject<HTMLDivElement>;
	fileTreeFilterInputRef: React.RefObject<HTMLInputElement>;

	// Setters (should be stable callbacks)
	setRightPanelOpen: (open: boolean) => void;
	setRightPanelWidth: (width: number) => void;
	setActiveFocus: (focus: FocusArea) => void;
	setFileTreeFilter: (filter: string) => void;
	setFileTreeFilterOpen: (open: boolean) => void;
	setSelectedFileIndex: (index: number) => void;
	setShowHiddenFiles: (value: boolean) => void;
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;

	// Handlers (should be memoized with useCallback)
	handleSetActiveRightTab: (tab: RightPanelTab) => void;
	toggleFolder: (
		path: string,
		activeSessionId: string,
		setSessions: React.Dispatch<React.SetStateAction<Session[]>>
	) => void;
	handleFileClick: (node: any, path: string, activeSession: Session) => Promise<void>;
	expandAllFolders: (
		activeSessionId: string,
		activeSession: Session,
		setSessions: React.Dispatch<React.SetStateAction<Session[]>>
	) => void;
	collapseAllFolders: (
		activeSessionId: string,
		setSessions: React.Dispatch<React.SetStateAction<Session[]>>
	) => void;
	updateSessionWorkingDirectory: (
		activeSessionId: string,
		setSessions: React.Dispatch<React.SetStateAction<Session[]>>
	) => Promise<void>;
	refreshFileTree: (sessionId: string) => Promise<FileTreeChanges | undefined>;
	handleAutoRefreshChange: (interval: number) => void;
	showSuccessFlash: (message: string) => void;

	// Auto Run handlers
	handleAutoRunContentChange: (content: string) => void;
	handleAutoRunModeChange: (mode: 'edit' | 'preview') => void;
	handleAutoRunStateChange: (state: {
		mode: 'edit' | 'preview';
		cursorPosition: number;
		editScrollPos: number;
		previewScrollPos: number;
	}) => void;
	handleAutoRunSelectDocument: (filename: string) => void;
	handleAutoRunCreateDocument: (filename: string) => Promise<boolean>;
	handleAutoRunRefresh: () => void;
	handleAutoRunOpenSetup: () => void;

	// Batch processing handlers
	handleOpenBatchRunner: () => void;
	handleStopBatchRun: (sessionId?: string) => void;
	handleSkipCurrentDocument: () => void;
	handleAbortBatchOnError: () => void;
	handleResumeAfterError: () => void;
	handleJumpToAgentSession: (agentSessionId: string) => void;
	handleResumeSession: (agentSessionId: string) => void;

	// Modal handlers
	handleOpenAboutModal: () => void;
	handleOpenMarketplace: () => void;
	handleLaunchWizardTab: () => void;

	// File linking
	handleMainPanelFileClick: (path: string) => void;

	// Document Graph handlers
	handleFocusFileInGraph: (relativePath: string) => void;
	handleOpenLastDocumentGraph: () => void;
}

/**
 * Hook to compute and memoize RightPanel props.
 *
 * @param deps - All dependencies needed to compute RightPanel props
 * @returns Memoized props object for RightPanel
 */
export function useRightPanelProps(deps: UseRightPanelPropsDeps) {
	return useMemo(
		() => ({
			// Session & Theme
			session: deps.activeSession,
			theme: deps.theme,
			shortcuts: deps.shortcuts,

			// Panel state
			rightPanelOpen: deps.rightPanelOpen,
			setRightPanelOpen: deps.setRightPanelOpen,
			rightPanelWidth: deps.rightPanelWidth,
			setRightPanelWidthState: deps.setRightPanelWidth,

			// Tab state
			activeRightTab: deps.activeRightTab,
			setActiveRightTab: deps.handleSetActiveRightTab,

			// Focus management
			activeFocus: deps.activeFocus,
			setActiveFocus: deps.setActiveFocus,

			// File explorer state & handlers
			fileTreeFilter: deps.fileTreeFilter,
			setFileTreeFilter: deps.setFileTreeFilter,
			fileTreeFilterOpen: deps.fileTreeFilterOpen,
			setFileTreeFilterOpen: deps.setFileTreeFilterOpen,
			filteredFileTree: deps.filteredFileTree,
			selectedFileIndex: deps.selectedFileIndex,
			setSelectedFileIndex: deps.setSelectedFileIndex,
			previewFile: deps.previewFile,
			fileTreeContainerRef: deps.fileTreeContainerRef,
			fileTreeFilterInputRef: deps.fileTreeFilterInputRef,

			// File explorer handlers
			toggleFolder: deps.toggleFolder,
			handleFileClick: deps.handleFileClick,
			expandAllFolders: deps.expandAllFolders,
			collapseAllFolders: deps.collapseAllFolders,
			updateSessionWorkingDirectory: deps.updateSessionWorkingDirectory,
			refreshFileTree: deps.refreshFileTree,
			setSessions: deps.setSessions,
			onAutoRefreshChange: deps.handleAutoRefreshChange,
			onShowFlash: deps.showSuccessFlash,
			showHiddenFiles: deps.showHiddenFiles,
			setShowHiddenFiles: deps.setShowHiddenFiles,

			// Auto Run props
			autoRunDocumentList: deps.autoRunDocumentList,
			autoRunDocumentTree: deps.autoRunDocumentTree,
			autoRunContent: deps.activeSession?.autoRunContent || '',
			autoRunContentVersion: deps.activeSession?.autoRunContentVersion || 0,
			autoRunIsLoadingDocuments: deps.autoRunIsLoadingDocuments,
			autoRunDocumentTaskCounts: deps.autoRunDocumentTaskCounts,
			onAutoRunContentChange: deps.handleAutoRunContentChange,
			onAutoRunModeChange: deps.handleAutoRunModeChange,
			onAutoRunStateChange: deps.handleAutoRunStateChange,
			onAutoRunSelectDocument: deps.handleAutoRunSelectDocument,
			onAutoRunCreateDocument: deps.handleAutoRunCreateDocument,
			onAutoRunRefresh: deps.handleAutoRunRefresh,
			onAutoRunOpenSetup: deps.handleAutoRunOpenSetup,

			// Batch processing props
			batchRunState: deps.activeBatchRunState,
			currentSessionBatchState: deps.currentSessionBatchState,
			onOpenBatchRunner: deps.handleOpenBatchRunner,
			onStopBatchRun: deps.handleStopBatchRun,
			onSkipCurrentDocument: deps.handleSkipCurrentDocument,
			onAbortBatchOnError: deps.handleAbortBatchOnError,
			onResumeAfterError: deps.handleResumeAfterError,
			onJumpToAgentSession: deps.handleJumpToAgentSession,
			onResumeSession: deps.handleResumeSession,
			onOpenSessionAsTab: deps.handleResumeSession,

			// Modal handlers
			onOpenAboutModal: deps.handleOpenAboutModal,
			onOpenMarketplace: deps.handleOpenMarketplace,
			onLaunchWizard: deps.handleLaunchWizardTab,

			// File linking
			onFileClick: deps.handleMainPanelFileClick,

			// Document Graph
			onFocusFileInGraph: deps.handleFocusFileInGraph,
			lastGraphFocusFile: deps.lastGraphFocusFilePath,
			onOpenLastDocumentGraph: deps.handleOpenLastDocumentGraph,
		}),
		[
			// Primitive dependencies for minimal re-computation
			deps.activeSession?.id,
			deps.activeSession?.autoRunContent,
			deps.activeSession?.autoRunContentVersion,
			deps.theme,
			deps.shortcuts,
			deps.rightPanelOpen,
			deps.rightPanelWidth,
			deps.activeRightTab,
			deps.activeFocus,
			deps.fileTreeFilter,
			deps.fileTreeFilterOpen,
			deps.filteredFileTree,
			deps.selectedFileIndex,
			deps.previewFile,
			deps.showHiddenFiles,
			deps.autoRunDocumentList,
			deps.autoRunDocumentTree,
			deps.autoRunIsLoadingDocuments,
			deps.autoRunDocumentTaskCounts,
			deps.activeBatchRunState,
			deps.currentSessionBatchState,
			deps.lastGraphFocusFilePath,
			// Stable callbacks (shouldn't cause re-renders, but included for completeness)
			deps.setRightPanelOpen,
			deps.setRightPanelWidth,
			deps.handleSetActiveRightTab,
			deps.setActiveFocus,
			deps.setFileTreeFilter,
			deps.setFileTreeFilterOpen,
			deps.setSelectedFileIndex,
			deps.setShowHiddenFiles,
			deps.setSessions,
			deps.toggleFolder,
			deps.handleFileClick,
			deps.expandAllFolders,
			deps.collapseAllFolders,
			deps.updateSessionWorkingDirectory,
			deps.refreshFileTree,
			deps.handleAutoRefreshChange,
			deps.showSuccessFlash,
			deps.handleAutoRunContentChange,
			deps.handleAutoRunModeChange,
			deps.handleAutoRunStateChange,
			deps.handleAutoRunSelectDocument,
			deps.handleAutoRunCreateDocument,
			deps.handleAutoRunRefresh,
			deps.handleAutoRunOpenSetup,
			deps.handleOpenBatchRunner,
			deps.handleStopBatchRun,
			deps.handleSkipCurrentDocument,
			deps.handleAbortBatchOnError,
			deps.handleResumeAfterError,
			deps.handleJumpToAgentSession,
			deps.handleResumeSession,
			deps.handleOpenAboutModal,
			deps.handleOpenMarketplace,
			deps.handleLaunchWizardTab,
			deps.handleMainPanelFileClick,
			deps.handleFocusFileInGraph,
			deps.handleOpenLastDocumentGraph,
			// Refs (stable, but included for completeness)
			deps.fileTreeContainerRef,
			deps.fileTreeFilterInputRef,
		]
	);
}
