import {
	useState,
	useRef,
	useEffect,
	useCallback,
	memo,
	useMemo,
	forwardRef,
	useImperativeHandle,
} from 'react';
import ReactMarkdown from 'react-markdown';
import { urlTransformAllowingMaestro } from '../../utils/markdownUrlTransform';
import rehypeSlug from 'rehype-slug';
import { rehypeSourceLine } from '../Markdown/rehypeSourceLine';
import { AutoRunnerHelpModal } from './AutoRunnerHelpModal';
// Module-level constant - react-markdown re-parses the document if rehypePlugins
// changes by reference, so the array must be hoisted out of render.
// rehypeSourceLine runs first so it reads the original source positions before
// any later plugin rewrites the tree. It stamps each task checkbox with the line
// its `- [ ]` marker lives on, which is what makes the box clickable.
const REHYPE_PLUGINS = [rehypeSourceLine, rehypeSlug];

// Memoized ReactMarkdown wrapper. AutoRunInner re-renders on every keystroke in
// the AI input (input state lives in App.tsx and cascades down), and ReactMarkdown
// has no internal memo - re-parsing a 100KB+ doc on each keystroke cost ~170ms
// per keystroke. Shallow-compare so the parse is skipped when content, plugins,
// and components are reference-equal. The hook already memoizes the latter two.
const MemoizedMarkdownPreview = memo(function MemoizedMarkdownPreview(props: {
	content: string;
	remarkPlugins: any[];
	components: any;
}) {
	return (
		<ReactMarkdown
			remarkPlugins={props.remarkPlugins}
			rehypePlugins={REHYPE_PLUGINS}
			urlTransform={urlTransformAllowingMaestro}
			components={props.components}
		>
			{props.content}
		</ReactMarkdown>
	);
});
import { ResetTasksConfirmModal } from '../ResetTasksConfirmModal';
import {
	AutoRunDocumentSelector,
	type AutoRunDocumentSelectorHandle,
} from './AutoRunDocumentSelector';
import { AutoRunLightbox } from './AutoRunLightbox';
import { AutoRunSearchBar } from './AutoRunSearchBar';
import { AutoRunToolbar } from './AutoRunToolbar';
import { AutoRunErrorBanner } from './AutoRunErrorBanner';
import { AutoRunHumanStepBanner } from './AutoRunHumanStepBanner';
import { AutoRunBottomPanel } from './AutoRunBottomPanel';
import { NoFolderState, EmptyFolderState } from './AutoRunEmptyStates';
import { useBatchStore } from '../../stores/batchStore';
import { useThoughtStreamStore, selectActivityCount } from '../../stores/thoughtStreamStore';
import { AutoRunAttachmentsPanel } from './AutoRunAttachmentsPanel';
import { useTemplateAutocomplete, useAutoRunUndo, useAutoRunImageHandling } from '../../hooks';
import { TemplateAutocompleteDropdown } from '../TemplateAutocompleteDropdown';
import type { AutoRunProps, AutoRunHandle } from './types';
import { TextareaLineNumbers, lineNumberGutterMetrics } from '../ui/TextareaLineNumbers';
import { FontScaleControl } from '../ui/FontScaleControl';
import { useFontScale } from '../../hooks/ui/useFontScale';
import { findHumanOnlyTasks } from '../../hooks/batch/batchUtils';
import { toggleTaskCheckboxAtLine } from '../../utils/markdownTasks';
import { useAutoRunContentSync } from '../../hooks/batch/useAutoRunContentSync';
import { useAutoRunSearch } from '../../hooks/batch/useAutoRunSearch';
import { useAutoRunKeyboard } from '../../hooks/batch/useAutoRunKeyboard';
import { useAutoRunMarkdown } from '../../hooks/batch/useAutoRunMarkdown';
import { useSurfaceTypography } from '../../hooks/ui/useSurfaceTypography';
import { useAutoRunScrollSync } from '../../hooks/batch/useAutoRunScrollSync';
import { Maximize2, Edit as EditIcon, Eye, Search, Brain } from 'lucide-react';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { logger } from '../../utils/logger';
import { useSettingsStore } from '../../stores/settingsStore';
import { notifyToast } from '../../stores/notificationStore';
import { useImageAnnotatorStore } from '../ImageAnnotator/imageAnnotatorStore';

