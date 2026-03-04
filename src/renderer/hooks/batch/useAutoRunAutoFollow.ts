import { useState, useRef, useEffect } from 'react';
import type { BatchRunState, RightPanelTab } from '../../types';

export interface UseAutoRunAutoFollowDeps {
	currentSessionBatchState: BatchRunState | null | undefined;
	onAutoRunSelectDocument: (filename: string) => void | Promise<void>;
	selectedFile: string | null;
	setActiveRightTab: (tab: RightPanelTab) => void;
	rightPanelOpen: boolean;
	setRightPanelOpen?: (open: boolean) => void;
	toggleRightPanel?: () => void;
	onAutoRunModeChange?: (mode: 'edit' | 'preview') => void;
	currentMode?: 'edit' | 'preview';
}

export interface UseAutoRunAutoFollowReturn {
	autoFollowEnabled: boolean;
	setAutoFollowEnabled: (enabled: boolean) => void;
}

export function useAutoRunAutoFollow(deps: UseAutoRunAutoFollowDeps): UseAutoRunAutoFollowReturn {
	const {
		currentSessionBatchState,
		onAutoRunSelectDocument,
		selectedFile,
		setActiveRightTab,
		rightPanelOpen,
		setRightPanelOpen,
		onAutoRunModeChange,
		currentMode,
	} = deps;

	const [autoFollowEnabled, setAutoFollowEnabled] = useState(false);
	const prevBatchDocIndexRef = useRef<number>(-1);
	const prevIsRunningRef = useRef<boolean>(false);

	useEffect(() => {
		const isRunning = currentSessionBatchState?.isRunning ?? false;
		const currentDocumentIndex = currentSessionBatchState?.currentDocumentIndex ?? -1;
		const documents = currentSessionBatchState?.documents;

		// Detect batch start
		const batchJustStarted = isRunning && !prevIsRunningRef.current;

		// Detect document transition
		const docChanged = currentDocumentIndex !== prevBatchDocIndexRef.current;

		// Auto-follow on batch start or document transition
		if (autoFollowEnabled && (batchJustStarted || docChanged)) {
			const activeDoc = documents?.[currentDocumentIndex];
			if (activeDoc && activeDoc !== selectedFile) {
				onAutoRunSelectDocument(activeDoc);
			}
		}

		// On batch start with auto-follow: switch to autorun tab, open panel, switch to preview mode
		if (autoFollowEnabled && batchJustStarted) {
			setActiveRightTab('autorun');
			if (!rightPanelOpen) {
				setRightPanelOpen?.(true);
			}
			// Switch to preview mode so the user sees rendered markdown with scrolling tasks
			if (currentMode === 'edit') {
				onAutoRunModeChange?.('preview');
			}
		}

		// Reset on batch end
		if (!isRunning) {
			prevBatchDocIndexRef.current = -1;
		} else {
			prevBatchDocIndexRef.current = currentDocumentIndex ?? -1;
		}
		prevIsRunningRef.current = !!isRunning;
	}, [
		currentSessionBatchState?.isRunning,
		currentSessionBatchState?.currentDocumentIndex,
		currentSessionBatchState?.documents,
		autoFollowEnabled,
		onAutoRunSelectDocument,
		selectedFile,
		setActiveRightTab,
		rightPanelOpen,
		setRightPanelOpen,
		onAutoRunModeChange,
		currentMode,
	]);

	return { autoFollowEnabled, setAutoFollowEnabled };
}
