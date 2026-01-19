import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
	X,
	Bot,
	User,
	Copy,
	Check,
	CheckCircle,
	XCircle,
	Trash2,
	Clock,
	Cpu,
	Zap,
	Play,
	ChevronLeft,
	ChevronRight,
	AlertTriangle,
} from 'lucide-react';
import type { Theme, HistoryEntry } from '../types';
import type { FileNode } from '../types/fileTree';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { formatElapsedTime } from '../utils/formatters';
import { stripAnsiCodes } from '../../shared/stringUtils';
import { MarkdownRenderer } from './MarkdownRenderer';
import { generateTerminalProseStyles } from '../utils/markdownConfig';
import { calculateContextTokens } from '../utils/contextUsage';

// Double checkmark SVG component for validated entries
const DoubleCheck = ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
	<svg
		className={className}
		style={style}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2.5"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<polyline points="15 6 6 17 1 12" />
		<polyline points="23 6 14 17 11 14" />
	</svg>
);

interface HistoryDetailModalProps {
	theme: Theme;
	entry: HistoryEntry;
	onClose: () => void;
	onJumpToAgentSession?: (agentSessionId: string) => void;
	onResumeSession?: (agentSessionId: string) => void;
	onDelete?: (entryId: string) => void;
	onUpdate?: (entryId: string, updates: { validated?: boolean }) => Promise<boolean>;
	// Navigation props for prev/next
	filteredEntries?: HistoryEntry[];
	currentIndex?: number;
	onNavigate?: (entry: HistoryEntry, index: number) => void;
	// File linking props for markdown rendering
	fileTree?: FileNode[];
	cwd?: string;
	projectRoot?: string;
	onFileClick?: (path: string) => void;
}

// Get context bar color based on usage percentage
const getContextColor = (usage: number, theme: Theme) => {
	if (usage >= 90) return theme.colors.error;
	if (usage >= 70) return theme.colors.warning;
	return theme.colors.success;
};

