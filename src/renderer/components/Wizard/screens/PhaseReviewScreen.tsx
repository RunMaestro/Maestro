/**
 * PhaseReviewScreen.tsx
 *
 * Fifth screen of the onboarding wizard - displays generated documents
 * with markdown editor, preview mode, and launch options.
 *
 * Features:
 * - Document selector dropdown to switch between generated documents
 * - Full markdown editor with edit/preview toggle (matching Auto Run interface)
 * - Image attachment support (paste, upload, drag-drop)
 * - Auto-save with debounce
 * - Task count display
 * - "I'm Ready to Go" and "Walk Me Through" action buttons
 * - Keyboard navigation support
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import { Loader2, Rocket, Compass, X } from 'lucide-react';
import type { Theme } from '../../../types';
import { useWizard } from '../WizardContext';
import { AUTO_RUN_FOLDER_NAME } from '../services/phaseGenerator';
import { ScreenReaderAnnouncement } from '../ScreenReaderAnnouncement';
import { DocumentEditor } from '../shared/DocumentEditor';

// Auto-save debounce delay in milliseconds
const AUTO_SAVE_DELAY = 2000;

interface PhaseReviewScreenProps {
	theme: Theme;
	onLaunchSession: (wantsTour: boolean) => Promise<void>;
	/** Analytics callback: Called when wizard completes successfully */
	onWizardComplete?: (
		durationMs: number,
		conversationExchanges: number,
		phasesGenerated: number,
		tasksGenerated: number
	) => void;
	/** Start time of the wizard for duration calculation */
	wizardStartTime?: number;
}

/**
 * Count tasks in markdown content
 */
function countTasks(content: string): number {
	const matches = content.match(/^- \[([ x])\]/gm);
	return matches ? matches.length : 0;
}

/**
 * Main content display after documents are generated
 */
