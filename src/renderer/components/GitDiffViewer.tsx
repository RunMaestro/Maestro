import { useState, useMemo, useEffect, useRef, useCallback, memo } from 'react';
import type { ReactNode } from 'react';
import { Diff, Hunk } from 'react-diff-view';
import type { EventMap, RenderGutter } from 'react-diff-view';
import { Plus, Minus, ImageIcon, Columns2, AlignJustify, MessageSquarePlus } from 'lucide-react';
import type { Theme } from '../types';
import { parseGitDiff, getFileName, getDiffStats } from '../utils/gitDiffParser';
import { getBasename } from '../../shared/formatters';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { useResizableModal } from '../hooks/ui/useResizableModal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { ImageDiffViewer } from './ImageDiffViewer';
import { GitFilePathHeader } from './GitFilePathHeader';
import { generateDiffViewStyles } from '../utils/markdownConfig';
import { useSettingsStore } from '../stores/settingsStore';
import { ResizeHandles } from './ui/ResizeHandles';
import { DiffAnnotationCard, DiffAnnotationEditor, DiffReviewTray } from './DiffAnnotations';
import {
	anchorForChange,
	formatDiffReviewPrompt,
	type DiffAnnotation,
	type DiffAnnotationAnchor,
} from '../utils/diffAnnotations';
import { getPendingDiffAnnotations, setPendingDiffAnnotations } from '../services/diffReview';
import { generateId } from '../utils/ids';
import 'react-diff-view/style/index.css';

export type GitDiffViewType = 'unified' | 'split';

const VIEW_TYPE_STORAGE_KEY = 'maestro.gitDiffViewer.viewType';

function readStoredViewType(): GitDiffViewType | null {
	if (typeof window === 'undefined') return null;
	try {
		const raw = window.localStorage.getItem(VIEW_TYPE_STORAGE_KEY);
		return raw === 'unified' || raw === 'split' ? raw : null;
	} catch {
		return null;
	}
}

function writeStoredViewType(value: GitDiffViewType): void {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(VIEW_TYPE_STORAGE_KEY, value);
	} catch {
		// Ignore quota / privacy-mode errors - preference just won't persist.
	}
}

function isFormControl(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	if (
		tag === 'BUTTON' ||
		tag === 'INPUT' ||
		tag === 'TEXTAREA' ||
		tag === 'SELECT' ||
		tag === 'A'
	) {
		return true;
	}
	return target.isContentEditable;
}

interface GitDiffViewerProps {
	diffText: string;
	cwd: string;
	theme: Theme;
	onClose: () => void;
	/**
	 * Default view type when the user has no persisted preference yet. Once the
	 * user toggles the header button, the chosen value is saved to localStorage
	 * and applied to all future GitDiffViewer instances regardless of this prop.
	 */
	initialViewType?: GitDiffViewType;
	/** Optional title shown in the header instead of the default "Git Diff". */
	title?: string;
	/**
	 * Open a file as a preview tab. Given an absolute path and the display name.
	 * When provided, file-path headers become clickable; the viewer dismisses
	 * itself via `onClose` first, then calls this to open the file.
	 */
	onOpenFile?: (absolutePath: string, fileName: string) => void;
	/**
	 * Optional modal-layer priority override. Defaults to GIT_DIFF (200).
	 * Use a higher priority when opening this viewer from inside another
	 * modal so it captures Escape and focus correctly.
	 */
	priority?: number;
	/**
	 * Send a formatted review to the agent that produced the diff. When
	 * provided, clicking a line number annotates that line, and the batch of
	 * annotations is handed back through this as one prompt. Return `false` if
	 * the review could not be delivered, so the annotations are kept.
	 */
	onSendReview?: (prompt: string) => boolean;
	/** Name of the agent `onSendReview` delivers to, shown on the send button. */
	reviewTargetName?: string;
}

/** The annotation editor currently open, if any. `id` is set when editing a saved one. */
interface AnnotationEditState {
	anchor: DiffAnnotationAnchor;
	id?: string;
	initialBody: string;
}

