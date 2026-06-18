/**
 * ThoughtStreamPanel - floating, persistent introspection of an Auto Run's
 * live thinking/reasoning stream.
 *
 * Mounted once, app-wide (next to CenterFlash in App.tsx). It reads
 * `thoughtStreamStore` and renders nothing until a session's panel is opened
 * via the brain button on the Auto Run card.
 *
 * Three states:
 * - Hidden:    no session focused.
 * - Minimized: a slim status pill (bottom-right). Capture KEEPS running.
 * - Open:      the full panel - searchable, auto-tailing thought log.
 *
 * Closing (the X) stops capture and clears the buffer; minimizing does not.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Brain, Search, Minus, X } from 'lucide-react';
import type { Theme } from '../types';
import { useThoughtStreamStore, type ThoughtEntry } from '../stores/thoughtStreamStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

interface ThoughtStreamPanelProps {
	theme: Theme;
}

/** Split `text` into [before, match, after, before, match, ...] segments for highlighting. */
function highlightSegments(text: string, query: string): { text: string; match: boolean }[] {
	if (!query) return [{ text, match: false }];
	const segments: { text: string; match: boolean }[] = [];
	const lower = text.toLowerCase();
	const q = query.toLowerCase();
	let i = 0;
	while (i < text.length) {
		const found = lower.indexOf(q, i);
		if (found === -1) {
			segments.push({ text: text.slice(i), match: false });
			break;
		}
		if (found > i) segments.push({ text: text.slice(i, found), match: false });
		segments.push({ text: text.slice(found, found + q.length), match: true });
		i = found + q.length;
	}
	return segments;
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
	const stickToBottomRef = useRef(true);

	const entries: ThoughtEntry[] = useMemo(() => buffer?.entries ?? [], [buffer]);
	const trimmed = buffer?.trimmed ?? false;

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return entries;
		return entries.filter((e) => e.text.toLowerCase().includes(q));
	}, [entries, query]);

	const searching = query.trim().length > 0;

	// Escape minimizes (keeps capture) rather than closing - the least
	// destructive default. Only registered while the full panel is open.
	useModalLayer(MODAL_PRIORITIES.THOUGHT_STREAM, 'Thought Stream', minimizePanel, {
		enabled: !!panelSessionId && !minimized,
		blocksLowerLayers: false,
		capturesFocus: false,
		focusTrap: 'none',
	});

	// Auto-tail: when stuck to bottom and not searching, follow new thoughts.
	useEffect(() => {
		if (minimized || searching) return;
		if (!stickToBottomRef.current) return;
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [filtered, minimized, searching]);

	if (!panelSessionId) return null;

	const totalCount = entries.length;
	const label = sessionName || `${panelSessionId.slice(0, 8)}`;

	// When minimized, render nothing - capture keeps running in the store/listener
	// regardless of whether this panel is mounted. The "Capturing" affordance lives
	// on the Auto Run card's "View Thoughts" button, which re-expands on click.
	if (minimized) return null;

	// Inset the panel within the Right Panel: a gutter on each side keeps it
	// narrower than the panel and centers it (the Right Panel hugs the viewport's
	// right edge, so an equal `right` offset and width reduction = centered). The
	// gutter scales with panel width so it tracks resize. When the Right Panel is
	// closed, fall back to a fixed width anchored near the right edge.
	const gutter = rightPanelOpen
		? Math.round(Math.min(40, Math.max(12, rightPanelWidth * 0.06)))
		: 16;
	const panelWidth = rightPanelOpen ? Math.max(280, rightPanelWidth - gutter * 2) : 440;

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
						{label} · {totalCount} thought{totalCount === 1 ? '' : 's'}
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
					stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
				}}
				className="flex-1 overflow-y-auto px-3 py-2 scrollbar-thin select-text"
				style={{ color: theme.colors.textMain }}
			>
				{filtered.length === 0 ? (
					<p className="text-xs italic mt-2" style={{ color: theme.colors.textDim }}>
						{searching
							? 'No thoughts match your search.'
							: isCapturing
								? 'Waiting for the agent to start thinking...'
								: 'No thoughts captured.'}
					</p>
				) : (
					<div className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
						{filtered.map((entry) => (
							<span key={entry.id}>
								{highlightSegments(entry.text, query.trim()).map((seg, i) =>
									seg.match ? (
										<mark
											key={i}
											style={{
												backgroundColor: theme.colors.warning,
												color: theme.colors.bgSidebar,
											}}
										>
											{seg.text}
										</mark>
									) : (
										<span key={i}>{seg.text}</span>
									)
								)}
							</span>
						))}
					</div>
				)}
			</div>

			{searching && (
				<div
					className="px-3 py-1.5 border-t text-[10px] shrink-0"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					{filtered.length} of {totalCount} thought{totalCount === 1 ? '' : 's'} match
				</div>
			)}
		</div>
	);
}
