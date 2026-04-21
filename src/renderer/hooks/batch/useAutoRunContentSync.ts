import { useState, useRef, useEffect, useCallback } from 'react';
import { logger } from '../../utils/logger';

export interface UseAutoRunContentSyncParams {
	content: string;
	sessionId: string;
	selectedFile: string | null;
	contentVersion?: number;
	folderPath: string | null;
	sshRemoteId?: string;
	externalLocalContent?: string;
	onExternalLocalContentChange?: (content: string) => void;
	externalSavedContent?: string;
	onExternalSavedContentChange?: (content: string) => void;
}

export interface UseAutoRunContentSyncReturn {
	localContent: string;
	setLocalContent: (content: string) => void;
	savedContent: string;
	setSavedContent: (content: string) => void;
	isDirty: boolean;
	handleSave: () => Promise<void>;
	handleRevert: () => void;
}

export function useAutoRunContentSync({
	content,
	sessionId,
	selectedFile,
	contentVersion = 0,
	folderPath,
	sshRemoteId,
	externalLocalContent,
	onExternalLocalContentChange,
	externalSavedContent,
	onExternalSavedContentChange,
}: UseAutoRunContentSyncParams): UseAutoRunContentSyncReturn {
	// Local content state for responsive typing
	// Always use internal state for immediate feedback, but sync with external state when provided
	// On initial mount, prefer external state if provided (for restoring draft from shared state)
	const [internalLocalContent, setInternalLocalContent] = useState(
		externalLocalContent !== undefined ? externalLocalContent : content
	);

	// Use refs for external callbacks to ensure stable callback identity
	const externalLocalContentChangeRef = useRef(onExternalLocalContentChange);
	externalLocalContentChangeRef.current = onExternalLocalContentChange;

	// Sync internal state FROM external state when external state changes
	// This handles: opening expanded modal with existing draft, or panel receiving updates from modal
	const prevExternalLocalContentRef = useRef(externalLocalContent);
	useEffect(() => {
		if (
			externalLocalContent !== undefined &&
			externalLocalContent !== prevExternalLocalContentRef.current &&
			externalLocalContent !== internalLocalContent
		) {
			setInternalLocalContent(externalLocalContent);
		}
		prevExternalLocalContentRef.current = externalLocalContent;
	}, [externalLocalContent, internalLocalContent]);

	// Always use internal state for display (provides immediate feedback)
	const localContent = internalLocalContent;

	const setLocalContent = useCallback((newContent: string) => {
		// Always update internal state for immediate feedback
		setInternalLocalContent(newContent);
		// Also propagate to external callback if provided (for sharing with expanded modal)
		if (externalLocalContentChangeRef.current) {
			externalLocalContentChangeRef.current(newContent);
		}
	}, []); // Empty deps - uses ref for external callback

	// Track the saved content to detect dirty state (unsaved changes)
	// On initial mount, prefer external state if provided
	const [internalSavedContent, setInternalSavedContent] = useState(
		externalSavedContent !== undefined ? externalSavedContent : content
	);

	// Use refs for external callbacks to ensure stable callback identity
	const externalSavedContentChangeRef = useRef(onExternalSavedContentChange);
	externalSavedContentChangeRef.current = onExternalSavedContentChange;

	// Sync internal saved state FROM external state when external state changes
	const prevExternalSavedContentRef = useRef(externalSavedContent);
	useEffect(() => {
		if (
			externalSavedContent !== undefined &&
			externalSavedContent !== prevExternalSavedContentRef.current &&
			externalSavedContent !== internalSavedContent
		) {
			setInternalSavedContent(externalSavedContent);
		}
		prevExternalSavedContentRef.current = externalSavedContent;
	}, [externalSavedContent, internalSavedContent]);

	// Always use internal state for saved content comparison
	const savedContent = internalSavedContent;

	const setSavedContent = useCallback((newContent: string) => {
		// Always update internal state
		setInternalSavedContent(newContent);
		// Also propagate to external callback if provided
		if (externalSavedContentChangeRef.current) {
			externalSavedContentChangeRef.current(newContent);
		}
	}, []); // Empty deps - uses ref for external callback

	// Dirty state: true when localContent differs from savedContent
	const isDirty = localContent !== savedContent;

	// Track previous session/document to detect switches
	const prevSessionIdRef = useRef(sessionId);
	const prevSelectedFileRef = useRef(selectedFile);
	const prevContentVersionRef = useRef(contentVersion);

	// Sync local content when session/document changes or external file changes
	useEffect(() => {
		const sessionChanged = sessionId !== prevSessionIdRef.current;
		const documentChanged = selectedFile !== prevSelectedFileRef.current;
		const versionChanged = contentVersion !== prevContentVersionRef.current;

		if (sessionChanged || documentChanged || versionChanged) {
			// Reset to the new content from props (discard any unsaved changes)
			setLocalContent(content);
			setSavedContent(content);
			prevSessionIdRef.current = sessionId;
			prevSelectedFileRef.current = selectedFile;
			prevContentVersionRef.current = contentVersion;
		}
	}, [sessionId, selectedFile, contentVersion, content, setLocalContent, setSavedContent]);

	// Save function - writes to disk
	// Note: We do NOT call handleContentChange here because it would update the
	// activeSession's content, which may be a different session than the one we're
	// editing (during rapid session switches). The file watcher will pick up the
	// change and update the correct session's content.
	const handleSave = useCallback(async () => {
		if (!folderPath || !selectedFile || !isDirty) return;

		try {
			await (window as any).maestro.autorun.writeDoc(
				folderPath,
				selectedFile + '.md',
				localContent,
				sshRemoteId
			);
			setSavedContent(localContent);
		} catch (err) {
			logger.error('Failed to save:', undefined, err);
		}
	}, [folderPath, selectedFile, localContent, isDirty, setSavedContent, sshRemoteId]);

	// Revert function - discard changes
	const handleRevert = useCallback(() => {
		setLocalContent(savedContent);
	}, [savedContent, setLocalContent]);

	return {
		localContent,
		setLocalContent,
		savedContent,
		setSavedContent,
		isDirty,
		handleSave,
		handleRevert,
	};
}