export const GitDiffViewer = memo(function GitDiffViewer({
	diffText,
	cwd,
	theme,
	onClose,
	initialViewType = 'unified',
	title = 'Git Diff',
	priority,
	onOpenFile,
	onSendReview,
	reviewTargetName,
}: GitDiffViewerProps) {
	const [activeTab, setActiveTab] = useState(0);
	const [viewType, setViewType] = useState<GitDiffViewType>(
		() => readStoredViewType() ?? initialViewType
	);
	const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const dialogRef = useRef<HTMLDivElement>(null);
	const colorBlindMode = useSettingsStore((s) => s.colorBlindMode);

	// Persist the user's chosen view type so it sticks across all diff views and app restarts.
	useEffect(() => {
		writeStoredViewType(viewType);
	}, [viewType]);

	// Store onClose in ref to avoid re-registering layer on every parent re-render
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Parse the diff into separate files
	const parsedFiles = useMemo(() => parseGitDiff(diffText), [diffText]);

	// Review annotations. Parked per repo, so closing the viewer before sending
	// does not throw a half-written review away.
	const canAnnotate = !!onSendReview;
	const [annotations, setAnnotations] = useState<DiffAnnotation[]>(() =>
		canAnnotate ? getPendingDiffAnnotations(cwd) : []
	);
	const [editing, setEditing] = useState<AnnotationEditState | null>(null);
	const editingRef = useRef(editing);
	editingRef.current = editing;

	useEffect(() => {
		if (canAnnotate) setPendingDiffAnnotations(cwd, annotations);
	}, [canAnnotate, cwd, annotations]);

	const activeFilePath = (() => {
		const file = parsedFiles[activeTab];
		if (!file) return '';
		return file.isDeletedFile ? file.oldPath : file.newPath;
	})();

	const saveAnnotation = useCallback((body: string) => {
		const current = editingRef.current;
		const trimmed = body.trim();
		if (!current || !trimmed) return;
		if (current.id) {
			const id = current.id;
			setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, body: trimmed } : a)));
		} else {
			const { anchor } = current;
			setAnnotations((prev) => [
				...prev,
				{
					id: generateId(),
					file: anchor.file,
					line: anchor.line,
					side: anchor.side,
					kind: anchor.kind,
					lineText: anchor.lineText,
					changeKey: anchor.changeKey,
					body: trimmed,
				},
			]);
		}
		setEditing(null);
	}, []);

	const cancelEditing = useCallback(() => setEditing(null), []);

	const removeAnnotation = useCallback((id: string) => {
		setAnnotations((prev) => prev.filter((a) => a.id !== id));
		setEditing((prev) => (prev?.id === id ? null : prev));
	}, []);

	const editAnnotation = useCallback(
		(annotation: DiffAnnotation) => {
			const fileIndex = parsedFiles.findIndex(
				(f) => (f.isDeletedFile ? f.oldPath : f.newPath) === annotation.file
			);
			if (fileIndex >= 0) setActiveTab(fileIndex);
			setEditing({ anchor: annotation, id: annotation.id, initialBody: annotation.body });
		},
		[parsedFiles]
	);

	const sendReview = () => {
		if (!onSendReview) return;
		const prompt = formatDiffReviewPrompt(annotations);
		if (!prompt) return;
		if (!onSendReview(prompt)) return;
		setPendingDiffAnnotations(cwd, []);
		setAnnotations([]);
		setEditing(null);
		onClose();
	};

	// Clicking a line number opens the annotation editor under that line.
	const gutterEvents = useMemo<EventMap>(
		() =>
			canAnnotate && activeFilePath
				? {
						onClick: ({ change, side }) => {
							if (!change) return;
							setEditing({
								anchor: anchorForChange(activeFilePath, change, side),
								initialBody: '',
							});
						},
					}
				: {},
		[canAnnotate, activeFilePath]
	);

	const renderGutter = useCallback<RenderGutter>(
		({ inHoverState, renderDefault }) =>
			inHoverState ? (
				<span className="inline-flex justify-end w-full" title="Annotate this line">
					<MessageSquarePlus className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
				</span>
			) : (
				renderDefault()
			),
		[theme.colors.accent]
	);

	// Saved annotations and the open editor render as widget rows under their line.
	const widgets = useMemo(() => {
		const result: Record<string, ReactNode> = {};
		if (!canAnnotate || !activeFilePath) return result;
		const byKey = new Map<string, DiffAnnotation[]>();
		for (const annotation of annotations) {
			if (annotation.file !== activeFilePath) continue;
			const list = byKey.get(annotation.changeKey) ?? [];
			list.push(annotation);
			byKey.set(annotation.changeKey, list);
		}
		const newDraftKey =
			editing && !editing.id && editing.anchor.file === activeFilePath
				? editing.anchor.changeKey
				: null;
		if (newDraftKey && !byKey.has(newDraftKey)) byKey.set(newDraftKey, []);

		for (const [key, list] of byKey) {
			result[key] = (
				<div className="flex flex-col">
					{list.map((annotation) =>
						editing?.id === annotation.id ? (
							<DiffAnnotationEditor
								key={annotation.id}
								theme={theme}
								initialBody={editing.initialBody}
								isNew={false}
								onSave={saveAnnotation}
								onCancel={cancelEditing}
							/>
						) : (
							<DiffAnnotationCard
								key={annotation.id}
								theme={theme}
								annotation={annotation}
								onEdit={() => editAnnotation(annotation)}
								onRemove={() => removeAnnotation(annotation.id)}
							/>
						)
					)}
					{key === newDraftKey && (
						<DiffAnnotationEditor
							key={`new-${editing?.anchor.side}-${editing?.anchor.line}`}
							theme={theme}
							initialBody=""
							isNew
							onSave={saveAnnotation}
							onCancel={cancelEditing}
						/>
					)}
				</div>
			);
		}
		return result;
	}, [
		canAnnotate,
		activeFilePath,
		annotations,
		editing,
		theme,
		saveAnnotation,
		cancelEditing,
		editAnnotation,
		removeAnnotation,
	]);

	// Dismiss the viewer and open the given repo-relative file as a preview tab.
	const openFileInPreview = (relPath: string) => {
		if (!onOpenFile) return;
		onClose();
		onOpenFile(`${cwd}/${relPath}`, getBasename(relPath));
	};

	// Register layer on mount
	// Note: Using 'modal' type so App.tsx blocks all shortcuts and lets this component
	// handle its own Cmd+Shift+[] for tab navigation
	// Escape inside an open annotation editor dismisses the editor, not the viewer.
	useModalLayer(
		priority ?? MODAL_PRIORITIES.GIT_DIFF,
		'Git Diff Preview',
		() => {
			if (editingRef.current) {
				setEditing(null);
				return;
			}
			onCloseRef.current();
		},
		{
			focusTrap: 'lenient',
		}
	);

	// Auto-scroll to active tab when it changes
	useEffect(() => {
		const activeTabElement = tabRefs.current[activeTab];
		if (activeTabElement) {
			activeTabElement.scrollIntoView({
				behavior: 'smooth',
				block: 'nearest',
				inline: 'center',
			});
		}
	}, [activeTab]);

	// Handle keyboard shortcuts (tab navigation + view toggle)
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Cmd+[ or Cmd+Shift+[ - Previous tab
			if ((e.metaKey || e.ctrlKey) && e.key === '[') {
				e.preventDefault();
				setActiveTab((prev) => (prev === 0 ? parsedFiles.length - 1 : prev - 1));
			}
			// Cmd+] or Cmd+Shift+] - Next tab
			else if ((e.metaKey || e.ctrlKey) && e.key === ']') {
				e.preventDefault();
				setActiveTab((prev) => (prev + 1) % parsedFiles.length);
			}
			// Enter - Toggle unified / side-by-side. Skip when a focused control
			// (button, link, input, etc.) would otherwise consume Enter, so the
			// toggle button and tab buttons keep their native activation behavior.
			else if (
				e.key === 'Enter' &&
				!e.metaKey &&
				!e.ctrlKey &&
				!e.altKey &&
				!e.shiftKey &&
				!isFormControl(e.target)
			) {
				e.preventDefault();
				setViewType((v) => (v === 'unified' ? 'split' : 'unified'));
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [parsedFiles.length]);
	const resizableModal = useResizableModal({
		resizeKey: 'git-diff',
		defaultSize: { width: 1200, height: 760 },
		minSize: { width: 720, height: 480 },
		externalRef: dialogRef,
	});

	useEffect(() => {
		dialogRef.current?.focus();
	}, []);

	if (parsedFiles.length === 0) {
		return (
			<div
				className="fixed inset-0 z-[9999] flex items-center justify-center modal-overlay"
				onClick={onClose}
			>
				<div
					ref={dialogRef}
					className="relative rounded-lg shadow-2xl flex flex-col overflow-hidden"
					style={{
						...resizableModal.style,
						backgroundColor: theme.colors.bgMain,
						border: `1px solid ${theme.colors.border}`,
					}}
					data-modal-resize-key="git-diff"
					onClick={(e) => e.stopPropagation()}
					role="dialog"
					aria-modal="true"
					aria-label="Git Diff Preview"
					tabIndex={-1}
				>
					<ResizeHandles
						onResizeStart={resizableModal.onResizeStart}
						accentColor={theme.colors.accent}
						onResetSize={resizableModal.onResetSize}
						canReset={resizableModal.canReset}
					/>

					<div
						className="flex items-center justify-between px-6 py-4 border-b"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
					>
						<span className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
							{title}
						</span>
						<button
							onClick={onClose}
							className="px-3 py-1 rounded text-sm hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
						>
							Close (Esc)
						</button>
					</div>
					<div className="flex-1 flex items-center justify-center">
						<p className="text-sm" style={{ color: theme.colors.textDim }}>
							No changes to display
						</p>
					</div>
				</div>
			</div>
		);
	}

	const activeFile = parsedFiles[activeTab];
	const stats = activeFile ? getDiffStats(activeFile.parsedDiff) : { additions: 0, deletions: 0 };

	return (
		<div
			className="fixed inset-0 z-[9999] flex items-center justify-center modal-overlay"
			onClick={onClose}
		>
			<div
				ref={dialogRef}
				className="relative rounded-lg shadow-2xl flex flex-col overflow-hidden"
				style={{
					...resizableModal.style,
					backgroundColor: theme.colors.bgMain,
					border: `1px solid ${theme.colors.border}`,
				}}
				data-modal-resize-key="git-diff"
				onClick={(e) => e.stopPropagation()}
				role="dialog"
				aria-modal="true"
				aria-label="Git Diff Preview"
				tabIndex={-1}
			>
				<ResizeHandles
					onResizeStart={resizableModal.onResizeStart}
					accentColor={theme.colors.accent}
					onResetSize={resizableModal.onResetSize}
					canReset={resizableModal.canReset}
				/>

				{/* Header */}
				<div
					className="flex items-center justify-between px-6 py-4 border-b"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					<div className="flex items-center gap-3">
						<span className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
							{title}
						</span>
						<span
							className="text-xs px-2 py-1 rounded"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
						>
							{cwd}
						</span>
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							File {activeTab + 1} of {parsedFiles.length}
						</span>
					</div>
					<div className="flex items-center gap-2">
						<button
							onClick={() => setViewType((v) => (v === 'unified' ? 'split' : 'unified'))}
							className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs hover:bg-white/10 transition-colors"
							style={{
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
							}}
							aria-label={viewType === 'unified' ? 'Switch to side-by-side' : 'Switch to unified'}
							title={viewType === 'unified' ? 'Switch to side-by-side' : 'Switch to unified'}
						>
							{viewType === 'unified' ? (
								<>
									<Columns2 className="w-3.5 h-3.5" />
									Side-by-side
								</>
							) : (
								<>
									<AlignJustify className="w-3.5 h-3.5" />
									Unified
								</>
							)}
						</button>
						<button
							onClick={onClose}
							className="px-3 py-1 rounded text-sm hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
						>
							Close (Esc)
						</button>
					</div>
				</div>

				{/* Tabs */}
				<div
					className="flex gap-0 border-b overflow-x-auto scrollbar-thin"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					{parsedFiles.map((file, index) => {
						const fileStats = getDiffStats(file.parsedDiff);
						return (
							<button
								key={file.newPath || file.oldPath || `file-${index}`}
								ref={(el) => (tabRefs.current[index] = el)}
								onClick={() => setActiveTab(index)}
								className={`px-4 py-3 text-sm whitespace-nowrap transition-colors ${
									activeTab === index ? 'border-b-2' : 'hover:bg-white/5'
								}`}
								style={{
									color: activeTab === index ? theme.colors.accent : theme.colors.textDim,
									borderColor: activeTab === index ? theme.colors.accent : 'transparent',
									backgroundColor: activeTab === index ? theme.colors.bgMain : 'transparent',
								}}
							>
								<div className="flex items-center gap-2">
									{file.isImage && (
										<ImageIcon className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									)}
									<span className="font-mono">{getFileName(file.newPath)}</span>
									<div className="flex items-center gap-1 text-xs">
										{file.isBinary ? (
											<span style={{ color: theme.colors.textDim }}>binary</span>
										) : (
											<>
												{fileStats.additions > 0 && (
													<span
														className="flex items-center gap-0.5"
														style={{ color: colorBlindMode ? '#009988' : '#22c55e' }}
													>
														<Plus className="w-3 h-3" />
														{fileStats.additions}
													</span>
												)}
												{fileStats.deletions > 0 && (
													<span
														className="flex items-center gap-0.5"
														style={{ color: colorBlindMode ? '#CC3311' : '#ef4444' }}
													>
														<Minus className="w-3 h-3" />
														{fileStats.deletions}
													</span>
												)}
											</>
										)}
									</div>
								</div>
							</button>
						);
					})}
				</div>

				{/* Diff Content */}
				<div className="flex-1 overflow-auto p-6">
					{activeFile && activeFile.isImage ? (
						// Image diff view - side-by-side comparison
						<ImageDiffViewer
							oldPath={activeFile.oldPath}
							newPath={activeFile.newPath}
							cwd={cwd}
							theme={theme}
							isNewFile={activeFile.isNewFile}
							isDeletedFile={activeFile.isDeletedFile}
						/>
					) : activeFile && activeFile.isBinary ? (
						// Non-image binary file
						<div className="flex flex-col items-center justify-center h-full gap-2">
							<p className="text-sm" style={{ color: theme.colors.textDim }}>
								Binary file changed
							</p>
							<p className="text-xs" style={{ color: theme.colors.textDim }}>
								{activeFile.newPath}
							</p>
						</div>
					) : activeFile && activeFile.parsedDiff.length > 0 ? (
						<div className="font-mono text-sm">
							<style>{generateDiffViewStyles(theme, colorBlindMode)}</style>
							{canAnnotate && (
								<style>{`.diff-gutter:not(.diff-gutter-omit) { cursor: pointer; } .diff-widget-content { padding: 0; }`}</style>
							)}
							{activeFile.parsedDiff.map((file, fileIndex) => (
								<div key={fileIndex}>
									{/* File header (click to open the file as a preview tab) */}
									<GitFilePathHeader
										theme={theme}
										className="mb-4"
										onOpen={
											onOpenFile && !activeFile.isDeletedFile
												? () => openFileInPreview(activeFile.newPath)
												: undefined
										}
										title={
											activeFile.isDeletedFile
												? undefined
												: `Open ${activeFile.newPath} in a preview tab`
										}
									>
										{file.oldPath} → {file.newPath}
									</GitFilePathHeader>

									{/* Render each hunk */}
									<Diff
										viewType={viewType}
										diffType={file.type}
										hunks={file.hunks}
										widgets={widgets}
										gutterEvents={gutterEvents}
										renderGutter={canAnnotate ? renderGutter : undefined}
									>
										{(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
									</Diff>
								</div>
							))}
						</div>
					) : (
						<div className="flex items-center justify-center h-full">
							<p className="text-sm" style={{ color: theme.colors.textDim }}>
								Unable to parse diff for this file
							</p>
						</div>
					)}
				</div>

				{canAnnotate && annotations.length > 0 && (
					<DiffReviewTray
						theme={theme}
						annotations={annotations}
						targetName={reviewTargetName}
						onEdit={editAnnotation}
						onRemove={removeAnnotation}
						onClear={() => {
							setAnnotations([]);
							setEditing(null);
						}}
						onSend={sendReview}
					/>
				)}

				{/* Footer with stats */}
				<div
					className="flex items-center justify-between px-6 py-3 border-t text-xs"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					<div className="flex items-center gap-4">
						<span style={{ color: theme.colors.textDim }}>
							Current file:{' '}
							<span className="font-mono" style={{ color: theme.colors.textMain }}>
								{getFileName(activeFile.newPath)}
							</span>
						</span>
						{activeFile.isBinary ? (
							<span style={{ color: theme.colors.textDim }}>
								{activeFile.isImage ? 'Image file' : 'Binary file'}
							</span>
						) : (
							<div className="flex items-center gap-2">
								<span
									className="flex items-center gap-1"
									style={{ color: colorBlindMode ? '#009988' : '#22c55e' }}
								>
									<Plus className="w-3 h-3" />
									{stats.additions} additions
								</span>
								<span
									className="flex items-center gap-1"
									style={{ color: colorBlindMode ? '#CC3311' : '#ef4444' }}
								>
									<Minus className="w-3 h-3" />
									{stats.deletions} deletions
								</span>
							</div>
						)}
					</div>
					<span style={{ color: theme.colors.textDim }}>
						Press{' '}
						<kbd
							className="px-1.5 py-0.5 rounded font-mono text-2xs mx-0.5"
							style={{
								backgroundColor: theme.colors.bgActivity,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							Enter
						</kbd>{' '}
						to toggle {viewType === 'unified' ? 'side-by-side' : 'unified'} view
						{canAnnotate && ' · click a line number to annotate it'}
					</span>
				</div>
			</div>
		</div>
	);
});
