import { useState, useMemo, useRef, useEffect, useCallback, memo } from 'react';
import { Search, Star, MessageSquare, Bot, Wrench, Brain, AlertTriangle } from 'lucide-react';
import type { AITab, LogEntry, Shortcut, Theme } from '../types';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { useListNavigation } from '../hooks';
import { useDebouncedValue } from '../hooks/utils/useThrottle';
import { useFocusOnMount } from '../hooks/utils/useFocusAfterRender';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { EscCloseButton } from './ui/EscCloseButton';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { formatRelativeTime } from '../utils/formatters';
import {
	searchTabsMessages,
	flattenCrossTabMatches,
	type CrossTabSearchMatch,
} from '../utils/crossTabSearch';

export interface CrossTabSearchJumpTarget {
	tabId: string;
	logId: string;
	/** The query that produced the hit, so the transcript's Find bar can adopt it. */
	query: string;
	regex: boolean;
}

interface CrossTabSearchModalProps {
	theme: Theme;
	/** AI tabs of the active agent - the entire search corpus. */
	tabs: AITab[];
	/** Highlighted so the user can tell "this hit is in the tab I'm already on". */
	activeTabId: string | null;
	shortcut?: Shortcut;
	onJump: (target: CrossTabSearchJumpTarget) => void;
	onClose: () => void;
}

interface SourceMeta {
	label: string;
	Icon: typeof MessageSquare;
	tone: 'accent' | 'main' | 'dim' | 'error';
}

/**
 * Icon + label for the entry's role, so a hit's origin is readable at a glance.
 *
 * Resolved per call rather than held in a module-level map: a map would read
 * every icon binding at import time, which throws in any test that partially
 * mocks lucide-react and only transitively imports this module.
 */
function getSourceMeta(source: LogEntry['source']): SourceMeta {
	switch (source) {
		case 'user':
			return { label: 'You', Icon: MessageSquare, tone: 'accent' };
		case 'ai':
			return { label: 'Agent', Icon: Bot, tone: 'main' };
		case 'thinking':
			return { label: 'Thinking', Icon: Brain, tone: 'dim' };
		case 'tool':
			return { label: 'Tool', Icon: Wrench, tone: 'dim' };
		case 'error':
			return { label: 'Error', Icon: AlertTriangle, tone: 'error' };
		case 'stderr':
			return { label: 'Output', Icon: AlertTriangle, tone: 'error' };
		case 'stdout':
			return { label: 'Output', Icon: MessageSquare, tone: 'dim' };
		default:
			return { label: 'System', Icon: AlertTriangle, tone: 'dim' };
	}
}

/** Render a snippet with the matched span highlighted. */
const Snippet = memo(function Snippet({
	match,
	theme,
}: {
	match: CrossTabSearchMatch;
	theme: Theme;
}) {
	const [start, end] = match.range;
	return (
		<span className="text-xs leading-relaxed" style={{ color: theme.colors.textDim }}>
			{match.truncatedStart && '…'}
			{match.snippet.slice(0, start)}
			<mark
				className="rounded px-0.5"
				style={{ backgroundColor: theme.colors.accentDim, color: theme.colors.textMain }}
			>
				{match.snippet.slice(start, end)}
			</mark>
			{match.snippet.slice(end)}
			{match.truncatedEnd && '…'}
		</span>
	);
});

/**
 * Search message history across every open AI tab of the current agent
 * (Opt+Cmd+F). Cmd+F searches the tab you're looking at; this searches all of
 * them and jumps you to the hit.
 */
