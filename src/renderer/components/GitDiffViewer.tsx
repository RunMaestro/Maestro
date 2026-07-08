import { useState, useMemo, useEffect, useRef, memo } from 'react';
import { Diff, Hunk } from 'react-diff-view';
import { Plus, Minus, ImageIcon, Columns2, AlignJustify } from 'lucide-react';
import type { Theme } from '../types';
import {
	parseGitDiff,
	getFileName,
	getDiffStats,
	type ParsedFileDiff,
} from '../utils/gitDiffParser';
import { getBasename } from '../../shared/formatters';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { ImageDiffViewer } from './ImageDiffViewer';
import { GitFilePathHeader } from './GitFilePathHeader';
import { generateDiffViewStyles } from '../utils/markdownConfig';
import { useSettingsStore } from '../stores/settingsStore';
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

function getFileDisplayPath(file: ParsedFileDiff, index: number): string {
	return file.newPath || file.oldPath || `file-${index}`;
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
}: GitDiffViewerProps) {
	const [activeTab, setActiveTab] = useState(0);
	const [viewType, setViewType] = useState<GitDiffViewType>(
		() => readStoredViewType() ?? initialViewType
	);
	const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
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
	const activeIndex = parsedFiles.length > 0 ? Math.min(activeTab, parsedFiles.length - 1) : 0;

	useEffect(() => {
		if (parsedFiles.length > 0 && activeTab !== activeIndex) {
			setActiveTab(activeIndex);
		}
	}, [activeIndex, activeTab, parsedFiles.length]);

	// Dismiss the viewer and open the given repo-relative file as a preview tab.
	const openFileInPreview = (relPath: string) => {
		if (!onOpenFile) return;
		onClose();
		onOpenFile(`${cwd}/${relPath}`, getBasename(relPath));
	};

	// Register layer on mount
	// Note: Using 'modal' type so App.tsx blocks all shortcuts and lets this component
	// handle its own Cmd+Shift+[] for tab navigation
	useModalLayer(
		priority ?? MODAL_PRIORITIES.GIT_DIFF,
		'Git Diff Preview',
		() => onCloseRef.current(),
		{
			focusTrap: 'lenient',
		}
	);

	// Auto-scroll to active tab when it changes
	useEffect(() => {
		const activeTabElement = tabRefs.current[activeIndex];
		if (activeTabElement) {
			activeTabElement.scrollIntoView({
				behavior: 'smooth',
				block: 'nearest',
				inline: 'center',
			});
		}
	}, [activeIndex]);

	// Handle keyboard shortcuts (tab navigation + view toggle)
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Cmd+[ or Cmd+Shift+[ - Previous tab
			if ((e.metaKey || e.ctrlKey) && e.key === '[') {
				e.preventDefault();
				if (parsedFiles.length === 0) return;
				setActiveTab((prev) => (prev === 0 ? parsedFiles.length - 1 : prev - 1));
			}
			// Cmd+] or Cmd+Shift+] - Next tab
			else if ((e.metaKey || e.ctrlKey) && e.key === ']') {
				e.preventDefault();
				if (parsedFiles.length === 0) return;
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

	if (parsedFiles.length === 0) {
		return (
			<div
				className="fixed inset-0 z-[9999] flex items-center justify-center modal-overlay"
				onClick={onClose}
			>
				<div
					className="w-[90vw] h-[90vh] rounded-lg shadow-2xl flex flex-col overflow-hidden"
					style={{
						backgroundColor: theme.colors.bgMain,
						border: `1px solid ${theme.colors.border}`,
					}}
					onClick={(e) => e.stopPropagation()}
					role="dialog"
					aria-modal="true"
					aria-label="Git Diff Preview"
					tabIndex={-1}
					ref={(el) => el?.focus()}
				>
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

	const activeFile = parsedFiles[activeIndex];
	const activeFileDisplayPath = activeFile ? getFileDisplayPath(activeFile, activeIndex) : '';
	const stats = activeFile ? getDiffStats(activeFile.parsedDiff) : { additions: 0, deletions: 0 };

	return (
		<div
			className="fixed inset-0 z-[9999] flex items-center justify-center modal-overlay"
			onClick={onClose}
		>
			<div
				className="w-[90vw] h-[90vh] rounded-lg shadow-2xl flex flex-col overflow-hidden"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
					border: '1px solid',
				}}
				onClick={(e) => e.stopPropagation()}
				role="dialog"
				aria-modal="true"
				aria-label="Git Diff Preview"
				tabIndex={-1}
				ref={(el) => el?.focus()}
			>
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
							File {activeIndex + 1} of {parsedFiles.length}
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
									activeIndex === index ? 'border-b-2' : 'hover:bg-white/5'
								}`}
								style={{
									color: activeIndex === index ? theme.colors.accent : theme.colors.textDim,
									borderColor: activeIndex === index ? theme.colors.accent : 'transparent',
									backgroundColor: activeIndex === index ? theme.colors.bgMain : 'transparent',
								}}
							>
								<div className="flex items-center gap-2">
									{file.isImage && (
										<ImageIcon className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									)}
									<span className="font-mono">{getFileName(getFileDisplayPath(file, index))}</span>
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
								{activeFileDisplayPath}
							</p>
						</div>
					) : activeFile && activeFile.parsedDiff.length > 0 ? (
						<div className="font-mono text-sm">
							<style>{generateDiffViewStyles(theme, colorBlindMode)}</style>
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
									<Diff viewType={viewType} diffType={file.type} hunks={file.hunks}>
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

				{/* Footer with stats */}
				<div
					className="flex items-center justify-between px-6 py-3 border-t text-xs"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					<div className="flex items-center gap-4">
						<span style={{ color: theme.colors.textDim }}>
							Current file:{' '}
							<span className="font-mono" style={{ color: theme.colors.textMain }}>
								{getFileName(activeFileDisplayPath)}
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
							className="px-1.5 py-0.5 rounded font-mono text-[10px] mx-0.5"
							style={{
								backgroundColor: theme.colors.bgActivity,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							Enter
						</kbd>{' '}
						to toggle {viewType === 'unified' ? 'side-by-side' : 'unified'} view
					</span>
				</div>
			</div>
		</div>
	);
});
