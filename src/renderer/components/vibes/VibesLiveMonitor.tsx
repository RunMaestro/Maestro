import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
	Radio,
	FileEdit,
	FilePlus,
	FileX,
	Eye,
	Clock,
	AlertCircle,
} from 'lucide-react';
import type { Theme } from '../../types';

// ============================================================================
// Types
// ============================================================================

/** A single annotation entry from the live feed. */
interface LiveAnnotation {
	id: string;
	timestamp: string;
	file: string;
	action: 'create' | 'modify' | 'delete' | 'review';
	tool_name?: string;
	model_name?: string;
	session_id?: string;
}

/** Props for the VibesLiveMonitor component. */
interface VibesLiveMonitorProps {
	theme: Theme;
	projectPath: string | undefined;
}

// ============================================================================
// Constants
// ============================================================================

/** Polling interval for live updates (3 seconds). */
const POLL_INTERVAL_MS = 3_000;

/** Maximum annotations to keep in the feed. */
const MAX_FEED_SIZE = 5;

/** Action icon + color mapping. */
const ACTION_STYLES: Record<string, { bg: string; text: string }> = {
	create: { bg: 'rgba(34, 197, 94, 0.15)', text: '#22c55e' },
	modify: { bg: 'rgba(59, 130, 246, 0.15)', text: '#3b82f6' },
	delete: { bg: 'rgba(239, 68, 68, 0.15)', text: '#ef4444' },
	review: { bg: 'rgba(234, 179, 8, 0.15)', text: '#eab308' },
};

// ============================================================================
// Helpers
// ============================================================================

/** Format a tool name for display. */
function formatToolName(toolName?: string): string {
	if (!toolName) return 'Unknown';
	const lower = toolName.toLowerCase();
	if (lower.includes('claude') || lower.includes('claude-code')) return 'Claude Code';
	if (lower.includes('codex')) return 'Codex';
	if (lower.includes('maestro')) return 'Maestro';
	return toolName;
}

/** Format a timestamp as compact relative time. */
function formatTime(timestamp: string): string {
	const now = Date.now();
	const then = new Date(timestamp).getTime();
	if (isNaN(then)) return timestamp;

	const diffMs = now - then;
	const diffSec = Math.floor(diffMs / 1000);
	const diffMin = Math.floor(diffSec / 60);

	if (diffSec < 10) return 'just now';
	if (diffSec < 60) return `${diffSec}s ago`;
	if (diffMin < 60) return `${diffMin}m ago`;
	return new Date(timestamp).toLocaleTimeString();
}

/** Get a short display name for a file path. */
function shortFileName(filePath: string): string {
	const parts = filePath.split('/');
	if (parts.length <= 2) return filePath;
	return `.../${parts.slice(-2).join('/')}`;
}

/** Parse annotation data from getLog JSON response. */
function parseAnnotations(raw: string | undefined): LiveAnnotation[] {
	if (!raw) return [];
	try {
		const data = JSON.parse(raw);
		const list = Array.isArray(data) ? data : data.annotations ?? [];
		return list.map((entry: Record<string, unknown>, idx: number) => ({
			id: (entry.id ?? `${entry.timestamp ?? ''}-${idx}`) as string,
			timestamp: (entry.timestamp ?? entry.start_time ?? '') as string,
			file: (entry.file_path ?? entry.file ?? entry.target_file ?? '') as string,
			action: (entry.action ?? 'modify') as LiveAnnotation['action'],
			tool_name: (entry.tool_name ?? entry.toolName ?? undefined) as string | undefined,
			model_name: (entry.model_name ?? entry.modelName ?? undefined) as string | undefined,
			session_id: (entry.session_id ?? entry.sessionId ?? undefined) as string | undefined,
		}));
	} catch {
		return [];
	}
}

/** Get the action icon component. */
function ActionIcon({ action, size = 12 }: { action: string; size?: number }): React.ReactElement {
	const style = ACTION_STYLES[action] ?? ACTION_STYLES.modify;
	const props = { width: size, height: size, style: { color: style.text } };

	switch (action) {
		case 'create':
			return <FilePlus {...props} />;
		case 'delete':
			return <FileX {...props} />;
		case 'review':
			return <Eye {...props} />;
		default:
			return <FileEdit {...props} />;
	}
}

// ============================================================================
// Component
// ============================================================================

/**
 * VIBES Live Monitor — shows real-time annotation updates during active sessions.
 *
 * Features:
 * - Short-polling (3 seconds) against the annotation log
 * - Displays real-time annotation count for active sessions
 * - Compact feed of last 5 annotations with timestamp, file, action, agent type
 * - Auto-scrolls to show newest entries
 * - Non-intrusive design suitable for embedding in the Overview tab
 */
