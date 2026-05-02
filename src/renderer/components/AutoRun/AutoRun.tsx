import {
	useState,
	useRef,
	useEffect,
	useCallback,
	memo,
	forwardRef,
	useImperativeHandle,
} from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSlug from 'rehype-slug';
import { AutoRunnerHelpModal } from './AutoRunnerHelpModal';
// Module-level constant — react-markdown re-parses the document if rehypePlugins
// changes by reference, so the array must be hoisted out of render.
const REHYPE_PLUGINS = [rehypeSlug];
import { ResetTasksConfirmModal } from '../ResetTasksConfirmModal';
import { AutoRunDocumentSelector } from './AutoRunDocumentSelector';
import { AutoRunLightbox } from './AutoRunLightbox';
import { AutoRunSearchBar } from './AutoRunSearchBar';
import { AutoRunToolbar } from './AutoRunToolbar';
import { AutoRunErrorBanner } from './AutoRunErrorBanner';
import { AutoRunBottomPanel } from './AutoRunBottomPanel';
import { NoFolderState, EmptyFolderState } from './AutoRunEmptyStates';
import { useBatchStore } from '../../stores/batchStore';
import { AutoRunAttachmentsPanel } from './AutoRunAttachmentsPanel';
import { useTemplateAutocomplete, useAutoRunUndo, useAutoRunImageHandling } from '../../hooks';
import { TemplateAutocompleteDropdown } from '../TemplateAutocompleteDropdown';
import type { AutoRunProps, AutoRunHandle } from './types';
import { useAutoRunContentSync } from '../../hooks/batch/useAutoRunContentSync';
import { useAutoRunSearch } from '../../hooks/batch/useAutoRunSearch';
import { useAutoRunKeyboard } from '../../hooks/batch/useAutoRunKeyboard';
import { useAutoRunMarkdown } from '../../hooks/batch/useAutoRunMarkdown';
import { useAutoRunScrollSync } from '../../hooks/batch/useAutoRunScrollSync';
import { Maximize2, Edit as EditIcon, Eye, Search } from 'lucide-react';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { logger } from '../../utils/logger';
import { useSettingsStore } from '../../stores/settingsStore';
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

	// Track mode before auto-run to restore when it ends
	const modeBeforeAutoRunRef = useRef<'edit' | 'preview' | null>(null);
	const [helpModalOpen, setHelpModalOpen] = useState(false);
	const [resetTasksModalOpen, setResetTasksModalOpen] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const previewRef = useRef<HTMLDivElement>(null);

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

	// Disable Bionify while search is active so search highlights remain visible
	const hasActivePreviewSearch = searchOpen && searchQuery.trim().length > 0;
	const effectivePreviewBionifyReadingMode = bionifyReadingMode && !hasActivePreviewSearch;

	// Markdown rendering: prose styles, task counts, token count, remark plugins, components
	const { proseStyles, taskCounts, tokenCount, remarkPlugins, markdownComponents } =
		useAutoRunMarkdown({
			theme,
			savedContent,
			folderPath,
			sshRemoteId,
			documentTree,
			onSelectDocument,
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
		});

	// Keep the document selector badge in sync with the bottom-panel counter.
	// The file watcher's refresh path can be stale (debounced/missed events, SSH poll lag),
	// but savedContent for the selected doc is always authoritative — mirror it into the store.
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
				// Cmd+Shift+E is allowed to propagate to global handler for "Toggle Auto Run Expanded"
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
								className={`w-full h-full border rounded p-4 bg-transparent outline-none resize-none font-mono text-sm ${isLocked ? 'cursor-not-allowed opacity-70' : ''}`}
								style={{
									borderColor: isLocked ? theme.colors.warning : theme.colors.border,
									color: theme.colors.textMain,
									backgroundColor: isLocked ? theme.colors.bgActivity + '30' : 'transparent',
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
								// Cmd+Shift+E is allowed to propagate to global handler for "Toggle Auto Run Expanded"
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
								fontSize: '13px',
							}}
						>
							<style>{proseStyles}</style>
							<ReactMarkdown
								remarkPlugins={remarkPlugins}
								rehypePlugins={REHYPE_PLUGINS}
								components={markdownComponents}
							>
								{localContent || '*No content yet. Switch to Edit mode to start writing.*'}
							</ReactMarkdown>
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
				</div>
			)}

			{/* Bottom Panel - shown when folder selected AND (there are tasks, unsaved changes, or content with token count) */}
			{folderPath && (taskCounts.total > 0 || (isDirty && !isLocked) || tokenCount !== null) && (
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