function DocumentReview({
	theme,
	onLaunchSession,
	onWizardComplete,
	wizardStartTime,
}: {
	theme: Theme;
	onLaunchSession: (wantsTour: boolean) => Promise<void>;
	onWizardComplete?: (
		durationMs: number,
		conversationExchanges: number,
		phasesGenerated: number,
		tasksGenerated: number
	) => void;
	wizardStartTime?: number;
}): JSX.Element {
	const { state, setEditedPhase1Content, getPhase1Content, setWantsTour, setCurrentDocumentIndex } =
		useWizard();

	const { generatedDocuments, directoryPath, currentDocumentIndex } = state;
	const currentDoc = generatedDocuments[currentDocumentIndex] || generatedDocuments[0];
	const folderPath = `${directoryPath}/${AUTO_RUN_FOLDER_NAME}`;

	// Local content state for editing - tracks current document
	const [localContent, setLocalContent] = useState(
		currentDocumentIndex === 0 ? getPhase1Content() : currentDoc?.content || ''
	);
	const [mode, setMode] = useState<'edit' | 'preview'>('preview');
	const [attachments, setAttachments] = useState<Array<{ filename: string; dataUrl: string }>>([]);
	// Track which button is launching: 'ready', 'tour', or null (not launching)
	const [launchingButton, setLaunchingButton] = useState<'ready' | 'tour' | null>(null);
	const [launchError, setLaunchError] = useState<string | null>(null);
	// Document dropdown open state - controlled to handle Escape key priority
	const [isDropdownOpen, setIsDropdownOpen] = useState(false);

	// Refs for button focus and editor content
	const readyButtonRef = useRef<HTMLButtonElement>(null);
	const tourButtonRef = useRef<HTMLButtonElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const previewRef = useRef<HTMLDivElement>(null);

	// Auto-save timer ref
	const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const lastSavedContentRef = useRef<string>(localContent);
	const isSavingRef = useRef<boolean>(false);
	const pendingSaveContentRef = useRef<string | null>(null);
	// Track previous document index to detect actual document switches
	const prevDocumentIndexRef = useRef<number>(currentDocumentIndex);

	// Update local content when switching documents
	useEffect(() => {
		const newContent =
			currentDocumentIndex === 0
				? getPhase1Content()
				: generatedDocuments[currentDocumentIndex]?.content || '';
		setLocalContent(newContent);
		lastSavedContentRef.current = newContent;
		// Only reset to preview when actually switching documents, not on every effect run
		if (prevDocumentIndexRef.current !== currentDocumentIndex) {
			setMode('preview');
			prevDocumentIndexRef.current = currentDocumentIndex;
		}
	}, [currentDocumentIndex, generatedDocuments, getPhase1Content]);

	// Handle document selection change
	const handleDocumentSelect = useCallback(
		(index: number) => {
			setCurrentDocumentIndex(index);
		},
		[setCurrentDocumentIndex]
	);

	// Auto-focus the ready button on mount
	useEffect(() => {
		setTimeout(() => {
			readyButtonRef.current?.focus();
		}, 100);
	}, []);

	// Auto-save with debounce and locking to prevent race conditions
	useEffect(() => {
		if (localContent === lastSavedContentRef.current) return;

		if (autoSaveTimeoutRef.current) {
			clearTimeout(autoSaveTimeoutRef.current);
		}

		autoSaveTimeoutRef.current = setTimeout(async () => {
			// If already saving, queue this content for after current save completes
			if (isSavingRef.current) {
				pendingSaveContentRef.current = localContent;
				return;
			}

			if (localContent !== lastSavedContentRef.current && currentDoc) {
				isSavingRef.current = true;
				try {
					await window.maestro.autorun.writeDoc(folderPath, currentDoc.filename, localContent);
					lastSavedContentRef.current = localContent;
					// Only update Phase 1 edited content for first document
					if (currentDocumentIndex === 0) {
						setEditedPhase1Content(localContent);
					}
				} catch (err) {
					console.error('Auto-save failed:', err);
				} finally {
					isSavingRef.current = false;

					// Check if there's pending content to save
					if (
						pendingSaveContentRef.current !== null &&
						pendingSaveContentRef.current !== lastSavedContentRef.current
					) {
						const pendingContent = pendingSaveContentRef.current;
						pendingSaveContentRef.current = null;
						// Trigger another save for pending content
						try {
							isSavingRef.current = true;
							await window.maestro.autorun.writeDoc(
								folderPath,
								currentDoc.filename,
								pendingContent
							);
							lastSavedContentRef.current = pendingContent;
							if (currentDocumentIndex === 0) {
								setEditedPhase1Content(pendingContent);
							}
						} catch (err) {
							console.error('Auto-save (pending) failed:', err);
						} finally {
							isSavingRef.current = false;
						}
					}
				}
			}
		}, AUTO_SAVE_DELAY);

		return () => {
			if (autoSaveTimeoutRef.current) {
				clearTimeout(autoSaveTimeoutRef.current);
			}
		};
	}, [localContent, folderPath, currentDoc, currentDocumentIndex, setEditedPhase1Content]);

	// Handle content change
	const handleContentChange = useCallback((newContent: string) => {
		setLocalContent(newContent);
	}, []);

	// Handle mode change with focus management
	const handleModeChange = useCallback((newMode: 'edit' | 'preview') => {
		setMode(newMode);
		// Focus the appropriate element after mode change
		setTimeout(() => {
			if (newMode === 'edit') {
				textareaRef.current?.focus();
			} else {
				previewRef.current?.focus();
			}
		}, 50);
	}, []);

	// Global keyboard handler - attaches to window in capture phase to intercept
	// events before the LayerStack (which also uses capture phase on window)
	// We need to handle Escape here to close the dropdown before it closes the modal
	useEffect(() => {
		const handleGlobalKeyDown = (e: KeyboardEvent) => {
			// Handle Escape when dropdown is open - close dropdown instead of modal
			if (e.key === 'Escape' && isDropdownOpen) {
				e.preventDefault();
				e.stopPropagation();
				setIsDropdownOpen(false);
				return;
			}

			// Toggle edit/preview with Cmd+E
			if ((e.metaKey || e.ctrlKey) && e.key === 'e' && !e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				handleModeChange(mode === 'edit' ? 'preview' : 'edit');
				return;
			}

			// Cycle through documents with Cmd+Shift+[ and Cmd+Shift+]
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && generatedDocuments.length > 1) {
				if (e.key === '[') {
					e.preventDefault();
					e.stopPropagation();
					// Previous document (wrap around)
					const newIndex =
						currentDocumentIndex === 0 ? generatedDocuments.length - 1 : currentDocumentIndex - 1;
					handleDocumentSelect(newIndex);
					return;
				}
				if (e.key === ']') {
					e.preventDefault();
					e.stopPropagation();
					// Next document (wrap around)
					const newIndex = (currentDocumentIndex + 1) % generatedDocuments.length;
					handleDocumentSelect(newIndex);
					return;
				}
			}
		};

		// Use capture phase at window level - this fires before LayerStackContext's handler
		// since we register after it (registration order matters for same-phase handlers)
		// Actually, we need to be first, so we'll attach directly to the modal element
		window.addEventListener('keydown', handleGlobalKeyDown, true);
		return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
	}, [
		mode,
		handleModeChange,
		currentDocumentIndex,
		generatedDocuments.length,
		handleDocumentSelect,
		isDropdownOpen,
	]);

	// Handle adding attachment
	const handleAddAttachment = useCallback((filename: string, dataUrl: string) => {
		setAttachments((prev) => [...prev, { filename, dataUrl }]);
	}, []);

	// Handle removing attachment
	const handleRemoveAttachment = useCallback(
		async (filename: string) => {
			setAttachments((prev) => prev.filter((a) => a.filename !== filename));

			// Remove from disk
			await window.maestro.autorun.deleteImage(folderPath, filename);

			// Remove markdown reference
			const escapedPath = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const fname = filename.split('/').pop() || filename;
			const escapedFilename = fname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const regex = new RegExp(`!\\[${escapedFilename}\\]\\(${escapedPath}\\)\\n?`, 'g');
			setLocalContent((prev) => prev.replace(regex, ''));
		},
		[folderPath]
	);

	// Handle launch
	const handleLaunch = useCallback(
		async (wantsTour: boolean) => {
			setLaunchingButton(wantsTour ? 'tour' : 'ready');
			setLaunchError(null);
			setWantsTour(wantsTour);

			try {
				// Save final content before launching
				if (currentDoc && localContent !== lastSavedContentRef.current) {
					await window.maestro.autorun.writeDoc(folderPath, currentDoc.filename, localContent);
					if (currentDocumentIndex === 0) {
						setEditedPhase1Content(localContent);
					}
				}

				// Record wizard completion for analytics
				if (onWizardComplete) {
					// Calculate wizard duration
					const durationMs = wizardStartTime ? Date.now() - wizardStartTime : 0;

					// Count conversation exchanges (user messages in the conversation)
					const conversationExchanges = state.conversationHistory.filter(
						(msg) => msg.role === 'user'
					).length;

					// Count phases and tasks generated
					const phasesGenerated = generatedDocuments.length;
					const tasksGenerated = generatedDocuments.reduce(
						(total, doc) => total + countTasks(doc.content),
						0
					);

					onWizardComplete(durationMs, conversationExchanges, phasesGenerated, tasksGenerated);
				}

				await onLaunchSession(wantsTour);
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : 'Failed to launch session';
				setLaunchError(errorMessage);
				setLaunchingButton(null);
			}
		},
		[
			currentDoc,
			currentDocumentIndex,
			localContent,
			folderPath,
			setEditedPhase1Content,
			setWantsTour,
			onLaunchSession,
			onWizardComplete,
			wizardStartTime,
			state.conversationHistory,
			generatedDocuments,
		]
	);

	// Handle keyboard navigation (Tab and Enter for buttons)
	// Note: Cmd+E is handled by the global capture-phase handler above
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			// Tab between buttons
			if (e.key === 'Tab') {
				const focusedElement = document.activeElement;
				if (focusedElement === readyButtonRef.current && !e.shiftKey) {
					e.preventDefault();
					tourButtonRef.current?.focus();
				} else if (focusedElement === tourButtonRef.current && e.shiftKey) {
					e.preventDefault();
					readyButtonRef.current?.focus();
				}
			}
			// Enter to activate focused button
			if (e.key === 'Enter' && !launchingButton) {
				const focusedElement = document.activeElement;
				if (focusedElement === readyButtonRef.current) {
					handleLaunch(false);
				} else if (focusedElement === tourButtonRef.current) {
					handleLaunch(true);
				}
			}
		},
		[handleLaunch, launchingButton]
	);

	// Task count
	const taskCount = countTasks(localContent);
	const totalTasks = generatedDocuments.reduce((sum, doc) => sum + doc.taskCount, 0);

	if (!currentDoc) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<p style={{ color: theme.colors.textDim }}>No documents generated</p>
			</div>
		);
	}

	// Build stats text
	const statsText =
		generatedDocuments.length > 1
			? `${totalTasks} total tasks • ${generatedDocuments.length} documents • ${taskCount} tasks in this document`
			: `${taskCount} tasks ready to run`;

	return (
		<div
			ref={containerRef}
			className="flex flex-col flex-1 min-h-0 outline-none"
			tabIndex={-1}
			onKeyDown={handleKeyDown}
		>
			{/* Document editor - flex to fill available space */}
			<div className="flex-1 min-h-0 flex flex-col px-6 py-4">
				<DocumentEditor
					content={localContent}
					onContentChange={handleContentChange}
					mode={mode}
					onModeChange={handleModeChange}
					folderPath={folderPath}
					selectedFile={currentDoc.filename.replace(/\.md$/, '')}
					attachments={attachments}
					onAddAttachment={handleAddAttachment}
					onRemoveAttachment={handleRemoveAttachment}
					theme={theme}
					isLocked={launchingButton !== null}
					textareaRef={textareaRef}
					previewRef={previewRef}
					documents={generatedDocuments}
					selectedDocIndex={currentDocumentIndex}
					onDocumentSelect={handleDocumentSelect}
					statsText={statsText}
					proseClassPrefix="phase-review"
					isDropdownOpen={isDropdownOpen}
					onDropdownOpenChange={setIsDropdownOpen}
				/>
			</div>

			{/* Error message */}
			{launchError && (
				<div
					className="mx-6 mb-2 px-4 py-2 rounded-lg flex items-center gap-2"
					style={{
						backgroundColor: `${theme.colors.error}20`,
						borderColor: theme.colors.error,
						border: '1px solid',
					}}
				>
					<svg
						className="w-4 h-4 shrink-0"
						fill="none"
						stroke={theme.colors.error}
						viewBox="0 0 24 24"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
						/>
					</svg>
					<span className="text-sm" style={{ color: theme.colors.error }}>
						{launchError}
					</span>
					<button
						onClick={() => setLaunchError(null)}
						className="ml-auto p-1 hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-offset-1 rounded"
						style={{
							color: theme.colors.error,
							['--tw-ring-color' as any]: theme.colors.error,
							['--tw-ring-offset-color' as any]: theme.colors.bgMain,
						}}
					>
						<X className="w-4 h-4" />
					</button>
				</div>
			)}

			{/* Action buttons */}
			<div
				className="px-6 py-4 border-t"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgSidebar,
				}}
			>
				<div className="flex flex-col sm:flex-row gap-3">
					{/* Primary button - Ready to Go */}
					<button
						ref={readyButtonRef}
						onClick={() => handleLaunch(false)}
						disabled={launchingButton !== null}
						className={`flex-1 flex items-center justify-center gap-2 px-6 py-3.5 rounded-lg font-semibold text-base transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 ${
							launchingButton !== null ? 'opacity-70 cursor-not-allowed' : 'hover:scale-[1.02]'
						}`}
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
							boxShadow: `0 4px 14px ${theme.colors.accent}40`,
							['--tw-ring-color' as any]: theme.colors.textMain,
							['--tw-ring-offset-color' as any]: theme.colors.bgSidebar,
						}}
					>
						{launchingButton === 'ready' ? (
							<Loader2 className="w-5 h-5 animate-spin" />
						) : (
							<Rocket className="w-5 h-5" />
						)}
						{launchingButton === 'ready' ? 'Launching...' : "I'm Ready to Go"}
					</button>

					{/* Secondary button - Walk Me Through */}
					<button
						ref={tourButtonRef}
						onClick={() => handleLaunch(true)}
						disabled={launchingButton !== null}
						className={`flex-1 flex items-center justify-center gap-2 px-6 py-3.5 rounded-lg font-medium text-base transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 ${
							launchingButton !== null ? 'opacity-70 cursor-not-allowed' : 'hover:scale-[1.02]'
						}`}
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textMain,
							border: `2px solid ${theme.colors.border}`,
							['--tw-ring-color' as any]: theme.colors.accent,
							['--tw-ring-offset-color' as any]: theme.colors.bgSidebar,
						}}
					>
						{launchingButton === 'tour' ? (
							<Loader2 className="w-5 h-5 animate-spin" />
						) : (
							<Compass className="w-5 h-5" />
						)}
						{launchingButton === 'tour' ? 'Launching...' : 'Walk Me Through the Interface'}
					</button>
				</div>

				{/* Keyboard hints */}
				<div className="mt-4 flex justify-center gap-6 flex-wrap">
					<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
						<kbd
							className="px-1.5 py-0.5 rounded text-xs"
							style={{ backgroundColor: theme.colors.border }}
						>
							⌘E
						</kbd>
						Toggle Edit/Preview
					</span>
					{generatedDocuments.length > 1 && (
						<span
							className="text-xs flex items-center gap-1"
							style={{ color: theme.colors.textDim }}
						>
							<kbd
								className="px-1.5 py-0.5 rounded text-xs"
								style={{ backgroundColor: theme.colors.border }}
							>
								⌘⇧[]
							</kbd>
							Cycle documents
						</span>
					)}
					<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
						<kbd
							className="px-1.5 py-0.5 rounded text-xs"
							style={{ backgroundColor: theme.colors.border }}
						>
							Tab
						</kbd>
						Switch buttons
					</span>
					<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
						<kbd
							className="px-1.5 py-0.5 rounded text-xs"
							style={{ backgroundColor: theme.colors.border }}
						>
							Enter
						</kbd>
						Select
					</span>
					<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
						<kbd
							className="px-1.5 py-0.5 rounded text-xs"
							style={{ backgroundColor: theme.colors.border }}
						>
							Esc
						</kbd>
						Go back
					</span>
				</div>
			</div>
		</div>
	);
}

