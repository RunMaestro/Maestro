/**
 * ThoughtStreamPanel - floating, persistent introspection of an agent's live
 * activity: its thinking/reasoning stream interleaved with every tool call it
 * makes (file reads, shell commands, edits), each tool call reduced to one short
 * plain-language line.
 *
 * Mounted once, app-wide (next to CenterFlash in App.tsx). It reads
 * `thoughtStreamStore` and renders nothing until a session's panel is opened
 * via the brain button on the Auto Run card or the footer status pill.
 *
 * Three states:
 * - Hidden:    no session focused.
 * - Minimized: a slim status pill (bottom-right). Capture KEEPS running.
 * - Open:      the full panel - searchable, auto-tailing activity feed.
 *
 * Closing (the X) stops capture and clears the buffer; minimizing does not.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Brain, Search, Minus, X, CheckCircle2, AlertCircle } from 'lucide-react';
import type { Theme } from '../types';
import {
	useThoughtStreamStore,
	groupThoughtsIntoBlocks,
	buildActivityFeed,
	type ThoughtEntry,
	type ThoughtBlock,
	type ToolActivityEntry,
	type ActivityFeedItem,
} from '../stores/thoughtStreamStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Markdown } from './Markdown';
import { generateTerminalProseStyles } from '../utils/markdownConfig';
import { Spinner } from './ui/Spinner';

interface ThoughtStreamPanelProps {
	theme: Theme;
}

/** Format a block timestamp as a stable time-of-day stamp (e.g. "3:42:07 PM"). */
function formatThoughtTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], {
		hour: 'numeric',
		minute: '2-digit',
		second: '2-digit',
	});
}

/** The plain-language line for a tool call, used for both display and search. */
function activityLine(activity: ToolActivityEntry): string {
	return activity.target ? `${activity.verb} ${activity.target}` : activity.verb;
}

/**
 * One tool call as a single line: status glyph, verb, target. Deliberately
 * terser than the in-chat tool cell (no input dump, no output preview) - this
 * feed exists so a user can scan a long run for a stall or a loop, and full
 * detail is a click away in the transcript.
 */
function ToolActivityRow({
	activity,
	theme,
	query,
}: {
	activity: ToolActivityEntry;
	theme: Theme;
	query: string;
}) {
	const statusColor =
		activity.status === 'failed'
			? theme.colors.error
			: activity.status === 'completed'
				? theme.colors.success
				: theme.colors.warning;

	// Highlight inline rather than routing the line through <Markdown>: a shell
	// command or a glob pattern is not markdown and would be mangled by it.
	// Matching is scoped to `target` so the offsets are indices into `target`.
	const matchIndex = query ? activity.target.toLowerCase().indexOf(query.toLowerCase()) : -1;

	return (
		<div
			className="flex items-start gap-2 text-[12px] leading-snug"
			title={`${activity.toolName} · ${activity.status}`}
		>
			<span className="shrink-0 mt-[3px]">
				{activity.status === 'running' ? (
					<Spinner size={11} color={statusColor} />
				) : activity.status === 'failed' ? (
					<AlertCircle className="w-3 h-3" style={{ color: statusColor }} />
				) : (
					<CheckCircle2 className="w-3 h-3" style={{ color: statusColor }} />
				)}
			</span>
			<span className="min-w-0 break-words" style={{ color: theme.colors.textMain }}>
				<span style={{ color: statusColor }}>{activity.verb}</span>
				{activity.target && (
					<>
						{' '}
						<span className="font-mono" style={{ color: theme.colors.textDim }}>
							{matchIndex >= 0 ? (
								<>
									{activity.target.slice(0, matchIndex)}
									<mark
										style={{
											backgroundColor: `${theme.colors.accent}55`,
											color: theme.colors.textMain,
										}}
									>
										{activity.target.slice(matchIndex, matchIndex + query.length)}
									</mark>
									{activity.target.slice(matchIndex + query.length)}
								</>
							) : (
								activity.target
							)}
						</span>
					</>
				)}
			</span>
		</div>
	);
}

