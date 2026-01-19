import { useState, useMemo, useEffect, useRef, useCallback, memo } from 'react';
import { GitCommit, GitBranch, Tag } from 'lucide-react';
import type { Theme } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Diff, Hunk } from 'react-diff-view';
import { parseGitDiff } from '../utils/gitDiffParser';
import { useListNavigation } from '../hooks';
import { generateDiffViewStyles } from '../utils/markdownConfig';
import 'react-diff-view/style/index.css';

interface GitLogEntry {
	hash: string;
	shortHash: string;
	author: string;
	date: string;
	refs: string[];
	subject: string;
	additions?: number;
	deletions?: number;
}

interface GitLogViewerProps {
	cwd: string;
	theme: Theme;
	onClose: () => void;
}

export const GitLogViewer = memo(function GitLogViewer({ cwd, theme, onClose }: GitLogViewerProps) {
	const [entries, setEntries] = useState<GitLogEntry[]>([]);
	const [totalCommits, setTotalCommits] = useState<number | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selectedCommitDiff, setSelectedCommitDiff] = useState<string | null>(null);
	const [loadingDiff, setLoadingDiff] = useState(false);

	const listRef = useRef<HTMLDivElement>(null);
	const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

	// Keyboard navigation via shared hook
	const { selectedIndex, setSelectedIndex, handleKeyDown } = useListNavigation({
		listLength: entries.length,
		onSelect: () => {}, // Click-only selection in GitLogViewer
		enableVimKeys: true,
		enablePageNavigation: true,
		pageSize: 10,
	});

	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();

	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Load git log on mount
	useEffect(() => {
		const loadLog = async () => {
			setLoading(true);
			setError(null);
			try {
				// Fetch log entries and total count in parallel
				const [logResult, countResult] = await Promise.all([
					window.maestro.git.log(cwd, { limit: 200 }),
					window.maestro.git.commitCount(cwd),
				]);

				if (logResult.error) {
					setError(logResult.error);
				} else {
					setEntries(logResult.entries);
				}

				if (!countResult.error) {
					setTotalCommits(countResult.count);
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to load git log');
			} finally {
				setLoading(false);
			}
		};
		loadLog();
	}, [cwd]);

	// Load diff when selected entry changes
	const loadCommitDiff = useCallback(
		async (hash: string) => {
			setLoadingDiff(true);
			try {
				const result = await window.maestro.git.show(cwd, hash);
				setSelectedCommitDiff(result.stdout);
			} catch {
				setSelectedCommitDiff(null);
			} finally {
				setLoadingDiff(false);
			}
		},
		[cwd]
	);

	// Auto-load diff for selected commit
	useEffect(() => {
		if (entries.length > 0 && entries[selectedIndex]) {
			loadCommitDiff(entries[selectedIndex].hash);
		}
	}, [selectedIndex, entries, loadCommitDiff]);

	// Register with layer stack
	useEffect(() => {
		layerIdRef.current = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.GIT_LOG,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'lenient',
			ariaLabel: 'Git Log Viewer',
			onEscape: () => onCloseRef.current(),
		});

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [registerLayer, unregisterLayer]);

	// Update handler when dependencies change
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, () => onCloseRef.current());
		}
	}, [updateLayerHandler]);

	// Scroll selected item into view
	useEffect(() => {
		const selectedItem = itemRefs.current[selectedIndex];
		if (selectedItem) {
			selectedItem.scrollIntoView({
				behavior: 'smooth',
				block: 'nearest',
			});
		}
	}, [selectedIndex]);

	// Handle keyboard navigation via global listener
	// Store handleKeyDown in a ref to avoid stale closure issues
	// The ref is updated synchronously on every render, before any events can fire
	const handleKeyDownRef = useRef(handleKeyDown);
	handleKeyDownRef.current = handleKeyDown;

	useEffect(() => {
		// Wrapper function that always calls the current handler from the ref
		const handler = (e: KeyboardEvent) => {
			handleKeyDownRef.current(e);
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	}, []); // Empty deps - handler wrapper never changes, but it reads current value from ref

	// Format date for display - time for today, full date for older commits
	const formatDate = (dateStr: string) => {
		try {
			const date = new Date(dateStr);
			const now = new Date();

			// Check if same day
			const isToday = date.toDateString() === now.toDateString();

			// Check if yesterday
			const yesterday = new Date(now);
			yesterday.setDate(yesterday.getDate() - 1);
			const isYesterday = date.toDateString() === yesterday.toDateString();

			if (isToday) {
				// Show time for today (e.g., "2:30 PM")
				return date.toLocaleTimeString(undefined, {
					hour: 'numeric',
					minute: '2-digit',
					hour12: true,
				});
			} else if (isYesterday) {
				// Show "Yesterday" with time
				return `Yesterday ${date.toLocaleTimeString(undefined, {
					hour: 'numeric',
					minute: '2-digit',
					hour12: true,
				})}`;
			} else {
				// Show full date for older commits (e.g., "Nov 25, 2025")
				return date.toLocaleDateString(undefined, {
					month: 'short',
					day: 'numeric',
					year: 'numeric',
				});
			}
		} catch {
			return dateStr;
		}
	};

	// Parse the commit diff for rendering
	const parsedDiff = useMemo(() => {
		if (!selectedCommitDiff) return null;

		// Extract just the diff portion (after the stats)
		const diffStart = selectedCommitDiff.indexOf('\ndiff --git');
		if (diffStart === -1) return null;

		const diffText = selectedCommitDiff.slice(diffStart + 1);
		return parseGitDiff(diffText);
	}, [selectedCommitDiff]);

	// Extract the full commit message (body) from the show output
	const commitBody = useMemo(() => {
		if (!selectedCommitDiff) return null;

		const lines = selectedCommitDiff.split('\n');
		const bodyLines: string[] = [];
		let foundDate = false;
		let foundBody = false;

		for (const line of lines) {
			// Skip until we find the Date: line
			if (line.startsWith('Date:')) {
				foundDate = true;
				continue;
			}

			// After Date:, skip empty lines until we find content
			if (foundDate && !foundBody) {
				if (line.trim() === '') continue;
				foundBody = true;
			}

			// Stop when we hit the stats separator (---)
			if (foundBody && line.startsWith('---')) {
				break;
			}

			// Collect body lines (they're usually indented with 4 spaces)
			if (foundBody) {
				// Remove the leading indentation (usually 4 spaces)
				const trimmedLine = line.startsWith('    ') ? line.slice(4) : line;
				bodyLines.push(trimmedLine);
			}
		}

		// Return null if we only have the subject line (already shown in header)
		// Body is meaningful if it has more than just one line
		const body = bodyLines.join('\n').trim();
		// Check if body has actual content beyond the subject
		const hasMultipleLines = bodyLines.filter((l) => l.trim()).length > 1;
		return hasMultipleLines ? body : null;
	}, [selectedCommitDiff]);

	// Extract commit stats from the show output
	const commitStats = useMemo(() => {
		if (!selectedCommitDiff) return null;

		const lines = selectedCommitDiff.split('\n');
		const stats: string[] = [];
		let inStats = false;

		for (const line of lines) {
			if (line.match(/^\s*\d+ files? changed/)) {
				stats.push(line.trim());
				break;
			}
			if (line.match(/^\s+\S+.*\|\s+\d+/)) {
				stats.push(line.trim());
				inStats = true;
			} else if (inStats && !line.trim()) {
				break;
			}
		}

		return stats.length > 0 ? stats : null;
	}, [selectedCommitDiff]);

	return (
		<div
			className="fixed inset-0 z-[9999] flex items-center justify-center modal-overlay"
			onClick={onClose}
		>
			<div
				className="w-[90%] max-w-[1600px] h-[90%] rounded-lg shadow-2xl flex flex-col overflow-hidden"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
					border: '1px solid',
				}}
				onClick={(e) => e.stopPropagation()}
				role="dialog"
				aria-modal="true"
				aria-label="Git Log Viewer"
				tabIndex={-1}
				ref={(el) => el?.focus()}
			>
				{/* Header */}
				<div
					className="flex items-center justify-between px-6 py-4 border-b"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					<div className="flex items-center gap-3">
						<GitCommit className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<span className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
							Git Log
						</span>
						<span
							className="text-xs px-2 py-1 rounded"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
						>
							{cwd}
						</span>
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{totalCommits !== null && totalCommits > entries.length
								? `${entries.length} of ${totalCommits} commits`
								: `${entries.length} commits`}
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

				{/* Content */}
				<div className="flex-1 flex overflow-hidden">
					{/* Left side: Commit list */}
					<div
						ref={listRef}
						className="w-2/5 border-r overflow-y-auto"
						style={{ borderColor: theme.colors.border }}
					>
						{loading ? (
							<div className="flex items-center justify-center h-full">
								<p className="text-sm" style={{ color: theme.colors.textDim }}>
									Loading git log...
								</p>
							</div>
						) : error ? (
							<div className="flex items-center justify-center h-full p-6">
								<p className="text-sm text-red-500">{error}</p>
							</div>
						) : entries.length === 0 ? (
							<div className="flex items-center justify-center h-full">
								<p className="text-sm" style={{ color: theme.colors.textDim }}>
									No commits found
								</p>
							</div>
						) : (
							<div className="divide-y" style={{ borderColor: theme.colors.border }}>
								{entries.map((entry, index) => (
									<div
										key={entry.hash}
										ref={(el) => (itemRefs.current[index] = el)}
										onClick={() => setSelectedIndex(index)}
										className={`px-4 py-3 cursor-pointer transition-colors ${
											selectedIndex === index ? '' : 'hover:bg-white/5'
										}`}
										style={{
											backgroundColor:
												selectedIndex === index ? theme.colors.bgActivity : 'transparent',
											borderColor: theme.colors.border,
										}}
									>
										{/* Refs (branches, tags) */}
										{entry.refs.length > 0 && (
											<div className="flex flex-wrap gap-1 mb-1">
												{entry.refs.map((ref, i) => {
													const isTag = ref.startsWith('tag:');
													const isBranch = !isTag && !ref.includes('/');

													return (
														<span
															key={i}
															className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono"
															style={{
																backgroundColor: isTag
																	? 'rgba(234, 179, 8, 0.2)'
																	: isBranch
																		? 'rgba(34, 197, 94, 0.2)'
																		: 'rgba(59, 130, 246, 0.2)',
																color: isTag
																	? 'rgb(234, 179, 8)'
																	: isBranch
																		? 'rgb(34, 197, 94)'
																		: 'rgb(59, 130, 246)',
															}}
														>
															{isTag ? (
																<Tag className="w-3 h-3" />
															) : (
																<GitBranch className="w-3 h-3" />
															)}
															{ref.replace('tag: ', '').replace('HEAD -> ', '')}
														</span>
													);
												})}
											</div>
										)}

										{/* Commit message */}
										<p
											className="text-sm font-medium truncate"
											style={{ color: theme.colors.textMain }}
										>
											{entry.subject}
										</p>

										{/* Metadata */}
										<div
											className="flex items-center gap-3 mt-1 text-xs"
											style={{ color: theme.colors.textDim }}
										>
											<span className="font-mono">{entry.shortHash}</span>
											<span>{entry.author}</span>
											<span>{formatDate(entry.date)}</span>
											{/* Addition/deletion stats */}
											{((entry.additions ?? 0) > 0 || (entry.deletions ?? 0) > 0) && (
												<span className="font-mono flex items-center gap-1">
													{(entry.additions ?? 0) > 0 && (
														<span style={{ color: 'rgb(34, 197, 94)' }}>+{entry.additions}</span>
													)}
													{(entry.deletions ?? 0) > 0 && (
														<span style={{ color: 'rgb(239, 68, 68)' }}>-{entry.deletions}</span>
													)}
												</span>
											)}
										</div>
									</div>
								))}
							</div>
						)}
					</div>

					{/* Right side: Commit details & diff */}
					<div className="flex-1 overflow-y-auto">
						{entries[selectedIndex] && (
							<div className="p-6">
								{/* Commit header */}
								<div className="mb-6">
									<h3
										className="text-lg font-semibold mb-2"
										style={{ color: theme.colors.textMain }}
									>
										{entries[selectedIndex].subject}
									</h3>
									<div
										className="flex items-center gap-4 text-sm"
										style={{ color: theme.colors.textDim }}
									>
										<span
											className="font-mono px-2 py-1 rounded"
											style={{ backgroundColor: theme.colors.bgActivity }}
										>
											{entries[selectedIndex].hash}
										</span>
										<span>{entries[selectedIndex].author}</span>
										<span>{new Date(entries[selectedIndex].date).toLocaleString()}</span>
									</div>
								</div>

								{/* Full commit message body */}
								{commitBody && (
									<div
										className="mb-6 p-3 rounded"
										style={{ backgroundColor: theme.colors.bgActivity }}
									>
										<div
											className="text-xs font-mono space-y-1 whitespace-pre-wrap"
											style={{ color: theme.colors.textDim }}
										>
											{commitBody}
										</div>
									</div>
								)}

								{/* File stats */}
								{commitStats && (
									<div
										className="mb-6 p-3 rounded"
										style={{ backgroundColor: theme.colors.bgActivity }}
									>
										<div
											className="text-xs font-mono space-y-1"
											style={{ color: theme.colors.textDim }}
										>
											{commitStats.map((stat, i) => (
												<div key={i}>{stat}</div>
											))}
										</div>
									</div>
								)}

								{/* Diff content */}
								{loadingDiff ? (
									<div className="flex items-center justify-center py-12">
										<p className="text-sm" style={{ color: theme.colors.textDim }}>
											Loading diff...
										</p>
									</div>
								) : parsedDiff && parsedDiff.length > 0 ? (
									<div className="font-mono text-sm">
										<style>{generateDiffViewStyles(theme)}</style>
										{parsedDiff.map((file, fileIndex) => (
											<div key={fileIndex} className="mb-6">
												{/* File header */}
												<div
													className="mb-2 p-2 rounded font-semibold text-xs"
													style={{
														backgroundColor: theme.colors.bgActivity,
														color: theme.colors.textMain,
													}}
												>
													{file.newPath}
												</div>

												{/* Render hunks */}
												{file.parsedDiff.map((parsedFile, pIndex) => (
													<Diff
														key={pIndex}
														viewType="unified"
														diffType={parsedFile.type}
														hunks={parsedFile.hunks}
													>
														{(hunks) =>
															hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)
														}
													</Diff>
												))}
											</div>
										))}
									</div>
								) : (
									<div className="flex items-center justify-center py-12">
										<p className="text-sm" style={{ color: theme.colors.textDim }}>
											No diff available for this commit
										</p>
									</div>
								)}
							</div>
						)}
					</div>
				</div>

				{/* Footer */}
				<div
					className="flex items-center justify-between px-6 py-3 border-t text-xs"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					<div className="flex items-center gap-4" style={{ color: theme.colors.textDim }}>
						<span>
							<kbd
								className="px-1 py-0.5 rounded"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								↑↓
							</kbd>{' '}
							or
							<kbd
								className="px-1 py-0.5 rounded ml-1"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								j/k
							</kbd>{' '}
							navigate
						</span>
						<span>
							<kbd
								className="px-1 py-0.5 rounded"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								Esc
							</kbd>{' '}
							close
						</span>
					</div>
					{entries.length > 0 && (
						<span style={{ color: theme.colors.textDim }}>
							Commit {selectedIndex + 1} of {entries.length}
						</span>
					)}
				</div>
			</div>
		</div>
	);
});
