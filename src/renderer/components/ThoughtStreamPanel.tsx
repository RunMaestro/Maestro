/**
 * ThoughtStreamPanel - floating, persistent introspection of an Auto Run's
 * live thinking/reasoning stream.
 *
 * Mounted once, app-wide (next to CenterFlash in App.tsx). It reads
 * `thoughtStreamStore` and renders nothing until a session's panel is opened
 * via the brain button on the Auto Run card.
 *
 * Two states: hidden (no session focused) and open (the full panel - a
 * searchable, auto-tailing thought log).
 *
 * The panel is a VIEWER, not the capture switch: buffering runs ambiently in
 * the store, so closing does not stop it and reopening shows everything the
 * agent thought while the panel was away. Discarding is the explicit trash
 * button. That is also why there is no minimize - it used to mean "hide but
 * keep capturing", which is what closing does now.
 *
 * It registers a PASSIVE layer (`blocksAppShortcuts: false`): Escape closes it
 * at the right priority, but it takes no focus and must not make the app's
 * shortcuts go dead while the user reads a wedged run's reasoning.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Brain, Check, Loader2, Search, Trash2, X } from 'lucide-react';
import type { Theme } from '../types';
import {
	useThoughtStreamStore,
	buildActivityFeed,
	isThoughtStreamLive,
	isToolEvent,
	THOUGHT_LIVE_WINDOW_MS,
	type ActivityFeedItem,
	type StreamEvent,
	type ToolActivityEntry,
} from '../stores/thoughtStreamStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Markdown } from './Markdown';
import { generateTerminalProseStyles } from '../utils/markdownConfig';

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

/** The full one-line rendering of a tool call ("Ran npm test"). */
function toolActivityText(activity: ToolActivityEntry): string {
	const { verb, target } = activity.tool.label;
	return target ? `${verb} ${target}` : verb;
}

/**
 * One tool call as a single scannable line: status glyph, verb, target.
 *
 * The text is rendered as PLAIN TEXT, not markdown. A shell command or a glob
 * pattern is full of characters markdown claims (`*`, `_`, backticks), so
 * running it through the renderer mangles exactly the lines a user is trying to
 * read. Search highlighting is therefore done here rather than delegated.
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
	const { status } = activity.tool;
	const text = toolActivityText(activity);
	const color =
		status === 'failed'
			? theme.colors.error
			: status === 'running'
				? theme.colors.accent
				: theme.colors.textDim;

	return (
		<div className="flex items-start gap-2 text-[11px] leading-snug">
			<span
				className="font-mono shrink-0 select-none pt-px"
				style={{ color: theme.colors.textDim }}
				title={new Date(activity.timestamp).toLocaleString()}
			>
				{formatThoughtTime(activity.timestamp)}
			</span>
			<span className="shrink-0 pt-0.5" style={{ color }}>
				{status === 'running' ? (
					<Loader2 className="w-3 h-3 animate-spin" aria-label="running" />
				) : status === 'failed' ? (
					<AlertTriangle className="w-3 h-3" aria-label="failed" />
				) : (
					<Check className="w-3 h-3" aria-label="completed" />
				)}
			</span>
			<span className="min-w-0 break-words" style={{ color: theme.colors.textMain }}>
				{highlightQuery(text, query, theme)}
			</span>
		</div>
	);
}

/**
 * Split `text` on the search query and wrap the matches. Case-insensitive and
 * literal (the query is user text, never a pattern).
 */
function highlightQuery(text: string, query: string, theme: Theme) {
	const q = query.trim();
	if (!q) return text;
	const lower = text.toLowerCase();
	const needle = q.toLowerCase();
	const parts: React.ReactNode[] = [];
	let from = 0;
	for (;;) {
		const at = lower.indexOf(needle, from);
		if (at === -1) break;
		if (at > from) parts.push(text.slice(from, at));
		parts.push(
			<mark key={at} style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}>
				{text.slice(at, at + needle.length)}
			</mark>
		);
		from = at + needle.length;
	}
	if (parts.length === 0) return text;
	if (from < text.length) parts.push(text.slice(from));
	return parts;
}