export function CrossTabSearchModal({
	theme,
	tabs,
	activeTabId,
	shortcut,
	onJump,
	onClose,
}: CrossTabSearchModalProps) {
	const [query, setQuery] = useState('');
	const [regexMode, setRegexMode] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const selectedRowRef = useRef<HTMLButtonElement>(null);

	useModalLayer(MODAL_PRIORITIES.CROSS_TAB_SEARCH, 'Search Messages (All Agent Tabs)', onClose);

	// Land the caret in the search box however the modal was opened: keyboard
	// shortcut, tab-bar popover, or command palette. Deferred, because the
	// surface that opened us restores focus on its way out in the same commit.
	useFocusOnMount(inputRef);

	// PERF: the corpus is every log entry in every open tab, so don't re-scan on
	// each keystroke.
	const debouncedQuery = useDebouncedValue(query, 150);

	const result = useMemo(
		() => searchTabsMessages(tabs, debouncedQuery, { regex: regexMode }),
		[tabs, debouncedQuery, regexMode]
	);

	const flat = useMemo(() => flattenCrossTabMatches(result), [result]);

	const handleSelect = useCallback(
		(index: number) => {
			const hit = flat[index];
			if (!hit) return;
			onJump({
				tabId: hit.tab.tabId,
				logId: hit.match.logId,
				query: debouncedQuery.trim(),
				regex: regexMode,
			});
			onClose();
		},
		[flat, onJump, onClose, debouncedQuery, regexMode]
	);

	const { selectedIndex, setSelectedIndex, handleKeyDown } = useListNavigation({
		listLength: flat.length,
		onSelect: handleSelect,
		enablePageNavigation: true,
		wrap: true,
	});

	useEffect(() => {
		selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
	}, [selectedIndex]);

	const onInputKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			// Opt+Cmd+R toggles regex without leaving the input, mirroring the chip.
			if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyR') {
				e.preventDefault();
				setRegexMode((prev) => !prev);
				return;
			}
			if (e.key === 'Enter') e.stopPropagation();
			handleKeyDown(e);
		},
		[handleKeyDown]
	);

	// Running index across the grouped render, so keyboard and mouse agree.
	let rowIndex = -1;

	return (
		<div className="fixed inset-0 modal-overlay flex items-start justify-center pt-16 z-[9999] animate-in fade-in duration-100">
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Search Messages (All Agent Tabs)"
				tabIndex={-1}
				className="modal-w-lg rounded-xl shadow-2xl border overflow-hidden flex flex-col max-h-[700px] outline-none select-none"
				style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
			>
				{/* Search header */}
				<div
					className="p-4 border-b flex items-center gap-3"
					style={{ borderColor: theme.colors.border }}
				>
					<Search className="w-5 h-5 shrink-0" style={{ color: theme.colors.textDim }} />
					<input
						ref={inputRef}
						className="flex-1 bg-transparent outline-none text-lg placeholder-opacity-50 select-text"
						placeholder={
							regexMode ? 'Regex across all open tabs…' : 'Search messages across all open tabs…'
						}
						style={{ color: theme.colors.textMain }}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={onInputKeyDown}
					/>
					{/* Same chip as the in-tab Find bar so the two searches read as one family */}
					<button
						onClick={() => setRegexMode((prev) => !prev)}
						className="flex items-center justify-center gap-1.5 pl-1 pr-2 py-1 rounded border text-xs font-medium whitespace-nowrap transition-colors shrink-0"
						style={{
							borderColor: result.error ? theme.colors.error : theme.colors.accent,
							backgroundColor: theme.colors.accent + '20',
							color: theme.colors.accent,
						}}
						title={regexMode ? 'Switch to plain-text search' : 'Switch to regex search'}
						aria-pressed={regexMode}
					>
						<span
							className="px-1.5 py-0.5 rounded font-mono leading-none"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
						>
							{regexMode ? '.*' : 'Aa'}
						</span>
						<span>{regexMode ? 'Regex' : 'Plain Text'}</span>
					</button>
					{shortcut && (
						<span className="text-xs font-mono opacity-60" style={{ color: theme.colors.textDim }}>
							{formatShortcutKeys(shortcut.keys)}
						</span>
					)}
					<EscCloseButton theme={theme} onClose={onClose} />
				</div>

				{/* Summary strip */}
				<div
					className="px-4 py-2 border-b flex items-center gap-2 text-xs"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					{result.error ? (
						<span style={{ color: theme.colors.error }}>Invalid regex: {result.error}</span>
					) : (
						<>
							<span>
								{result.totalMatches} {result.totalMatches === 1 ? 'message' : 'messages'} in{' '}
								{result.tabs.length} {result.tabs.length === 1 ? 'tab' : 'tabs'}
							</span>
							{result.truncated && (
								<span style={{ color: theme.colors.warning }}>
									· showing the first {flat.length}, narrow the search to see the rest
								</span>
							)}
						</>
					)}
					<span className="ml-auto opacity-70">Searching {tabs.length} open tabs</span>
				</div>

				{/* Results */}
				<div className="flex-1 overflow-y-auto scrollbar-thin">
					{flat.length === 0 ? (
						<div className="px-4 py-10 text-center text-sm" style={{ color: theme.colors.textDim }}>
							{debouncedQuery.trim() && !result.error
								? 'No matching messages'
								: 'Type to search every open tab in this agent'}
						</div>
					) : (
						result.tabs.map((tabResult) => (
							<div key={tabResult.tabId}>
								<div
									className="sticky top-0 z-10 px-4 py-1.5 flex items-center gap-2 text-xs font-medium backdrop-blur"
									style={{
										backgroundColor: theme.colors.bgSidebar,
										color: theme.colors.textMain,
										borderBottom: `1px solid ${theme.colors.border}`,
									}}
								>
									{tabResult.starred && (
										<Star
											className="w-3 h-3 shrink-0"
											style={{ color: theme.colors.warning }}
											fill="currentColor"
										/>
									)}
									<span className="truncate">{tabResult.tabName}</span>
									{tabResult.tabId === activeTabId && (
										<span
											className="px-1.5 py-0.5 rounded-full text-[10px] leading-none"
											style={{
												backgroundColor: `${theme.colors.accent}20`,
												color: theme.colors.accent,
											}}
										>
											current
										</span>
									)}
									<span className="ml-auto opacity-60">
										{tabResult.totalMatches} {tabResult.totalMatches === 1 ? 'hit' : 'hits'}
									</span>
								</div>

								{tabResult.matches.map((match) => {
									rowIndex++;
									const index = rowIndex;
									const isSelected = index === selectedIndex;
									const meta = getSourceMeta(match.source);
									const toneColor =
										meta.tone === 'accent'
											? theme.colors.accent
											: meta.tone === 'error'
												? theme.colors.error
												: meta.tone === 'main'
													? theme.colors.textMain
													: theme.colors.textDim;
									return (
										<button
											key={match.logId}
											ref={isSelected ? selectedRowRef : undefined}
											onClick={() => handleSelect(index)}
											onMouseEnter={() => setSelectedIndex(index)}
											className="w-full text-left px-4 py-2 flex flex-col gap-1 transition-colors"
											style={{
												backgroundColor: isSelected ? `${theme.colors.accent}22` : 'transparent',
												borderLeft: `2px solid ${isSelected ? theme.colors.accent : 'transparent'}`,
											}}
										>
											<div className="flex items-center gap-2 text-[10px]">
												<meta.Icon className="w-3 h-3 shrink-0" style={{ color: toneColor }} />
												<span style={{ color: toneColor }}>{meta.label}</span>
												<span style={{ color: theme.colors.textDim, opacity: 0.7 }}>
													{formatRelativeTime(match.timestamp)}
												</span>
												{match.matchCount > 1 && (
													<span
														className="px-1.5 py-0.5 rounded-full leading-none"
														style={{
															backgroundColor: `${theme.colors.accent}20`,
															color: theme.colors.accent,
														}}
													>
														{match.matchCount} matches
													</span>
												)}
											</div>
											<Snippet match={match} theme={theme} />
										</button>
									);
								})}
							</div>
						))
					)}
				</div>

				{/* Footer hints */}
				<div
					className="px-4 py-2 border-t flex items-center gap-4 text-[11px]"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					<span>↑↓ navigate</span>
					<span>↵ jump to message</span>
					<span>{formatShortcutKeys(['Alt', 'Meta', 'r'])} regex</span>
				</div>
			</div>
		</div>
	);
}