export const VibesLiveMonitor: React.FC<VibesLiveMonitorProps> = ({
	theme,
	projectPath,
}) => {
	const [annotations, setAnnotations] = useState<LiveAnnotation[]>([]);
	const [totalCount, setTotalCount] = useState<number>(0);
	const [isPolling, setIsPolling] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [lastUpdated, setLastUpdated] = useState<string | null>(null);

	const feedRef = useRef<HTMLDivElement>(null);
	const mountedRef = useRef(true);
	const prevCountRef = useRef<number>(0);

	// ========================================================================
	// Polling logic
	// ========================================================================

	const fetchLatest = useCallback(async () => {
		if (!projectPath) return;

		try {
			const result = await window.maestro.vibes.getLog(projectPath, {
				limit: MAX_FEED_SIZE,
				json: true,
			});

			if (!mountedRef.current) return;

			if (result.success && result.data) {
				const parsed = parseAnnotations(result.data);
				setAnnotations(parsed);
				setError(null);
				setLastUpdated(new Date().toISOString());

				// Parse total count from stats
				try {
					const statsResult = await window.maestro.vibes.getStats(projectPath);
					if (mountedRef.current && statsResult.success && statsResult.data) {
						const stats = JSON.parse(statsResult.data);
						const count = stats.total_annotations ?? stats.totalAnnotations ?? 0;
						const prevCount = prevCountRef.current;
						setTotalCount(count);
						prevCountRef.current = count;

						// Auto-scroll when new annotations arrive
						if (count > prevCount && feedRef.current) {
							feedRef.current.scrollTop = feedRef.current.scrollHeight;
						}
					}
				} catch {
					// Stats fetch failed — non-critical
				}
			} else if (result.error) {
				// Only set error if it's not a "build required" scenario
				const errMsg = result.error.toLowerCase();
				if (errMsg.includes('build') || errMsg.includes('database') || errMsg.includes('audit.db')) {
					setAnnotations([]);
					setTotalCount(0);
					setError(null);
				} else {
					setError(result.error);
				}
			}
		} catch (err) {
			if (mountedRef.current) {
				setError(err instanceof Error ? err.message : 'Failed to fetch live data');
			}
		}
	}, [projectPath]);

	// Start/stop polling
	useEffect(() => {
		mountedRef.current = true;

		if (!projectPath) {
			setIsPolling(false);
			return;
		}

		setIsPolling(true);

		// Initial fetch
		fetchLatest();

		// Poll every 3 seconds
		const intervalId = setInterval(() => {
			if (mountedRef.current) {
				fetchLatest();
			}
		}, POLL_INTERVAL_MS);

		return () => {
			mountedRef.current = false;
			clearInterval(intervalId);
			setIsPolling(false);
		};
	}, [projectPath, fetchLatest]);

	// ========================================================================
	// Derived state
	// ========================================================================

	const hasAnnotations = annotations.length > 0;
	const pulseColor = useMemo(() => {
		if (!isPolling || !projectPath) return theme.colors.textDim;
		if (error) return theme.colors.error;
		return theme.colors.success;
	}, [isPolling, projectPath, error, theme]);

	// ========================================================================
	// Render
	// ========================================================================

	return (
		<div
			className="flex flex-col rounded"
			style={{
				backgroundColor: theme.colors.bgActivity,
				border: `1px solid ${theme.colors.border}`,
			}}
		>
			{/* Header */}
			<div className="flex items-center gap-2 px-3 py-2">
				<Radio
					className="w-3.5 h-3.5 shrink-0"
					style={{ color: pulseColor }}
				/>
				<span
					className="text-[11px] font-semibold uppercase tracking-wider"
					style={{ color: theme.colors.textDim }}
				>
					Live Monitor
				</span>
				{isPolling && !error && (
					<span
						className="w-1.5 h-1.5 rounded-full animate-pulse"
						style={{ backgroundColor: theme.colors.success }}
					/>
				)}
				<span
					className="text-[10px] ml-auto tabular-nums"
					style={{ color: theme.colors.textDim }}
				>
					{totalCount} annotation{totalCount !== 1 ? 's' : ''}
				</span>
			</div>

			{/* Error state */}
			{error && (
				<div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px]">
					<AlertCircle className="w-3 h-3 shrink-0" style={{ color: theme.colors.error }} />
					<span style={{ color: theme.colors.error }}>{error}</span>
				</div>
			)}

			{/* Feed area */}
			{!error && (
				<div
					ref={feedRef}
					className="flex flex-col overflow-y-auto scrollbar-thin"
					style={{ maxHeight: '160px' }}
				>
					{!hasAnnotations && (
						<div
							className="flex items-center justify-center gap-1.5 px-3 py-3 text-[10px]"
							style={{ color: theme.colors.textDim }}
						>
							<Clock className="w-3 h-3" />
							<span>Waiting for annotations...</span>
						</div>
					)}

					{hasAnnotations && annotations.map((entry) => (
						<div
							key={entry.id}
							className="flex items-center gap-2 px-3 py-1.5 border-t text-[10px]"
							style={{ borderColor: theme.colors.border }}
						>
							{/* Action icon */}
							<ActionIcon action={entry.action} />

							{/* File path */}
							<span
								className="font-mono truncate min-w-0 flex-1"
								style={{ color: theme.colors.textMain }}
								title={entry.file}
							>
								{entry.file ? shortFileName(entry.file) : '—'}
							</span>

							{/* Action badge */}
							<span
								className="px-1 py-0.5 rounded text-[9px] font-semibold uppercase shrink-0"
								style={{
								backgroundColor: (ACTION_STYLES[entry.action] ?? ACTION_STYLES.modify).bg,
								color: (ACTION_STYLES[entry.action] ?? ACTION_STYLES.modify).text,
							}}
							>
								{entry.action}
							</span>

							{/* Agent type */}
							<span
								className="shrink-0 text-[9px]"
								style={{ color: theme.colors.textDim }}
							>
								{formatToolName(entry.tool_name)}
							</span>

							{/* Timestamp */}
							<span
								className="shrink-0 tabular-nums text-[9px]"
								style={{ color: theme.colors.textDim }}
							>
								{formatTime(entry.timestamp)}
							</span>
						</div>
					))}
				</div>
			)}

			{/* Footer with last updated */}
			{lastUpdated && !error && (
				<div
					className="flex items-center justify-end px-3 py-1 border-t text-[9px]"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textDim,
					}}
				>
					Updated {formatTime(lastUpdated)}
				</div>
			)}
		</div>
	);
};