export function ThoughtStreamPanel({ theme }: ThoughtStreamPanelProps) {
	const panelSessionId = useThoughtStreamStore((s) => s.panelSessionId);
	const buffer = useThoughtStreamStore((s) =>
		panelSessionId ? s.buffers[panelSessionId] : undefined
	);
	const closePanel = useThoughtStreamStore((s) => s.closePanel);
	const clearBuffer = useThoughtStreamStore((s) => s.clearBuffer);

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

	const entries: StreamEvent[] = useMemo(() => buffer?.entries ?? [], [buffer]);
	const trimmed = buffer?.trimmed ?? false;
	const lastAppendAt = buffer?.lastAppendAt ?? 0;

	// "Live" is a display affordance only (capture never stops): true while
	// thoughts are still arriving, and it goes stale on its own timer so a run
	// that quietly wedged stops claiming to be thinking.
	const [live, setLive] = useState(() => isThoughtStreamLive(lastAppendAt));
	useEffect(() => {
		if (!isThoughtStreamLive(lastAppendAt)) {
			setLive(false);
			return;
		}
		setLive(true);
		const timer = setTimeout(() => setLive(false), THOUGHT_LIVE_WINDOW_MS);
		return () => clearTimeout(timer);
	}, [lastAppendAt]);

	// One walk of the session's timeline produces the whole feed: granular
	// thinking flushes coalesced into timestamped blocks, tool calls sitting
	// between the reasoning they interrupted. Displayed newest-first (the live
	// row sits at the top; older rows scroll down into history).
	const feed: ActivityFeedItem[] = useMemo(() => buildActivityFeed(entries), [entries]);

	// Header counts. Tool calls and reasoning are counted separately because
	// they answer different questions: "is it still thinking" vs "is it actually
	// doing anything", and a run stuck in a loop shows a climbing action count
	// against flat reasoning.
	const thoughtCount = useMemo(() => feed.filter((i) => i.kind === 'thought').length, [feed]);
	const actionCount = useMemo(() => entries.filter(isToolEvent).length, [entries]);

	const searching = query.trim().length > 0;

	// Compact, theme-aware prose styling for the rendered thought markdown,
	// scoped so it can't bleed into other prose containers (shared generator).
	const proseStyles = useMemo(
		() => generateTerminalProseStyles(theme, '.thought-stream-prose'),
		[theme]
	);

	const visibleFeed = useMemo(() => {
		const q = query.trim().toLowerCase();
		const matched = q
			? feed.filter((item) =>
					item.kind === 'thought'
						? item.block.text.toLowerCase().includes(q)
						: // Match the rendered line AND the raw provider tool name, so
							// searching "Bash" finds calls the feed renders as "Ran ...".
							toolActivityText(item.activity).toLowerCase().includes(q) ||
							item.activity.tool.name.toLowerCase().includes(q)
				)
			: feed;
		// Reverse a copy for newest-on-top display without mutating the memoized list.
		return [...matched].reverse();
	}, [feed, query]);

	// Escape closes the panel. Nothing is lost by that now: the buffer outlives
	// the panel, so Escape is a "put it away", not a discard.
	useModalLayer(MODAL_PRIORITIES.THOUGHT_STREAM, 'Thought Stream', closePanel, {
		enabled: !!panelSessionId,
		blocksLowerLayers: false,
		capturesFocus: false,
		blocksAppShortcuts: false,
		focusTrap: 'none',
	});

	// Auto-tail: when pinned to the top and not searching, follow new thoughts
	// (newest block is at the top).
	useEffect(() => {
		if (searching) return;
		if (!stickToTopRef.current) return;
		const el = scrollRef.current;
		if (el) el.scrollTop = 0;
	}, [visibleFeed, searching]);

	if (!panelSessionId) return null;

	const label = sessionName || `${panelSessionId.slice(0, 8)}`;

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
					className={`w-4 h-4 shrink-0 ${live ? 'animate-pulse' : ''}`}
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
						{label} · {thoughtCount} thought{thoughtCount === 1 ? '' : 's'} · {actionCount} action
						{actionCount === 1 ? '' : 's'}
						{trimmed ? ' (trimmed)' : ''}
						{live ? ' · live' : ''}
					</span>
				</div>
				<button
					onClick={() => clearBuffer(panelSessionId)}
					title="Discard buffered thoughts"
					className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
				>
					<Trash2 className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
				</button>
				<button
					onClick={closePanel}
					title="Close (thoughts keep buffering)"
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
						placeholder="Search activity..."
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
				{visibleFeed.length === 0 ? (
					<p className="text-xs italic mt-2" style={{ color: theme.colors.textDim }}>
						{searching
							? 'Nothing matches your search.'
							: 'Nothing captured yet. Thinking and tool calls are buffered as the agent works, so this fills in on its own.'}
					</p>
				) : (
					<div className="flex flex-col gap-3">
						{visibleFeed.map((item) =>
							item.kind === 'tool' ? (
								<ToolActivityRow
									key={item.activity.id}
									activity={item.activity}
									theme={theme}
									query={searching ? query : ''}
								/>
							) : (
								<div key={item.block.id}>
									<div
										className="text-[10px] font-mono mb-1 select-none"
										style={{ color: theme.colors.textDim }}
										title={new Date(item.block.startTimestamp).toLocaleString()}
									>
										{formatThoughtTime(item.block.startTimestamp)}
									</div>
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
								</div>
							)
						)}
					</div>
				)}
			</div>

			{searching && (
				<div
					className="px-3 py-1.5 border-t text-[10px] shrink-0"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					{visibleFeed.length} of {feed.length} entr{feed.length === 1 ? 'y' : 'ies'} match
				</div>
			)}
		</div>
	);
}