// Inner implementation component
const AutoRunInner = forwardRef<AutoRunHandle, AutoRunProps>(function AutoRunInner(
	{
		theme,
		sessionId,
		sshRemoteId,
		folderPath,
		selectedFile,
		documentList,
		documentTree,
		projectFileTree,
		projectRoot,
		onOpenProjectFile,
		content,
		onContentChange,
		contentVersion = 0, // Used to force-sync on external file changes
		externalLocalContent,
		onExternalLocalContentChange,
		externalSavedContent,
		onExternalSavedContentChange,
		mode: externalMode,
		onModeChange,
		initialCursorPosition = 0,
		initialEditScrollPos = 0,
		initialPreviewScrollPos = 0,
		onStateChange,
		onOpenSetup,
		onRefresh,
		onSelectDocument,
		onCreateDocument,
		isLoadingDocuments = false,
		documentTaskCounts,
		batchRunState,
		onOpenBatchRunner,
		onStopBatchRun,
		autoFollowEnabled,
		// Error handling callbacks (Phase 5.10)
		onSkipCurrentDocument: _onSkipCurrentDocument,
		onAbortBatchOnError,
		onResumeAfterError,
		sessionState,
		onExpand,
		onOpenMarketplace,
		onLaunchWizard,
		shortcuts,
		hideTopControls = false,
		showLineNumbers = false,
		onShowFlash,
	},
	ref
) {
	// Only lock the editor when Auto Run is running WITHOUT a worktree (directly on main repo)
	// AND only for documents that are part of the current Auto Run
	// Documents not in the Auto Run can still be edited
	const isLocked =
		(batchRunState?.isRunning &&
			!batchRunState?.worktreeActive &&
			selectedFile !== null &&
			batchRunState?.lockedDocuments?.includes(selectedFile)) ||
		false;
	const isAgentBusy = sessionState === 'busy' || sessionState === 'connecting';
	const isAutoRunActive = batchRunState?.isRunning || false;
	const isRunningRef = useRef(isAutoRunActive);
	useEffect(() => {
		isRunningRef.current = isAutoRunActive;
	}, [isAutoRunActive]);
	const isStopping = batchRunState?.isStopping || false;

	// Thought Stream reopen affordance. While a run is active the brain /
	// "View Thoughts" button lives on the Right Panel's active-run card, but that
	// card is gated on `isRunning` and disappears once the run completes - which
	// is exactly when someone wants to read back why the run did what it did.
	// The buffer outlives the run, so once the run is done we surface the entry
	// point here for as long as there is something buffered to read.
	const thoughtStreamSessionId = useThoughtStreamStore((s) => s.panelSessionId);
	const openThoughtStream = useThoughtStreamStore((s) => s.openPanel);
	// Reasoning AND tool calls: a run that only acted and never narrated still
	// has a feed worth reopening, so this gate must not be thoughts-only.
	const bufferedActivity = useThoughtStreamStore(selectActivityCount(sessionId));
	const showOpenThoughtStream =
		!isAutoRunActive && bufferedActivity > 0 && thoughtStreamSessionId !== sessionId;
	// Error state (Phase 5.10)
	// Subscribe directly to the Zustand store to bypass the multi-hop prop chain
	// (store → useBatchProcessor → useBatchHandlers → App → RightPanel → AutoRun)
	// which drops errorPaused updates via updateBatchStateAndBroadcast/UPDATE_PROGRESS.
	const isErrorPaused = useBatchStore(
		useCallback((s) => s.batchRunStates[sessionId]?.errorPaused ?? false, [sessionId])
	);
	const batchError = useBatchStore(
		useCallback((s) => s.batchRunStates[sessionId]?.error, [sessionId])
	);
	const errorDocumentName =
		batchRunState?.errorDocumentIndex !== undefined
			? batchRunState.documents[batchRunState.errorDocumentIndex]
			: undefined;

	// Use external mode if provided, otherwise use local state
	const [localMode, setLocalMode] = useState<'edit' | 'preview'>(externalMode || 'edit');
	const mode = externalMode || localMode;
	const setMode = useCallback(
		(newMode: 'edit' | 'preview') => {
			if (onModeChange) {
				onModeChange(newMode);
			} else {
				setLocalMode(newMode);
			}
		},
		[onModeChange]
	);

	// Use onContentChange if provided, otherwise no-op
	const handleContentChange = onContentChange || (() => {});

	// Content sync: manages local/saved state, external sync for expanded modal, save/revert
	const {
		localContent,
		setLocalContent,
		savedContent,
		setSavedContent,
		isDirty,
		handleSave,
		handleRevert,
	} = useAutoRunContentSync({
		content,
		sessionId,
		selectedFile,
		contentVersion,
		folderPath,
		sshRemoteId,
		externalLocalContent,
		onExternalLocalContentChange,
		externalSavedContent,
		onExternalSavedContentChange,
	});

	// Unchecked tasks that read as human-only steps. Auto Run would dispatch
	// these to an agent that cannot finish them, so the run stalls. Warn while
	// the author still has the document open, before they hit Run.
	const humanOnlyTasks = useMemo(() => findHumanOnlyTasks(localContent), [localContent]);

	// Track mode before auto-run to restore when it ends
	const modeBeforeAutoRunRef = useRef<'edit' | 'preview' | null>(null);
	const [helpModalOpen, setHelpModalOpen] = useState(false);
	const [resetTasksModalOpen, setResetTasksModalOpen] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const previewRef = useRef<HTMLDivElement>(null);
	const documentSelectorRef = useRef<AutoRunDocumentSelectorHandle>(null);

	// Move the editor caret to a 0-indexed document line, switching to edit
	// mode first when the user is reading the rendered preview.
	const handleJumpToLine = useCallback(
		(line: number) => {
			setMode('edit');
			const offset = localContent
				.split('\n')
				.slice(0, line)
				.reduce((sum, text) => sum + text.length + 1, 0);
			// Defer so the textarea exists when we came from preview mode.
			requestAnimationFrame(() => {
				const textarea = textareaRef.current;
				if (!textarea) return;
				textarea.focus();
				textarea.setSelectionRange(offset, offset);
				// setSelectionRange does not scroll, so place the line a third of
				// the way down rather than leaving the caret offscreen.
				const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
				textarea.scrollTop = Math.max(0, line * lineHeight - textarea.clientHeight / 3);
			});
		},
		[localContent, setMode]
	);

	// Bionify reading mode (global setting; disabled while search highlights are active)
	const bionifyReadingMode = useSettingsStore((s) => s.bionifyReadingMode);
	const bionifyIntensity = useSettingsStore((s) => s.bionifyIntensity);
	const bionifyAlgorithm = useSettingsStore((s) => s.bionifyAlgorithm);

	// Search state and effects
	const {
		searchOpen,
		searchQuery,
		setSearchQuery,
		currentMatchIndex,
		totalMatches,
		openSearch,
		closeSearch,
		goToNextMatchWithFlag,
		goToPrevMatchWithFlag,
		handleMatchRendered,
	} = useAutoRunSearch({
		localContent,
		mode,
		textareaRef,
		previewRef,
	});

	// Refresh animation state for empty state button
	const [isRefreshingEmpty, setIsRefreshingEmpty] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

	// Scroll sync: switchMode, toggleMode, scroll position preservation
	const { switchMode, toggleMode, handlePreviewScroll } = useAutoRunScrollSync({
		mode,
		setMode,
		textareaRef,
		previewRef,
		localContent,
		searchOpen,
		searchQuery,
		initialCursorPosition,
		initialEditScrollPos,
		initialPreviewScrollPos,
		onStateChange,
	});

	// Template variable autocomplete hook
	const {
		autocompleteState,
		handleKeyDown: handleAutocompleteKeyDown,
		handleChange: handleAutocompleteChange,
		selectVariable,
		closeAutocomplete: _closeAutocomplete,
		autocompleteRef,
	} = useTemplateAutocomplete({
		textareaRef,
		value: localContent,
		onChange: setLocalContent,
	});

	// Undo/Redo functionality hook
	const {
		pushUndoState,
		scheduleUndoSnapshot,
		handleUndo,
		handleRedo,
		resetUndoHistory,
		lastUndoSnapshotRef,
	} = useAutoRunUndo({
		selectedFile,
		localContent,
		setLocalContent,
		textareaRef,
	});

	// Reset undo history when document changes (session or file change)
	useEffect(() => {
		// Reset undo history snapshot to the new content (so first edit creates a proper undo point)
		resetUndoHistory(content);
	}, [selectedFile, sessionId, content, resetUndoHistory]);

	// Reset completed tasks - converts all '- [x]' to '- [ ]'
	const handleResetTasks = useCallback(async () => {
		if (!folderPath || !selectedFile) return;

		// Count how many completed tasks we're resetting
		const completedRegex = /^[\s]*[-*]\s*\[x\]/gim;
		const completedMatches = localContent.match(completedRegex) || [];
		const resetCount = completedMatches.length;

		// Push undo state before resetting
		pushUndoState();

		// Replace all completed checkboxes with unchecked ones
		const resetContent = localContent.replace(/^([\s]*[-*]\s*)\[x\]/gim, '$1[ ]');
		setLocalContent(resetContent);
		lastUndoSnapshotRef.current = resetContent;

		// Auto-save the reset content
		try {
			await window.maestro.autorun.writeDoc(
				folderPath,
				selectedFile + '.md',
				resetContent,
				sshRemoteId
			);
			setSavedContent(resetContent);

			// Show flash notification with the count of reset tasks
			if (onShowFlash && resetCount > 0) {
				onShowFlash(`${resetCount} task${resetCount !== 1 ? 's' : ''} reverted to incomplete`);
			}
		} catch (err) {
			logger.error('Failed to save after reset:', undefined, err);
		}
	}, [
		folderPath,
		selectedFile,
		localContent,
		setLocalContent,
		setSavedContent,
		pushUndoState,
		lastUndoSnapshotRef,
		sshRemoteId,
		onShowFlash,
	]);

	// Latest content, read by the preview's checkbox handler. Keeping it in a ref
	// leaves the toggle callback reference-stable, so the memoized markdown
	// components (and the parse behind them) survive every content change.
	const localContentRef = useRef(localContent);
	useEffect(() => {
		localContentRef.current = localContent;
	}, [localContent]);

	// Tick a task off straight from the rendered preview. Preview is a first-class
	// way to work a playbook, so checking a box must not require a trip through
	// edit mode. Resolves false when nothing was written, which reverts the box.
	const handleToggleTask = useCallback(
		async (line: number): Promise<boolean> => {
			if (!folderPath || !selectedFile) return false;

			const result = toggleTaskCheckboxAtLine(localContentRef.current, line);
			// No task marker on that line: the render is out of step with the
			// source. Leave the document alone rather than rewriting the wrong line.
			if (!result) return false;

			pushUndoState();
			setLocalContent(result.content);
			lastUndoSnapshotRef.current = result.content;

			try {
				await window.maestro.autorun.writeDoc(
					folderPath,
					selectedFile + '.md',
					result.content,
					sshRemoteId
				);
				setSavedContent(result.content);
				return true;
			} catch (err) {
				logger.error('Failed to save toggled task:', undefined, err);
				notifyToast({
					color: 'red',
					title: 'Could not save task',
					message: err instanceof Error ? err.message : String(err),
				});
				return false;
			}
		},
		[
			folderPath,
			selectedFile,
			sshRemoteId,
			setLocalContent,
			setSavedContent,
			pushUndoState,
			lastUndoSnapshotRef,
		]
	);

	// Image handling hook (attachments, paste, upload, lightbox)
	const {
		attachmentsList,
		attachmentPreviews,
		attachmentsExpanded,
		setAttachmentsExpanded,
		lightboxFilename,
		lightboxExternalUrl,
		fileInputRef,
		handlePaste,
		handleFileSelect,
		handleRemoveAttachment,
		replaceAttachment,
		openLightboxByFilename,
		closeLightbox,
		handleLightboxNavigate,
		handleLightboxDelete,
	} = useAutoRunImageHandling({
		folderPath,
		selectedFile,
		localContent,
		setLocalContent,
		handleContentChange,
		isLocked,
		textareaRef,
		pushUndoState,
		lastUndoSnapshotRef,
		sshRemoteId,
	});

	// Open the image annotator for an existing attachment; on save, overwrite the
	// original file in place via replaceAttachment (preserves markdown references).
	const handleAnnotateAttachment = useCallback(
		(filename: string) => {
			const dataUrl = attachmentPreviews.get(filename);
			if (!dataUrl) return;
			useImageAnnotatorStore
				.getState()
				.openAnnotator(dataUrl, (newDataUrl) => replaceAttachment(filename, newDataUrl));
		},
		[attachmentPreviews, replaceAttachment]
	);

	// Helper function to count completed tasks (used by useImperativeHandle before taskCounts is defined)
	const getCompletedTaskCountFromContent = useCallback(() => {
		const completedRegex = /^[\s]*[-*]\s*\[x\]/gim;
		const completedMatches = localContent.match(completedRegex) || [];
		return completedMatches.length;
	}, [localContent]);

	// Expose methods to parent via ref
	useImperativeHandle(
		ref,
		() => ({
			focus: () => {
				// Focus the appropriate element based on current mode
				if (mode === 'edit' && textareaRef.current) {
					textareaRef.current.focus();
				} else if (mode === 'preview' && previewRef.current) {
					previewRef.current.focus();
				}
			},
			switchMode,
			isDirty: () => isDirty,
			save: handleSave,
			revert: handleRevert,
			openResetTasksModal: () => {
				const completedCount = getCompletedTaskCountFromContent();
				if (completedCount > 0 && !isLocked) {
					setResetTasksModalOpen(true);
				}
			},
			getCompletedTaskCount: getCompletedTaskCountFromContent,
			openDocumentSelector: () => documentSelectorRef.current?.open(),
		}),
		[
			mode,
			switchMode,
			isDirty,
			handleSave,
			handleRevert,
			getCompletedTaskCountFromContent,
			isLocked,
		]
	);

	// Auto-switch to preview mode when auto-run starts, restore when it ends
	useEffect(() => {
		if (isLocked) {
			// Auto-run started: save current mode and switch to preview
			modeBeforeAutoRunRef.current = mode;
			if (mode !== 'preview') {
				setMode('preview');
			}
		} else if (modeBeforeAutoRunRef.current !== null) {
			// Auto-run ended: restore previous mode
			setMode(modeBeforeAutoRunRef.current);
			modeBeforeAutoRunRef.current = null;
		}
	}, [isLocked]);

	// Auto-focus the active element after mode change
	useEffect(() => {
		// Skip focus when auto-follow is driving changes during a batch run
		if (autoFollowEnabled && isRunningRef.current) return;

		if (mode === 'edit' && textareaRef.current) {
			textareaRef.current.focus();
		} else if (mode === 'preview' && previewRef.current) {
			previewRef.current.focus();
		}
	}, [mode, autoFollowEnabled]);

	// Handle document selection change - focus the appropriate element
	// Note: Content syncing and editing state reset is handled by the main sync effect above
	// This effect ONLY handles focusing on document change
	const prevFocusSelectedFileRef = useRef(selectedFile);
	useEffect(() => {
		if (!selectedFile) return;

		const isNewDocument = selectedFile !== prevFocusSelectedFileRef.current;
		prevFocusSelectedFileRef.current = selectedFile;

		if (isNewDocument) {
			// Skip focus when auto-follow is driving changes during a batch run
			if (autoFollowEnabled && isRunningRef.current) return;

			// Focus on document change
			requestAnimationFrame(() => {
				if (mode === 'edit' && textareaRef.current) {
					textareaRef.current.focus();
				} else if (mode === 'preview' && previewRef.current) {
					previewRef.current.focus();
				}
			});
		}
	}, [selectedFile, mode, autoFollowEnabled]);

	// Auto-follow: scroll to the first unchecked task when batch is running
	useEffect(() => {
		if (!autoFollowEnabled || !batchRunState?.isRunning || mode !== 'preview') return;

		const timeout = setTimeout(() => {
			// Wait for React to commit new content before querying the DOM
			requestAnimationFrame(() => {
				if (!previewRef.current) return;

				const checkboxes = previewRef.current.querySelectorAll('input[type="checkbox"]');
				if (checkboxes.length === 0) return;
				for (const checkbox of checkboxes) {
					if (!(checkbox as HTMLInputElement).checked) {
						const li = (checkbox as HTMLElement).closest('li');
						if (li) {
							li.scrollIntoView({ behavior: 'smooth', block: 'center' });
						}
						break;
					}
				}
			});
		}, 150);

		return () => clearTimeout(timeout);
	}, [
		batchRunState?.currentDocumentIndex,
		batchRunState?.currentTaskIndex,
		batchRunState?.isRunning,
		autoFollowEnabled,
		mode,
	]);

	// Handle refresh for empty state with animation
	const handleEmptyStateRefresh = useCallback(async () => {
		setIsRefreshingEmpty(true);
		try {
			await onRefresh();
		} finally {
			// Keep spinner visible for at least 500ms for visual feedback
			setTimeout(() => setIsRefreshingEmpty(false), 500);
		}
	}, [onRefresh]);

	// Keyboard handler for textarea (Tab, undo/redo, save, checkbox, list continuation)
	const handleKeyDown = useAutoRunKeyboard({
		localContent,
		setLocalContent,
		textareaRef,
		pushUndoState,
		lastUndoSnapshotRef,
		handleUndo,
		handleRedo,
		isDirty,
		handleSave,
		isLocked,
		toggleMode,
		openSearch,
		handleAutocompleteKeyDown,
	});

	// Font zoom. Reading a rendered document and editing its Markdown source are
	// different jobs at different comfortable sizes, so each mode keeps its own
	// scale rather than sharing one. Both hooks stay mounted so switching modes
	// restores the size that mode was left at.
	const previewFontScale = useFontScale('autoRun.previewFontScale');
	const editFontScale = useFontScale('autoRun.editFontScale');
	const activeFontScale = mode === 'edit' ? editFontScale : previewFontScale;

	// Disable Bionify while search is active so search highlights remain visible
	const hasActivePreviewSearch = searchOpen && searchQuery.trim().length > 0;
	const effectivePreviewBionifyReadingMode = bionifyReadingMode && !hasActivePreviewSearch;

	// Auto Run is a markdown document viewer/editor, so it rides the same two
	// surfaces the File Preview tab does rather than carrying fonts of its own.
	const previewTypography = useSurfaceTypography('filePreview');
	const editorTypography = useSurfaceTypography('fileEditor');

	// Markdown rendering: prose styles, task counts, token count, remark plugins, components
	const { proseStyles, taskCounts, tokenCount, remarkPlugins, markdownComponents } =
		useAutoRunMarkdown({
			theme,
			savedContent,
			folderPath,
			sshRemoteId,
			documentTree,
			onSelectDocument,
			projectFileTree,
			projectRoot,
			onOpenProjectFile,
			searchOpen,
			searchQuery,
			totalMatches,
			currentMatchIndex,
			handleMatchRendered,
			openLightboxByFilename,
			previewRef,
			enableBionifyReadingMode: effectivePreviewBionifyReadingMode,
			bionifyIntensity,
			bionifyAlgorithm,
			// Locked documents belong to the running Auto Run - leave their
			// checkboxes read-only, matching the disabled editor.
			onTaskToggle: isLocked ? undefined : handleToggleTask,
		});

	// Keep the document selector badge in sync with the bottom-panel counter.
	// The file watcher's refresh path can be stale (debounced/missed events, SSH poll lag),
	// but savedContent for the selected doc is always authoritative - mirror it into the store.
	useEffect(() => {
		if (!selectedFile || !savedContent) return;
		useBatchStore.getState().updateTaskCount(selectedFile, taskCounts.completed, taskCounts.total);
	}, [selectedFile, savedContent, taskCounts.completed, taskCounts.total]);

	return (
		<div
			ref={containerRef}
			className="autorun-panel h-full flex flex-col outline-none relative"
			tabIndex={-1}
			onKeyDown={(e) => {
				// CMD+E to toggle edit/preview (without Shift)
				// Cmd+Shift+E is left to the global handler ("Edit Last Queued Message")
				// Skip if edit mode is locked (during Auto Run) - matches button disabled state
				if ((e.metaKey || e.ctrlKey) && e.key === 'e' && !e.shiftKey) {
					e.preventDefault();
					e.stopPropagation();
					if (!isLocked) {
						toggleMode();
					}
				}
				// CMD+F to open search (works in both modes from container)
				// Only intercept Cmd+F (without Shift) - let Cmd+Shift+F propagate to global "Go to Files" handler
				if ((e.metaKey || e.ctrlKey) && e.key === 'f' && !e.shiftKey) {
					e.preventDefault();
					e.stopPropagation();
					openSearch();
				}
			}}
		>
			{/* No folder selected - show setup content inline */}
			{!folderPath && <NoFolderState theme={theme} onOpenSetup={onOpenSetup} />}

			{/* Top controls toolbar - only shown when folder is selected and not hidden */}
			{folderPath && !hideTopControls && (
				<AutoRunToolbar
					theme={theme}
					isAutoRunActive={isAutoRunActive}
					isStopping={isStopping}
					isAgentBusy={isAgentBusy}
					isDirty={isDirty}
					sessionId={sessionId}
					onOpenBatchRunner={onOpenBatchRunner}
					onStopBatchRun={onStopBatchRun}
					onOpenMarketplace={onOpenMarketplace}
					onLaunchWizard={onLaunchWizard}
					onOpenHelp={() => setHelpModalOpen(true)}
					onSave={handleSave}
					fileInputRef={fileInputRef}
					onFileSelect={handleFileSelect}
				/>
			)}

			{/* Document Selector */}
			{folderPath && (
				<div className="px-2 mb-2" data-tour="autorun-document-selector">
					<AutoRunDocumentSelector
						ref={documentSelectorRef}
						theme={theme}
						documents={documentList}
						documentTree={
							documentTree as import('./AutoRunDocumentSelector').DocTreeNode[] | undefined
						}
						selectedDocument={selectedFile}
						onSelectDocument={onSelectDocument}
						onRefresh={onRefresh}
						onChangeFolder={onOpenSetup}
						onCreateDocument={onCreateDocument}
						isLoading={isLoadingDocuments}
						documentTaskCounts={documentTaskCounts}
					/>
				</div>
			)}

			{/* Error Banner (Phase 5.10) - shown when batch is paused due to agent error */}
			{isErrorPaused && batchError && (
				<AutoRunErrorBanner
					theme={theme}
					errorMessage={batchError.message}
					errorDocumentName={errorDocumentName}
					isRecoverable={batchError.recoverable || false}
					onResumeAfterError={onResumeAfterError}
					onAbortBatchOnError={onAbortBatchOnError}
				/>
			)}

			{/* Human-step warning - unchecked tasks no agent can complete */}
			{folderPath && selectedFile && (
				<AutoRunHumanStepBanner
					theme={theme}
					tasks={humanOnlyTasks}
					onSelectLine={isLocked ? undefined : handleJumpToLine}
				/>
			)}

			{/* Attached Images Preview (edit mode) - only when folder selected */}
			{folderPath && mode === 'edit' && (
				<AutoRunAttachmentsPanel
					theme={theme}
					attachmentsList={attachmentsList}
					attachmentPreviews={attachmentPreviews}
					attachmentsExpanded={attachmentsExpanded}
					onToggleExpanded={() => setAttachmentsExpanded(!attachmentsExpanded)}
					onRemoveAttachment={handleRemoveAttachment}
					onImageClick={openLightboxByFilename}
					onAnnotateAttachment={handleAnnotateAttachment}
				/>
			)}

			{/* Content Area - only shown when folder is selected */}
			{folderPath && (
				<div
					className="flex-1 min-h-0 overflow-y-auto mx-2 rounded-lg transition-colors"
					style={{
						backgroundColor: isDirty && !isLocked ? `${theme.colors.warning}08` : 'transparent',
						border:
							isDirty && !isLocked
								? `2px solid ${theme.colors.warning}40`
								: '2px solid transparent',
					}}
				>
					{/* Floating font zoom - the same collapsible "Aa" circle the file
					    preview uses, so zooming a document reads identically whether it
					    is open in a file tab or in this panel. Sticky (not absolute) so
					    it stays pinned while the document scrolls without needing a
					    positioned ancestor, and h-0 so it never displaces the content. */}
					{documentList.length > 0 && (
						<div className="sticky top-2 z-20 h-0 flex items-start justify-end pr-2 pointer-events-none">
							<FontScaleControl
								theme={theme}
								control={activeFontScale}
								variant="floating"
								collapsible
								size="sm"
								target={mode === 'edit' ? 'editor' : 'preview'}
								className="pointer-events-auto"
								testId="autorun-font-scale"
							/>
						</div>
					)}
					{/* Empty folder state - show when folder is configured but has no documents */}
					{documentList.length === 0 && !isLoadingDocuments ? (
						<EmptyFolderState
							theme={theme}
							isRefreshingEmpty={isRefreshingEmpty}
							onRefresh={handleEmptyStateRefresh}
							onOpenSetup={onOpenSetup}
						/>
					) : mode === 'edit' ? (
						<div className="relative w-full h-full">
							{showLineNumbers && (
								<TextareaLineNumbers
									textareaRef={textareaRef}
									value={localContent}
									theme={theme}
									remeasureKey={editFontScale.fontScale}
								/>
							)}
							<textarea
								ref={textareaRef}
								value={localContent}
								onChange={(e) => {
									if (!isLocked) {
										// Schedule undo snapshot with current content before the change
										const previousContent = localContent;
										const previousCursor = textareaRef.current?.selectionStart || 0;
										// Use autocomplete handler to detect "{{" triggers
										handleAutocompleteChange(e);
										scheduleUndoSnapshot(previousContent, previousCursor);
									}
								}}
								onFocus={() => {
									/* no-op, manual save only */
								}}
								onKeyDown={!isLocked ? handleKeyDown : undefined}
								onPaste={handlePaste}
								placeholder="Capture notes, images, and tasks in Markdown. (type {{ for variables)"
								readOnly={isLocked}
								className={`w-full h-full border rounded p-4 bg-transparent outline-none resize-none ${isLocked ? 'cursor-not-allowed opacity-70' : ''}`}
								style={{
									borderColor: isLocked ? theme.colors.warning : theme.colors.border,
									color: theme.colors.textMain,
									// Editing a markdown document, so it follows the File Editor
									// surface - the same setting the file-tab editor uses. The
									// line-number gutter copies these off the live element, so
									// the two cannot drift apart.
									fontFamily: editorTypography.fontFamily,
									// The surface's own size, then the pane's zoom on top of it.
									// The line height rides the font size so zooming in doesn't
									// cram taller glyphs into the old 20px rows.
									fontSize: `${editorTypography.fontSize * editFontScale.fontScale}px`,
									backgroundColor: isLocked ? theme.colors.bgActivity + '30' : 'transparent',
									lineHeight: 1.45,
									...(showLineNumbers
										? { paddingLeft: lineNumberGutterMetrics(localContent).textPaddingLeft }
										: {}),
								}}
							/>
							{/* Template Variable Autocomplete Dropdown */}
							<TemplateAutocompleteDropdown
								ref={autocompleteRef}
								theme={theme}
								state={autocompleteState}
								onSelect={selectVariable}
							/>
						</div>
					) : (
						<div
							ref={previewRef}
							className="border rounded p-4 prose prose-sm max-w-none outline-none"
							tabIndex={0}
							onKeyDown={(e) => {
								// CMD+E to toggle edit/preview (without Shift)
								// Cmd+Shift+E is left to the global handler ("Edit Last Queued Message")
								// Skip if edit mode is locked (during Auto Run) - matches button disabled state
								if ((e.metaKey || e.ctrlKey) && e.key === 'e' && !e.shiftKey) {
									e.preventDefault();
									e.stopPropagation();
									if (!isLocked) {
										toggleMode();
									}
								}
								// Cmd+F to open search in preview mode (without Shift)
								// Cmd+Shift+F is allowed to propagate to global handler for "Go to Files"
								if (e.key === 'f' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
									e.preventDefault();
									e.stopPropagation();
									openSearch();
								}
							}}
							onScroll={handlePreviewScroll}
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
								// This IS a file preview - the same markdown the File Preview tab
								// renders, in a different frame - so it follows that surface's
								// font and size rather than a hard-coded 13px. Tailwind's
								// `prose-sm` pins an absolute rem size, so the explicit size
								// here is what actually wins; everything inside is in `em` and
								// follows, so the pane's zoom carries headings, code, and lists
								// with it.
								fontFamily: previewTypography.fontFamily,
								fontSize: `${previewTypography.fontSize * previewFontScale.fontScale}px`,
							}}
						>
							<style>{proseStyles}</style>
							<MemoizedMarkdownPreview
								remarkPlugins={remarkPlugins}
								components={markdownComponents}
								content={localContent || '*No content yet. Switch to Edit mode to start writing.*'}
							/>
						</div>
					)}
				</div>
			)}

			{/* Search Bar - between content and button bar */}
			{searchOpen && (
				<AutoRunSearchBar
					theme={theme}
					searchQuery={searchQuery}
					onSearchQueryChange={setSearchQuery}
					currentMatchIndex={currentMatchIndex}
					totalMatches={totalMatches}
					onNextMatch={goToNextMatchWithFlag}
					onPrevMatch={goToPrevMatchWithFlag}
					onClose={closeSearch}
				/>
			)}

			{/* Editor Mode Bar - Expand, Edit/Preview toggle below content area */}
			{folderPath && documentList.length > 0 && (
				<div className="flex mx-2 mt-1 mb-1 gap-1 shrink-0">
					{/* Expand button */}
					{onExpand && !hideTopControls && (
						<button
							onClick={onExpand}
							className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors hover:bg-white/10"
							style={{
								color: theme.colors.accent,
								border: `1px solid ${theme.colors.accent}40`,
								backgroundColor: `${theme.colors.accent}15`,
							}}
							title={`Expand to full screen${shortcuts?.toggleAutoRunExpanded ? ` (${formatShortcutKeys(shortcuts.toggleAutoRunExpanded.keys)})` : ''}`}
						>
							<Maximize2 className="w-3 h-3" />
							Expand
						</button>
					)}
					{/* Search button */}
					<button
						onClick={openSearch}
						className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors hover:bg-white/10"
						style={{
							color: theme.colors.accent,
							border: `1px solid ${theme.colors.accent}40`,
							backgroundColor: `${theme.colors.accent}15`,
						}}
						title={`Search (${formatShortcutKeys(['Meta', 'f'])})`}
					>
						<Search className="w-3 h-3" />
						Search
					</button>
					{/* Edit / Preview toggle */}
					<button
						onClick={() => {
							if (mode === 'edit') {
								switchMode('preview');
							} else if (!isLocked) {
								switchMode('edit');
							}
						}}
						disabled={mode === 'preview' && isLocked}
						className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${mode === 'preview' && isLocked ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/10'}`}
						style={{
							color: theme.colors.accent,
							border: `1px solid ${theme.colors.accent}40`,
							backgroundColor: `${theme.colors.accent}15`,
						}}
						title={
							mode === 'edit'
								? 'Switch to preview'
								: isLocked
									? 'Editing disabled while Auto Run active'
									: 'Switch to edit'
						}
					>
						{mode === 'edit' ? (
							<>
								<Eye className="w-3 h-3" />
								Preview
							</>
						) : (
							<>
								<EditIcon className="w-3 h-3" />
								Edit
							</>
						)}
					</button>
					{/* Thought Stream restore: a temporary home for a minimized stream once the run completes and the Right Panel's active-run card (with its brain button) is gone. Vanishes when dismissed via the panel's X (which clears panelSessionId). */}
					{showOpenThoughtStream && (
						<button
							onClick={() => openThoughtStream(sessionId)}
							className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors hover:bg-white/10"
							style={{
								color: theme.colors.accent,
								border: `1px solid ${theme.colors.accent}40`,
								backgroundColor: `${theme.colors.accent}15`,
							}}
							title={`Read this run's ${bufferedActivity} buffered thought${bufferedActivity === 1 ? '' : 's'} and tool call${bufferedActivity === 1 ? '' : 's'}`}
						>
							<Brain className="w-3 h-3" />
							Thoughts
						</button>
					)}
				</div>
			)}

			{/* Bottom Panel - shown when folder selected AND (there are tasks, unsaved
			    changes, or content with token count). Suppressed during goal runs:
			    the active-run card in the Right Panel already shows goal % +
			    rationale, so this footer would only restate it. */}
			{folderPath &&
				!batchRunState?.goalMode &&
				(taskCounts.total > 0 || (isDirty && !isLocked) || tokenCount !== null) && (
					<AutoRunBottomPanel
						theme={theme}
						taskCounts={taskCounts}
						tokenCount={tokenCount}
						isDirty={isDirty}
						isLocked={isLocked}
						onSave={handleSave}
						onRevert={handleRevert}
						onOpenResetTasksModal={() => setResetTasksModalOpen(true)}
					/>
				)}

			{/* Help Modal */}
			{helpModalOpen && (
				<AutoRunnerHelpModal theme={theme} onClose={() => setHelpModalOpen(false)} />
			)}

			{/* Reset Tasks Confirmation Modal */}
			{resetTasksModalOpen && selectedFile && (
				<ResetTasksConfirmModal
					theme={theme}
					documentName={selectedFile}
					completedTaskCount={taskCounts.completed}
					onConfirm={handleResetTasks}
					onClose={() => setResetTasksModalOpen(false)}
				/>
			)}

			{/* Lightbox for viewing images with navigation, copy, and delete */}
			<AutoRunLightbox
				theme={theme}
				attachmentsList={attachmentsList}
				attachmentPreviews={attachmentPreviews}
				lightboxFilename={lightboxFilename}
				lightboxExternalUrl={lightboxExternalUrl}
				onClose={closeLightbox}
				onNavigate={handleLightboxNavigate}
				onDelete={handleLightboxDelete}
				onAnnotate={handleAnnotateAttachment}
			/>
		</div>
	);
});

