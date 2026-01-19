import { useState, useMemo, useEffect, useRef, memo } from 'react';
import { Diff, Hunk } from 'react-diff-view';
import { Plus, Minus, ImageIcon } from 'lucide-react';
import type { Theme } from '../types';
import { parseGitDiff, getFileName, getDiffStats } from '../utils/gitDiffParser';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { ImageDiffViewer } from './ImageDiffViewer';
import { generateDiffViewStyles } from '../utils/markdownConfig';
import 'react-diff-view/style/index.css';

interface GitDiffViewerProps {
	diffText: string;
	cwd: string;
	theme: Theme;
	onClose: () => void;
}

export const GitDiffViewer = memo(function GitDiffViewer({
	diffText,
	cwd,
	theme,
	onClose,
}: GitDiffViewerProps) {
	const [activeTab, setActiveTab] = useState(0);
	const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();

	// Store onClose in ref to avoid re-registering layer on every parent re-render
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Parse the diff into separate files
	const parsedFiles = useMemo(() => parseGitDiff(diffText), [diffText]);

	// Register layer on mount
	// Note: Using 'modal' type so App.tsx blocks all shortcuts and lets this component
	// handle its own Cmd+Shift+[] for tab navigation
	useEffect(() => {
		layerIdRef.current = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.GIT_DIFF,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'lenient',
			ariaLabel: 'Git Diff Preview',
			onEscape: () => onCloseRef.current(),
		});

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [registerLayer, unregisterLayer]); // Removed onClose from deps

	// Update handler when dependencies change (not really needed since onClose uses ref)
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, () => onCloseRef.current());
		}
	}, [updateLayerHandler]);

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

	// Handle keyboard shortcuts (tab navigation only)
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
					className="w-[85%] max-w-[1400px] h-[90%] rounded-lg shadow-2xl flex flex-col overflow-hidden"
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
							Git Diff
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
				className="w-[85%] max-w-[1400px] h-[90%] rounded-lg shadow-2xl flex flex-col overflow-hidden"
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
							Git Diff
						</span>
						<span
							className="text-xs px-2 py-1 rounded"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
						>
							{cwd}
						</span>
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{parsedFiles.length} {parsedFiles.length === 1 ? 'file' : 'files'} changed
						</span>
					</div>
					<button
						onClick={onClose}
						className="px-3 py-1 rounded text-sm hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textDim }}
					>
						Close (Esc)
					</button>
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
								key={index}
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
													<span className="text-green-500 flex items-center gap-0.5">
														<Plus className="w-3 h-3" />
														{fileStats.additions}
													</span>
												)}
												{fileStats.deletions > 0 && (
													<span className="text-red-500 flex items-center gap-0.5">
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
							<style>{generateDiffViewStyles(theme)}</style>
							{activeFile.parsedDiff.map((file, fileIndex) => (
								<div key={fileIndex}>
									{/* File header */}
									<div
										className="mb-4 p-2 rounded font-semibold text-xs"
										style={{
											backgroundColor: theme.colors.bgActivity,
											color: theme.colors.textMain,
										}}
									>
										{file.oldPath} → {file.newPath}
									</div>

									{/* Render each hunk */}
									<Diff viewType="unified" diffType={file.type} hunks={file.hunks}>
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
								{getFileName(activeFile.newPath)}
							</span>
						</span>
						{activeFile.isBinary ? (
							<span style={{ color: theme.colors.textDim }}>
								{activeFile.isImage ? 'Image file' : 'Binary file'}
							</span>
						) : (
							<div className="flex items-center gap-2">
								<span className="text-green-500 flex items-center gap-1">
									<Plus className="w-3 h-3" />
									{stats.additions} additions
								</span>
								<span className="text-red-500 flex items-center gap-1">
									<Minus className="w-3 h-3" />
									{stats.deletions} deletions
								</span>
							</div>
						)}
					</div>
					<span style={{ color: theme.colors.textDim }}>
						File {activeTab + 1} of {parsedFiles.length}
					</span>
				</div>
			</div>
		</div>
	);
});