/**
 * PhaseReviewScreen - Document review and launch
 *
 * This screen handles:
 * 1. Displaying and editing generated documents
 * 2. Document selector for switching between documents
 * 3. Launching session with or without tour
 *
 * Note: Document generation is handled by PreparingPlanScreen (step 4)
 */
export function PhaseReviewScreen({
	theme,
	onLaunchSession,
	onWizardComplete,
	wizardStartTime,
}: PhaseReviewScreenProps): JSX.Element {
	const { state, previousStep } = useWizard();

	// Screen reader announcement state
	const [announcement, setAnnouncement] = useState('');
	const [announcementKey, setAnnouncementKey] = useState(0);

	// Announce when documents are ready
	useEffect(() => {
		if (state.generatedDocuments.length > 0) {
			const totalTasks = state.generatedDocuments.reduce((sum, doc) => sum + doc.taskCount, 0);
			setAnnouncement(
				`${state.generatedDocuments.length} Playbooks ready with ${totalTasks} tasks total. Review and edit your Playbooks, then choose how to proceed.`
			);
			setAnnouncementKey((prev) => prev + 1);
		}
	}, [state.generatedDocuments]);

	const announcementElement = (
		<ScreenReaderAnnouncement
			message={announcement}
			announceKey={announcementKey}
			politeness="polite"
		/>
	);

	// If no documents, go back to preparing step
	if (state.generatedDocuments.length === 0) {
		previousStep();
		return (
			<div className="flex-1 flex items-center justify-center">
				<p style={{ color: theme.colors.textDim }}>Redirecting...</p>
			</div>
		);
	}

	return (
		<>
			{announcementElement}
			<DocumentReview
				theme={theme}
				onLaunchSession={onLaunchSession}
				onWizardComplete={onWizardComplete}
				wizardStartTime={wizardStartTime}
			/>
		</>
	);
}