// Memoized AutoRun component with custom comparison to prevent unnecessary re-renders
export const AutoRun = memo(AutoRunInner, (prevProps, nextProps) => {
	// Only re-render when these specific props actually change
	return (
		prevProps.content === nextProps.content &&
		prevProps.sessionId === nextProps.sessionId &&
		prevProps.mode === nextProps.mode &&
		prevProps.theme === nextProps.theme &&
		// Document state
		prevProps.folderPath === nextProps.folderPath &&
		prevProps.selectedFile === nextProps.selectedFile &&
		prevProps.documentList === nextProps.documentList &&
		prevProps.isLoadingDocuments === nextProps.isLoadingDocuments &&
		// Compare batch run state values, not object reference
		prevProps.batchRunState?.isRunning === nextProps.batchRunState?.isRunning &&
		prevProps.batchRunState?.isStopping === nextProps.batchRunState?.isStopping &&
		prevProps.batchRunState?.currentTaskIndex === nextProps.batchRunState?.currentTaskIndex &&
		prevProps.batchRunState?.totalTasks === nextProps.batchRunState?.totalTasks &&
		// Goal-Driven progress fields drive the bottom-panel goal readout
		prevProps.batchRunState?.goalMode === nextProps.batchRunState?.goalMode &&
		prevProps.batchRunState?.goalProgress === nextProps.batchRunState?.goalProgress &&
		prevProps.batchRunState?.goalIteration === nextProps.batchRunState?.goalIteration &&
		prevProps.batchRunState?.goalRationale === nextProps.batchRunState?.goalRationale &&
		// Error state is read directly from Zustand store (not props), so no comparison needed here.
		// Session state affects UI (busy disables Run button)
		prevProps.sessionState === nextProps.sessionState &&
		// Callbacks are typically stable, but check identity
		prevProps.onContentChange === nextProps.onContentChange &&
		prevProps.onModeChange === nextProps.onModeChange &&
		prevProps.onStateChange === nextProps.onStateChange &&
		prevProps.onOpenBatchRunner === nextProps.onOpenBatchRunner &&
		prevProps.onStopBatchRun === nextProps.onStopBatchRun &&
		prevProps.onOpenSetup === nextProps.onOpenSetup &&
		prevProps.onRefresh === nextProps.onRefresh &&
		prevProps.onSelectDocument === nextProps.onSelectDocument &&
		prevProps.onShowFlash === nextProps.onShowFlash &&
		// UI control props
		prevProps.hideTopControls === nextProps.hideTopControls &&
		// External change detection
		prevProps.contentVersion === nextProps.contentVersion &&
		// Auto-follow state
		prevProps.autoFollowEnabled === nextProps.autoFollowEnabled
		// Note: initialCursorPosition, initialEditScrollPos, initialPreviewScrollPos
		// are intentionally NOT compared - they're only used on mount
		// Note: documentTree is derived from documentList, comparing documentList is sufficient
	);
});
