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
import { Brain, Search, Trash2, X } from 'lucide-react';
import type { Theme } from '../types';
import {
	useThoughtStreamStore,
	groupThoughtsIntoBlocks,
	isThoughtStreamLive,
	THOUGHT_LIVE_WINDOW_MS,
	type ThoughtEntry,
	type ThoughtBlock,
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

	const entries: ThoughtEntry[] = useMemo(() => buffer?.entries ?? [], [buffer]);
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

	// Group the granular per-flush entries into timestamped blocks, then show
	// newest-first (the live block sits at the top and grows; older blocks scroll
	// down into history).
	const blocks: ThoughtBlock[] = useMemo(() => groupThoughtsIntoBlocks(entries), [entries]);

	const searching = query.trim().length > 0;

	// Compact, theme-aware prose styling for the rendered thought markdown,
	// scoped so it can't bleed into other prose containers (shared generator).
	const proseStyles = useMemo(
		() => generateTerminalProseStyles(theme, '.thought-stream-prose'),
		[theme]
	);

	const visibleBlocks = useMemo(() => {
		const q = query.trim().toLowerCase();
		const matched = q ? blocks.filter((b) => b.text.toLowerCase().includes(q)) : blocks;
		// Reverse a copy for newest-on-top display without mutating the memoized list.
		return [...matched].reverse();
	}, [blocks, query]);

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
	}, [visibleBlocks, searching]);

	if (!panelSessionId) return null;

	const totalCount = entries.length;
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
						{label} · {totalCount} thought{totalCount === 1 ? '' : 's'}
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
						placeholder="Search thoughts..."
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
				{visibleBlocks.length === 0 ? (
					<p className="text-xs italic mt-2" style={{ color: theme.colors.textDim }}>
						{searching
							? 'No thoughts match your search.'
							: 'Nothing captured yet. Thoughts are buffered as the agent thinks, so this fills in on its own.'}
					</p>
				) : (
					<div className="flex flex-col gap-3">
						{visibleBlocks.map((block) => (
							<div key={block.id}>
								<div
									className="text-[10px] font-mono mb-1 select-none"
									style={{ color: theme.colors.textDim }}
									title={new Date(block.startTimestamp).toLocaleString()}
								>
									{formatThoughtTime(block.startTimestamp)}
								</div>
								<div
									className="prose max-w-none break-words"
									style={{ fontSize: '0.75rem', color: theme.colors.textMain }}
								>
									<Markdown
										preset="document"
										content={block.text}
										theme={theme}
										frontmatter={false}
										searchHighlight={
											searching ? { query: query.trim(), currentMatchIndex: -1 } : undefined
										}
									/>
								</div>
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
					{visibleBlocks.length} of {blocks.length} block{blocks.length === 1 ? '' : 's'} match
				</div>
			)}
		</div>
	);
}