export function HistoryDetailModal({
	theme,
	entry,
	onClose,
	onJumpToAgentSession: _onJumpToAgentSession,
	onResumeSession,
	onDelete,
	onUpdate,
	filteredEntries,
	currentIndex,
	onNavigate,
	fileTree,
	cwd,
	projectRoot,
	onFileClick,
}: HistoryDetailModalProps) {
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const [copiedSessionId, setCopiedSessionId] = useState(false);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const deleteButtonRef = useRef<HTMLButtonElement>(null);

	// Generate prose styles for consistent markdown rendering (same as TerminalOutput)
	const proseStyles = useMemo(
		() => generateTerminalProseStyles(theme, '.history-detail-content'),
		[theme]
	);

	// Navigation state
	const canNavigate = filteredEntries && currentIndex !== undefined && onNavigate;
	const hasPrev = canNavigate && currentIndex > 0;
	const hasNext = canNavigate && currentIndex < filteredEntries.length - 1;

	// Navigation handlers
	const goToPrev = useCallback(() => {
		if (hasPrev && filteredEntries && onNavigate) {
			const newIndex = currentIndex! - 1;
			onNavigate(filteredEntries[newIndex], newIndex);
		}
	}, [hasPrev, filteredEntries, currentIndex, onNavigate]);

	const goToNext = useCallback(() => {
		if (hasNext && filteredEntries && onNavigate) {
			const newIndex = currentIndex! + 1;
			onNavigate(filteredEntries[newIndex], newIndex);
		}
	}, [hasNext, filteredEntries, currentIndex, onNavigate]);

	// Register layer on mount
	useEffect(() => {
		const id = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.CONFIRM, // Use same priority as confirm modal
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			onEscape: () => {
				onCloseRef.current();
			},
		});
		layerIdRef.current = id;

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [registerLayer, unregisterLayer]);

	// Keep escape handler up to date
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, () => {
				onCloseRef.current();
			});
		}
	}, [onClose, updateLayerHandler]);

	// Focus delete button when confirmation modal appears
	useEffect(() => {
		if (showDeleteConfirm && deleteButtonRef.current) {
			deleteButtonRef.current.focus();
		}
	}, [showDeleteConfirm]);

	// Keyboard navigation for prev/next with arrow keys
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Don't handle if delete confirmation is showing
			if (showDeleteConfirm) return;

			if (e.key === 'ArrowLeft') {
				e.preventDefault();
				goToPrev();
			} else if (e.key === 'ArrowRight') {
				e.preventDefault();
				goToNext();
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [goToPrev, goToNext, showDeleteConfirm]);

	// Format timestamp
	const formatTime = (timestamp: number) => {
		const date = new Date(timestamp);
		return date.toLocaleString([], {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});
	};

	// Get pill color based on type
	const getPillColor = () => {
		if (entry.type === 'AUTO') {
			return {
				bg: theme.colors.warning + '20',
				text: theme.colors.warning,
				border: theme.colors.warning + '40',
			};
		}
		return {
			bg: theme.colors.accent + '20',
			text: theme.colors.accent,
			border: theme.colors.accent + '40',
		};
	};

	const colors = getPillColor();
	const Icon = entry.type === 'AUTO' ? Bot : User;

	// For AUTO entries:
	//   - summary = short 1-2 sentence synopsis (shown in list view and toast)
	//   - fullResponse = complete synopsis with details (shown in detail view)
	// For USER entries:
	//   - summary = the synopsis text
	//   - fullResponse = may contain more context
	const rawResponse = entry.fullResponse || entry.summary || '';
	const cleanResponse = stripAnsiCodes(rawResponse);

	return (
		<div className="fixed inset-0 flex items-center justify-center z-[9999]">
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/60" onClick={onClose} />

			{/* Modal */}
			<div
				className="relative w-full max-w-3xl max-h-[80vh] overflow-hidden rounded-lg border shadow-2xl flex flex-col"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
			>
				{/* Header */}
				<div
					className="flex items-center justify-between px-6 py-4 border-b shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-3 flex-wrap">
						{/* Success/Failure Indicator for AUTO entries */}
						{entry.type === 'AUTO' && entry.success !== undefined && (
							<span
								className="flex items-center justify-center w-6 h-6 rounded-full"
								style={{
									backgroundColor: entry.success
										? entry.validated
											? theme.colors.success
											: theme.colors.success + '20'
										: theme.colors.error + '20',
									border: `1px solid ${
										entry.success
											? entry.validated
												? theme.colors.success
												: theme.colors.success + '40'
											: theme.colors.error + '40'
									}`,
								}}
								title={
									entry.success
										? entry.validated
											? 'Task completed successfully and human-validated'
											: 'Task completed successfully'
										: 'Task failed'
								}
							>
								{entry.success ? (
									entry.validated ? (
										<DoubleCheck className="w-4 h-4" style={{ color: '#ffffff' }} />
									) : (
										<CheckCircle className="w-4 h-4" style={{ color: theme.colors.success }} />
									)
								) : (
									<XCircle className="w-4 h-4" style={{ color: theme.colors.error }} />
								)}
							</span>
						)}

						{/* Type Pill */}
						<span
							className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase"
							style={{
								backgroundColor: colors.bg,
								color: colors.text,
								border: `1px solid ${colors.border}`,
							}}
						>
							<Icon className="w-2.5 h-2.5" />
							{entry.type}
						</span>

						{/* Session ID Octet - copyable */}
						{entry.agentSessionId && (
							<div className="flex items-center gap-2">
								{/* Copy button */}
								<button
									onClick={async () => {
										await navigator.clipboard.writeText(entry.agentSessionId!);
										setCopiedSessionId(true);
										setTimeout(() => setCopiedSessionId(false), 2000);
									}}
									className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase transition-colors hover:opacity-80"
									style={{
										backgroundColor: theme.colors.accent + '20',
										color: theme.colors.accent,
										border: `1px solid ${theme.colors.accent}40`,
									}}
									title={`Copy session ID: ${entry.agentSessionId}`}
								>
									{entry.agentSessionId.split('-')[0].toUpperCase()}
									{copiedSessionId ? (
										<Check className="w-2.5 h-2.5" />
									) : (
										<Copy className="w-2.5 h-2.5" />
									)}
								</button>
								{/* Resume button - styled with same padding as other pills */}
								{onResumeSession && (
									<button
										onClick={() => {
											onResumeSession(entry.agentSessionId!);
											onClose();
										}}
										className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase transition-colors hover:opacity-80"
										style={{
											backgroundColor: theme.colors.success + '20',
											color: theme.colors.success,
											border: `1px solid ${theme.colors.success}40`,
										}}
										title={`Resume session ${entry.agentSessionId}`}
									>
										<Play className="w-2.5 h-2.5" />
										Resume
									</button>
								)}
							</div>
						)}

						{/* Timestamp */}
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{formatTime(entry.timestamp)}
						</span>

						{/* Validated toggle for AUTO entries */}
						{entry.type === 'AUTO' && entry.success && onUpdate && (
							<button
								onClick={() => onUpdate(entry.id, { validated: !entry.validated })}
								className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase transition-colors hover:opacity-80"
								style={{
									backgroundColor: entry.validated
										? theme.colors.success + '20'
										: theme.colors.bgActivity,
									color: entry.validated ? theme.colors.success : theme.colors.textDim,
									border: `1px solid ${entry.validated ? theme.colors.success + '40' : theme.colors.border}`,
								}}
								title={entry.validated ? 'Mark as not validated' : 'Mark as human-validated'}
							>
								{entry.validated ? (
									<DoubleCheck className="w-3 h-3" />
								) : (
									<Check className="w-3 h-3" />
								)}
								Validated
							</button>
						)}
					</div>

					{/* Close button */}
					<button onClick={onClose} className="p-1 rounded hover:bg-white/10 transition-colors">
						<X className="w-5 h-5" style={{ color: theme.colors.textDim }} />
					</button>
				</div>

				{/* Stats Panel - shown when we have usage stats */}
				{(entry.usageStats || entry.elapsedTimeMs) && (
					<div
						className="px-6 py-4 border-b shrink-0"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain + '40',
						}}
					>
						<div className="flex items-center gap-6 flex-wrap">
							{/* Context Window Widget - calculated from usageStats */}
							{entry.usageStats && entry.usageStats.contextWindow > 0 && (
								<div className="flex items-center gap-3">
									<div className="flex items-center gap-1.5">
										<Cpu className="w-4 h-4" style={{ color: theme.colors.textDim }} />
										<span
											className="text-[10px] font-bold uppercase"
											style={{ color: theme.colors.textDim }}
										>
											Context
										</span>
									</div>
									{(() => {
										// Context usage using agent-specific calculation
										// Note: History entries don't store agent type, defaults to Claude behavior
										const contextTokens = calculateContextTokens({
											inputTokens: entry.usageStats!.inputTokens,
											outputTokens: entry.usageStats!.outputTokens,
											cacheCreationInputTokens: entry.usageStats!.cacheCreationInputTokens ?? 0,
											cacheReadInputTokens: entry.usageStats!.cacheReadInputTokens ?? 0,
										});
										const contextUsage = Math.min(
											100,
											Math.round((contextTokens / entry.usageStats!.contextWindow) * 100)
										);
										return (
											<div className="flex flex-col gap-1">
												<div className="flex items-center gap-2">
													<div
														className="w-24 h-2 rounded-full overflow-hidden"
														style={{ backgroundColor: theme.colors.border }}
													>
														<div
															className="h-full transition-all duration-500 ease-out"
															style={{
																width: `${contextUsage}%`,
																backgroundColor: getContextColor(contextUsage, theme),
															}}
														/>
													</div>
													<span
														className="text-xs font-mono font-bold"
														style={{ color: getContextColor(contextUsage, theme) }}
													>
														{contextUsage}%
													</span>
												</div>
												<span
													className="text-[10px] font-mono"
													style={{ color: theme.colors.textDim }}
												>
													{(contextTokens / 1000).toFixed(1)}k /{' '}
													{(entry.usageStats!.contextWindow / 1000).toFixed(0)}k tokens
												</span>
											</div>
										);
									})()}
								</div>
							)}

							{/* Token Breakdown - hidden on small screens for responsive design */}
							{entry.usageStats && (
								<div className="hidden sm:flex items-center gap-3">
									<div className="flex items-center gap-1.5">
										<Zap className="w-4 h-4" style={{ color: theme.colors.textDim }} />
										<span
											className="text-[10px] font-bold uppercase"
											style={{ color: theme.colors.textDim }}
										>
											Tokens
										</span>
									</div>
									<div className="flex items-center gap-3 text-xs font-mono">
										<span style={{ color: theme.colors.accent }}>
											<span style={{ color: theme.colors.textDim }}>In:</span>{' '}
											{entry.usageStats.inputTokens.toLocaleString()}
										</span>
										<span style={{ color: theme.colors.success }}>
											<span style={{ color: theme.colors.textDim }}>Out:</span>{' '}
											{entry.usageStats.outputTokens.toLocaleString()}
										</span>
									</div>
								</div>
							)}

							{/* Elapsed Time */}
							{entry.elapsedTimeMs !== undefined && (
								<div className="flex items-center gap-2">
									<Clock className="w-4 h-4" style={{ color: theme.colors.textDim }} />
									<span
										className="text-xs font-mono font-bold"
										style={{ color: theme.colors.textMain }}
									>
										{formatElapsedTime(entry.elapsedTimeMs)}
									</span>
								</div>
							)}

							{/* Cost */}
							{entry.usageStats && entry.usageStats.totalCostUsd > 0 && (
								<span className="text-xs font-mono font-bold px-2 py-0.5 rounded-full border border-green-500/30 text-green-500 bg-green-500/10">
									${entry.usageStats.totalCostUsd.toFixed(2)}
								</span>
							)}
						</div>
					</div>
				)}

				{/* Content - with prose styles for consistent markdown rendering */}
				<div
					className="history-detail-content flex-1 overflow-y-auto px-6 py-5 scrollbar-thin"
					style={{ color: theme.colors.textMain }}
				>
					<style>{proseStyles}</style>
					<MarkdownRenderer
						content={cleanResponse}
						theme={theme}
						onCopy={(text) => navigator.clipboard.writeText(text)}
						fileTree={fileTree}
						cwd={cwd}
						projectRoot={projectRoot}
						onFileClick={onFileClick}
						allowRawHtml
					/>
				</div>

				{/* Footer */}
				<div
					className="flex items-center justify-between px-6 py-4 border-t shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					{/* Delete button */}
					<button
						onClick={() => setShowDeleteConfirm(true)}
						className="flex items-center gap-2 px-3 py-2 rounded text-sm font-medium transition-colors hover:opacity-90"
						style={{
							backgroundColor: theme.colors.error + '20',
							color: theme.colors.error,
							border: `1px solid ${theme.colors.error}40`,
						}}
						title="Delete this history entry"
					>
						<Trash2 className="w-4 h-4" />
						Delete
					</button>

					{/* Prev/Next navigation buttons - centered */}
					{canNavigate && (
						<div className="flex items-center gap-3">
							<button
								onClick={goToPrev}
								disabled={!hasPrev}
								className="flex items-center gap-1 px-3 py-2 rounded text-sm font-medium transition-colors"
								style={{
									backgroundColor: hasPrev ? theme.colors.bgActivity : 'transparent',
									color: hasPrev ? theme.colors.textMain : theme.colors.textDim,
									border: `1px solid ${hasPrev ? theme.colors.border : theme.colors.border + '40'}`,
									opacity: hasPrev ? 1 : 0.4,
									cursor: hasPrev ? 'pointer' : 'default',
								}}
								title={hasPrev ? 'Previous entry (←)' : 'No previous entry'}
							>
								<ChevronLeft className="w-4 h-4" />
								Prev
							</button>
							<button
								onClick={goToNext}
								disabled={!hasNext}
								className="flex items-center gap-1 px-3 py-2 rounded text-sm font-medium transition-colors"
								style={{
									backgroundColor: hasNext ? theme.colors.bgActivity : 'transparent',
									color: hasNext ? theme.colors.textMain : theme.colors.textDim,
									border: `1px solid ${hasNext ? theme.colors.border : theme.colors.border + '40'}`,
									opacity: hasNext ? 1 : 0.4,
									cursor: hasNext ? 'pointer' : 'default',
								}}
								title={hasNext ? 'Next entry (→)' : 'No next entry'}
							>
								Next
								<ChevronRight className="w-4 h-4" />
							</button>
						</div>
					)}

					<button
						onClick={onClose}
						className="px-4 py-2 rounded text-sm font-medium transition-colors hover:opacity-90"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						Close
					</button>
				</div>
			</div>

			{/* Delete Confirmation Modal */}
			{showDeleteConfirm && (
				<div
					className="fixed inset-0 flex items-center justify-center z-[10001]"
					onClick={() => setShowDeleteConfirm(false)}
				>
					<div className="absolute inset-0 bg-black/60" />
					<div
						className="relative w-[400px] border rounded-lg shadow-2xl overflow-hidden"
						style={{
							backgroundColor: theme.colors.bgSidebar,
							borderColor: theme.colors.border,
						}}
						onClick={(e) => e.stopPropagation()}
					>
						<div
							className="p-4 border-b flex items-center justify-between"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="flex items-center gap-2">
								<Trash2 className="w-4 h-4" style={{ color: theme.colors.error }} />
								<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
									Delete History Entry
								</h2>
							</div>
							<button
								onClick={() => setShowDeleteConfirm(false)}
								style={{ color: theme.colors.textDim }}
							>
								<X className="w-4 h-4" />
							</button>
						</div>
						<div className="p-6">
							<div className="flex gap-4">
								<div
									className="flex-shrink-0 p-2 rounded-full h-fit"
									style={{ backgroundColor: `${theme.colors.error}20` }}
								>
									<AlertTriangle className="w-5 h-5" style={{ color: theme.colors.error }} />
								</div>
								<p className="leading-relaxed" style={{ color: theme.colors.textMain }}>
									Are you sure you want to delete this {entry.type === 'AUTO' ? 'auto' : 'user'}{' '}
									history entry? This action cannot be undone.
								</p>
							</div>
							<div className="mt-6 flex justify-end gap-2">
								<button
									onClick={() => setShowDeleteConfirm(false)}
									onKeyDown={(e) => {
										if (e.key === 'Enter') {
											e.stopPropagation();
											setShowDeleteConfirm(false);
										}
									}}
									className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								>
									Cancel
								</button>
								<button
									ref={deleteButtonRef}
									onClick={() => {
										if (onDelete) {
											onDelete(entry.id);
										}
										setShowDeleteConfirm(false);
										onClose();
									}}
									onKeyDown={(e) => {
										if (e.key === 'Enter') {
											e.stopPropagation();
											if (onDelete) {
												onDelete(entry.id);
											}
											setShowDeleteConfirm(false);
											onClose();
										}
									}}
									className="px-4 py-2 rounded text-white outline-none focus:ring-2 focus:ring-offset-2"
									style={{ backgroundColor: theme.colors.error }}
									tabIndex={0}
								>
									Delete
								</button>
							</div>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