export function ThoughtStreamPanel({ theme }: ThoughtStreamPanelProps) {
	const panelSessionId = useThoughtStreamStore((s) => s.panelSessionId);
	const minimized = useThoughtStreamStore((s) => s.minimized);
	const buffer = useThoughtStreamStore((s) =>
		panelSessionId ? s.buffers[panelSessionId] : undefined
	);
	const isCapturing = useThoughtStreamStore((s) =>
		panelSessionId ? !!s.capturing[panelSessionId] : false
	);
	const minimizePanel = useThoughtStreamStore((s) => s.minimizePanel);
	const closePanel = useThoughtStreamStore((s) => s.closePanel);

	const sessionName = useSessionStore((s) =>
		panelSessionId ? s.sessions.find((sess) => sess.id === panelSessionId)?.name : undefined
	);

	// The panel is fixed to the viewport but should live INSIDE the Right Panel
	// (which is docked to the right edge with width `rightPanelWidth`): narrower
	// than the panel, horizontally centered in it, and growing/shrinking with it.
	const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
	const rightPanelWidth = useSettingsStore((s) => s.rightPanelWidth);

	const [query, setQuery] = useState('');
	const scrollRef = useRef<HTMLDivElement>(null);
	// Newest blocks render on top, so "following" the live stream means staying
	// pinned to the TOP of the scroll area, not the bottom.
	const stickToTopRef = useRef(true);

	const entries: ThoughtEntry[] = useMemo(() => buffer?.entries ?? [], [buffer]);
	const activities: ToolActivityEntry[] = useMemo(() => buffer?.activities ?? [], [buffer]);
	const trimmed = buffer?.trimmed ?? false;

	// Group the granular per-flush entries into timestamped blocks, then show
	// newest-first (the live block sits at the top and grows; older blocks scroll
	// down into history).
	const blocks: ThoughtBlock[] = useMemo(() => groupThoughtsIntoBlocks(entries), [entries]);

	// Reasoning and tool calls share one chronological feed - a tool call that
	// happened mid-paragraph belongs between the two halves of that paragraph.
	const feed: ActivityFeedItem[] = useMemo(
		() => buildActivityFeed(blocks, activities),
		[blocks, activities]
	);

	const searching = query.trim().length > 0;

	// Compact, theme-aware prose styling for the rendered thought markdown,
	// scoped so it can't bleed into other prose containers (shared generator).
	const proseStyles = useMemo(
		() => generateTerminalProseStyles(theme, '.thought-stream-prose'),
		[theme]
	);

	const visibleItems = useMemo(() => {
		const q = query.trim().toLowerCase();
		const matched = q
			? feed.filter((item) =>
					item.kind === 'thought'
						? item.block.text.toLowerCase().includes(q)
						: // Match the rendered line and the raw tool name, so both
							// "read src/App" and "Read" find the same row.
							activityLine(item.activity).toLowerCase().includes(q) ||
							item.activity.toolName.toLowerCase().includes(q)
				)
			: feed;
		// Reverse a copy for newest-on-top display without mutating the memoized list.
		return [...matched].reverse();
	}, [feed, query]);

	// Escape minimizes (keeps capture) rather than closing - the least
	// destructive default. Only registered while the full panel is open.
	useModalLayer(MODAL_PRIORITIES.THOUGHT_STREAM, 'Thought Stream', minimizePanel, {
		enabled: !!panelSessionId && !minimized,
		blocksLowerLayers: false,
		capturesFocus: false,
		focusTrap: 'none',
	});

	// Auto-tail: when pinned to the top and not searching, follow new activity
	// (newest item is at the top).
	useEffect(() => {
		if (minimized || searching) return;
		if (!stickToTopRef.current) return;
		const el = scrollRef.current;
		if (el) el.scrollTop = 0;
	}, [visibleItems, minimized, searching]);

	if (!panelSessionId) return null;

	const totalCount = entries.length;
	const actionCount = activities.length;
	const label = sessionName || `${panelSessionId.slice(0, 8)}`;

	// When minimized, render nothing - capture keeps running in the store/listener
	// regardless of whether this panel is mounted. The "Capturing" affordance lives
	// on the Auto Run card's "View Thoughts" button, which re-expands on click.
	if (minimized) return null;

	// The Thought Stream lives inside the Right Panel, so it folds away with it:
	// when the Right Panel is collapsed we render nothing and the panel returns
	// when it re-opens. Capture is unaffected (the store/listener are independent
	// of this panel mounting).
	if (!rightPanelOpen) return null;

	// Inset the panel within the Right Panel: a gutter on each side keeps it
	// narrower than the panel and centers it (the Right Panel hugs the viewport's
	// right edge, so an equal `right` offset and width reduction = centered). The
	// gutter scales with panel width so it tracks resize.
	const gutter = Math.round(Math.min(40, Math.max(12, rightPanelWidth * 0.06)));
	const panelWidth = Math.max(280, rightPanelWidth - gutter * 2);

	// --- Full panel ---------------------------------------------------------
	return (
		<div
			className="fixed bottom-4 z-[9998] flex flex-col rounded-lg border shadow-2xl select-none"
			style={{
				right: gutter,
				width: panelWidth,
				maxWidth: 'calc(100vw - 2rem)',
				height: '70vh',
				maxHeight: 640,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			}}
		>
			{/* Header */}
			<div
				className="flex items-center gap-2 px-3 py-2.5 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<Brain
					className={`w-4 h-4 shrink-0 ${isCapturing ? 'animate-pulse' : ''}`}
					style={{ color: theme.colors.accent }}
				/>
				<div className="flex flex-col min-w-0 flex-1">
					<span
						className="text-xs font-semibold leading-tight"
						style={{ color: theme.colors.textMain }}
					>
						Thought Stream
					</span>
					<span
						className="text-[10px] truncate leading-tight"
						style={{ color: theme.colors.textDim }}
						title={label}
					>
						{label} · {totalCount} thought{totalCount === 1 ? '' : 's'} · {actionCount} action
						{actionCount === 1 ? '' : 's'}
						{trimmed ? ' (trimmed)' : ''}
						{!isCapturing ? ' · stopped' : ''}
					</span>
				</div>
				<button
					onClick={minimizePanel}
					title="Minimize (keeps capturing)"
					className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
				>
					<Minus className="w-4 h-4" style={{ color: theme.colors.textDim }} />
				</button>
				<button
					onClick={closePanel}
					title="Stop capturing and clear"
					className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
				>
					<X className="w-4 h-4" style={{ color: theme.colors.textDim }} />
				</button>
			</div>

			{/* Search */}
			<div className="px-3 py-2 border-b shrink-0" style={{ borderColor: theme.colors.border }}>
				<div
					className="flex items-center gap-2 rounded px-2 py-1.5"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					<Search className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
					<input
						type="text"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search thoughts and actions..."
						className="flex-1 bg-transparent border-none outline-none text-xs"
						style={{ color: theme.colors.textMain }}
					/>
					{searching && (
						<button
							onClick={() => setQuery('')}
							className="p-0.5 rounded hover:bg-white/10 transition-colors shrink-0"
							title="Clear search"
						>
							<X className="w-3 h-3" style={{ color: theme.colors.textDim }} />
						</button>
					)}
				</div>
			</div>

			{/* Body */}
			<div
				ref={scrollRef}
				onScroll={(e) => {
					const el = e.currentTarget;
					stickToTopRef.current = el.scrollTop < 24;
				}}
				className="thought-stream-prose flex-1 overflow-y-auto px-3 py-2 scrollbar-thin select-text"
				style={{ color: theme.colors.textMain }}
			>
				<style>{proseStyles}</style>
				{visibleItems.length === 0 ? (
					<p className="text-xs italic mt-2" style={{ color: theme.colors.textDim }}>
						{searching
							? 'Nothing matches your search.'
							: isCapturing
								? 'Waiting for the agent to start working...'
								: 'No activity captured.'}
					</p>
				) : (
					<div className="flex flex-col gap-3">
						{visibleItems.map((item) => (
							<div key={item.id}>
								<div
									className="text-[10px] font-mono mb-1 select-none"
									style={{ color: theme.colors.textDim }}
									title={new Date(item.timestamp).toLocaleString()}
								>
									{formatThoughtTime(item.timestamp)}
								</div>
								{item.kind === 'tool' ? (
									<ToolActivityRow
										activity={item.activity}
										theme={theme}
										query={searching ? query.trim() : ''}
									/>
								) : (
									<div
										className="prose max-w-none break-words"
										style={{ fontSize: '12px', color: theme.colors.textMain }}
									>
										<Markdown
											preset="document"
											content={item.block.text}
											theme={theme}
											frontmatter={false}
											searchHighlight={
												searching ? { query: query.trim(), currentMatchIndex: -1 } : undefined
											}
										/>
									</div>
								)}
							</div>
						))}
					</div>
				)}
			</div>

			{searching && (
				<div
					className="px-3 py-1.5 border-t text-[10px] shrink-0"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					{visibleItems.length} of {feed.length} entr{feed.length === 1 ? 'y' : 'ies'} match
				</div>
			)}
		</div>
	);
}
