import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import {
	ArrowLeft,
	X,
	Bot,
	User,
	ArrowUp,
	ExternalLink,
	ChevronLeft,
	ChevronRight,
	ChevronDown,
	Eye,
	Brain,
	Pin,
	FileText,
} from 'lucide-react';
import type { Theme, Session, LogEntry, ThinkingMode } from '../../types';
import type { InboxItem, InboxFilterMode, InboxSortMode } from '../../types/agent-inbox';
import { STATUS_LABELS, STATUS_COLORS } from '../../types/agent-inbox';
import { resolveContextUsageColor } from './InboxListView';
import { formatRelativeTime } from '../../utils/formatters';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { generateTerminalProseStyles } from '../../utils/markdownConfig';

/* POLISH-04 Token Audit (@architect)
 * Line 166: bgSidebar in user bubble color-mix — CORRECT (chrome blend for user messages)
 * Line 210: bgActivity for AI bubble — CORRECT (content)
 * Line 429: bgSidebar for sidebar group header — CORRECT (chrome)
 * Line ~792: bgSidebar for unified focus header — CORRECT (chrome)
 * Line 904: bgSidebar for sidebar bg — CORRECT (chrome)
 * Line 1025: bgActivity → bgMain (textarea is nested input, needs contrast)
 * All other usages: CORRECT
 */

/* POLISH-03 Design Spec (@ux-design-expert)
 * BUBBLES:
 * - All corners: rounded-xl (uniform, no sharp edges)
 * - Padding: p-4 (remove pb-10 hack)
 * - Timestamp: inline flex row below content, text-[10px] textDim opacity 0.6, justify-end mt-2
 * - Left border: user = 3px solid success, AI = 3px solid accent
 * - Max width: 85% (unchanged)
 *
 * SIDEBAR ITEMS:
 * - Height: 48px (was 36px)
 * - Layout: status dot + vertical(name, preview) + indicators
 * - Preview: text-[10px] truncate, textDim opacity 0.5, max 60 chars, strip markdown
 * - Indicators: alignSelf flex-start, marginTop 2
 */

// @architect: lastMessage available via InboxItem type (agent-inbox.ts:13) — sidebar scroll OK at 48px (overflow-y-auto, no max-height constraint)

const MAX_LOG_ENTRIES = 50;

function FocusLogEntry({
	log,
	theme,
	showRawMarkdown,
	onToggleRaw,
}: {
	log: LogEntry;
	theme: Theme;
	showRawMarkdown: boolean;
	onToggleRaw: () => void;
}) {
	const isUser = log.source === 'user';
	const isAI = log.source === 'ai' || log.source === 'stdout';
	const isThinking = log.source === 'thinking';
	const isTool = log.source === 'tool';

	// Thinking entry — left border accent + badge
	if (isThinking) {
		return (
			<div
				className="px-4 py-2 text-sm font-mono border-l-2"
				style={{
					color: theme.colors.textMain,
					borderColor: theme.colors.accent,
				}}
			>
				<div className="flex items-center gap-2 mb-1">
					<span
						className="text-[10px] px-1.5 py-0.5 rounded"
						style={{
							backgroundColor: `${theme.colors.accent}30`,
							color: theme.colors.accent,
						}}
					>
						thinking
					</span>
					<span className="text-xs" style={{ color: theme.colors.textDim, opacity: 0.7 }}>
						{formatRelativeTime(log.timestamp)}
					</span>
				</div>
				<div
					style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.5 }}
				>
					{log.text}
				</div>
			</div>
		);
	}

	// Tool entry — compact badge with status
	if (isTool) {
		const toolInput = (log.metadata as any)?.toolState?.input as
			| Record<string, unknown>
			| undefined;
		const safeStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
		const toolDetail = toolInput
			? safeStr(toolInput.command) ||
				safeStr(toolInput.pattern) ||
				safeStr(toolInput.file_path) ||
				safeStr(toolInput.query) ||
				safeStr(toolInput.description) ||
				safeStr(toolInput.prompt) ||
				safeStr(toolInput.task_id) ||
				null
			: null;
		const toolStatus = (log.metadata as any)?.toolState?.status as string | undefined;

		return (
			<div
				className="px-4 py-1.5 text-xs font-mono border-l-2"
				style={{
					color: theme.colors.textMain,
					borderColor: theme.colors.accent,
				}}
			>
				<div className="flex items-start gap-2">
					<span
						className="px-1.5 py-0.5 rounded shrink-0"
						style={{
							backgroundColor: `${theme.colors.accent}30`,
							color: theme.colors.accent,
						}}
					>
						{log.text}
					</span>
					{toolStatus === 'running' && (
						<span className="animate-pulse shrink-0 pt-0.5" style={{ color: theme.colors.warning }}>
							●
						</span>
					)}
					{toolStatus === 'completed' && (
						<span className="shrink-0 pt-0.5" style={{ color: theme.colors.success }}>
							✓
						</span>
					)}
					{toolDetail && (
						<span
							className="opacity-70 break-words whitespace-pre-wrap"
							style={{ color: theme.colors.textMain }}
						>
							{toolDetail}
						</span>
					)}
				</div>
			</div>
		);
	}

	// User entry — right-aligned with User icon
	if (isUser) {
		return (
			<div className="flex gap-2" style={{ flexDirection: 'row-reverse' }}>
				<div
					className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center"
					style={{ backgroundColor: `${theme.colors.success}20` }}
				>
					<User className="w-3.5 h-3.5" style={{ color: theme.colors.success }} />
				</div>
				<div
					className="flex-1 min-w-0 p-4 rounded-xl border overflow-hidden text-sm"
					style={{
						backgroundColor: `color-mix(in srgb, ${theme.colors.accent} 20%, ${theme.colors.bgSidebar})`,
						borderColor: `${theme.colors.accent}40`,
						color: theme.colors.textMain,
						maxWidth: '85%',
						borderLeft: `3px solid ${theme.colors.success}`,
					}}
				>
					<div
						style={{
							whiteSpace: 'pre-wrap',
							wordBreak: 'break-word',
							fontSize: 13,
							lineHeight: 1.5,
						}}
					>
						{log.text}
					</div>
					<div className="flex justify-end mt-2">
						<span className="text-[10px]" style={{ color: theme.colors.textDim, opacity: 0.6 }}>
							{formatRelativeTime(log.timestamp)}
						</span>
					</div>
				</div>
			</div>
		);
	}

	// AI / stdout entry — left-aligned with Bot icon + markdown
	if (isAI) {
		const handleCopy = (text: string) => {
			navigator.clipboard.writeText(text).catch(() => {});
		};

		return (
			<div className="flex gap-2 group">
				<div
					className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center"
					style={{ backgroundColor: `${theme.colors.accent}20` }}
				>
					<Bot className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
				</div>
				<div
					className="flex-1 min-w-0 p-4 rounded-xl border overflow-hidden text-sm"
					style={{
						backgroundColor: theme.colors.bgActivity,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
						borderLeft: `3px solid ${theme.colors.accent}`,
					}}
				>
					{/* Raw/rendered toggle */}
					<div className="flex justify-end">
						<button
							onClick={onToggleRaw}
							aria-label={showRawMarkdown ? 'Show formatted' : 'Show plain text'}
							className="p-1 rounded opacity-0 group-hover:opacity-50 focus-visible:opacity-100 hover:!opacity-100 transition-opacity"
							style={{ color: showRawMarkdown ? theme.colors.accent : theme.colors.textDim }}
							title={showRawMarkdown ? 'Show formatted' : 'Show plain text'}
						>
							{showRawMarkdown ? (
								<Eye className="w-3.5 h-3.5" />
							) : (
								<FileText className="w-3.5 h-3.5" />
							)}
						</button>
					</div>

					{showRawMarkdown ? (
						<div
							style={{
								whiteSpace: 'pre-wrap',
								wordBreak: 'break-word',
								fontSize: 13,
								lineHeight: 1.5,
							}}
						>
							{log.text}
						</div>
					) : (
						<MarkdownRenderer content={log.text} theme={theme} onCopy={handleCopy} />
					)}

					<div className="flex justify-end mt-2">
						<span className="text-[10px]" style={{ color: theme.colors.textDim, opacity: 0.6 }}>
							{formatRelativeTime(log.timestamp)}
						</span>
					</div>
				</div>
			</div>
		);
	}

	// Fallback — should not reach here given the filter
	return null;
}

interface FocusModeViewProps {
	theme: Theme;
	item: InboxItem;
	items: InboxItem[]; // Full filtered+sorted list for prev/next
	sessions: Session[]; // For accessing AITab.logs
	currentIndex: number; // Position of item in items[]
	enterToSendAI?: boolean; // false = Cmd+Enter sends, true = Enter sends
	filterMode?: InboxFilterMode;
	setFilterMode?: (mode: InboxFilterMode) => void;
	sortMode?: InboxSortMode;
	onClose: () => void; // Close the entire modal
	onExitFocus: () => void; // Return to list view
	onNavigateItem: (index: number) => void; // Jump to item at index
	onNavigateToSession?: (sessionId: string, tabId?: string) => void;
	onQuickReply?: (sessionId: string, tabId: string, text: string) => void;
	onOpenAndReply?: (sessionId: string, tabId: string, text: string) => void;
	onMarkAsRead?: (sessionId: string, tabId: string) => void;
	onToggleThinking?: (sessionId: string, tabId: string, mode: ThinkingMode) => void;
}

// Maps STATUS_COLORS key to actual hex from theme
function resolveStatusColor(state: InboxItem['state'], theme: Theme): string {
	const colorKey = STATUS_COLORS[state];
	const colorMap: Record<string, string> = {
		success: theme.colors.success,
		warning: theme.colors.warning,
		error: theme.colors.error,
		info: theme.colors.accent,
		textMuted: theme.colors.textDim,
	};
	return colorMap[colorKey] ?? theme.colors.textDim;
}

// ============================================================================
// Compact filter control for sidebar
// ============================================================================
const FILTER_OPTIONS: { value: InboxFilterMode; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'unread', label: 'Unread' },
	{ value: 'starred', label: 'Starred' },
];

function SidebarFilter({
	value,
	onChange,
	theme,
}: {
	value: InboxFilterMode;
	onChange: (v: InboxFilterMode) => void;
	theme: Theme;
}) {
	return (
		<div className="flex items-center gap-1.5">
			{FILTER_OPTIONS.map((opt) => {
				const isActive = value === opt.value;
				return (
					<button
						key={opt.value}
						onClick={() => onChange(opt.value)}
						className="text-[11px] px-2.5 py-1 rounded-full cursor-pointer transition-all"
						onFocus={(e) => {
							e.currentTarget.style.boxShadow = `0 0 0 2px ${theme.colors.accent}`;
						}}
						onBlur={(e) => {
							e.currentTarget.style.boxShadow = 'none';
						}}
						style={{
							backgroundColor: isActive ? `${theme.colors.accent}25` : 'transparent',
							color: isActive ? theme.colors.accentText : theme.colors.textDim,
							border: isActive ? `1px solid ${theme.colors.accent}50` : '1px solid transparent',
							outline: 'none',
							opacity: isActive ? 1 : 0.6,
						}}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}

// ============================================================================
// FocusSidebar — condensed navigable list of inbox items with agent grouping
// ============================================================================
function FocusSidebar({
	items,
	currentIndex,
	theme,
	sortMode,
	filterMode,
	setFilterMode,
	onNavigateItem,
}: {
	items: InboxItem[];
	currentIndex: number;
	theme: Theme;
	sortMode?: InboxSortMode;
	filterMode?: InboxFilterMode;
	setFilterMode?: (mode: InboxFilterMode) => void;
	onNavigateItem: (index: number) => void;
}) {
	const currentRowRef = useRef<HTMLDivElement>(null);
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

	// Auto-scroll to keep the current item visible
	useEffect(() => {
		currentRowRef.current?.scrollIntoView({ block: 'nearest' });
	}, [currentIndex]);

	// Build grouped rows — always group by agent/group to avoid duplicate headers
	const rows = useMemo(() => {
		const effectiveSort = sortMode ?? 'newest';
		const useGroupName = effectiveSort === 'grouped';

		// Collect items per unique group key, preserving original index
		const groupMap = new Map<
			string,
			{ groupName: string; items: { item: InboxItem; index: number }[] }
		>();
		const groupOrder: string[] = [];
		items.forEach((itm, idx) => {
			const groupKey = useGroupName ? (itm.groupId ?? itm.groupName ?? 'Ungrouped') : itm.sessionId;
			const groupName = useGroupName ? (itm.groupName ?? 'Ungrouped') : itm.sessionName;
			if (!groupMap.has(groupKey)) {
				groupMap.set(groupKey, { groupName, items: [] });
				groupOrder.push(groupKey);
			}
			groupMap.get(groupKey)!.items.push({ item: itm, index: idx });
		});

		const result: (
			| { type: 'header'; groupKey: string; groupName: string; count: number }
			| { type: 'item'; item: InboxItem; index: number }
		)[] = [];
		for (const groupKey of groupOrder) {
			const group = groupMap.get(groupKey)!;
			result.push({
				type: 'header',
				groupKey,
				groupName: group.groupName,
				count: group.items.length,
			});
			for (const entry of group.items) {
				result.push({ type: 'item', item: entry.item, index: entry.index });
			}
		}
		return result;
	}, [items, sortMode]);

	return (
		<div className="flex flex-col">
			{/* Filter control header */}
			{filterMode !== undefined && setFilterMode && (
				<div
					className="flex items-center justify-center px-2 py-2 border-b"
					style={{ borderColor: theme.colors.border }}
				>
					<SidebarFilter value={filterMode} onChange={setFilterMode} theme={theme} />
				</div>
			)}
			{/* Item list */}
			<div role="listbox" aria-label="Inbox items" className="flex-1 overflow-y-auto py-1">
				{(() => {
					let activeGroup: string | null = null;
					return rows.map((row, rowIdx) => {
						if (row.type === 'header') {
							activeGroup = row.groupKey;
							return (
								<div
									key={`header-${row.groupKey}-${rowIdx}`}
									tabIndex={0}
									role="button"
									aria-expanded={!collapsedGroups.has(row.groupKey)}
									onClick={() => {
										setCollapsedGroups((prev) => {
											const next = new Set(prev);
											if (next.has(row.groupKey)) next.delete(row.groupKey);
											else next.add(row.groupKey);
											return next;
										});
									}}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											setCollapsedGroups((prev) => {
												const next = new Set(prev);
												if (next.has(row.groupKey)) next.delete(row.groupKey);
												else next.add(row.groupKey);
												return next;
											});
										}
									}}
									className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider cursor-pointer"
									onFocus={(e) => {
										e.currentTarget.style.boxShadow = `inset 0 0 0 2px ${theme.colors.accent}`;
									}}
									onBlur={(e) => {
										e.currentTarget.style.boxShadow = 'none';
									}}
									style={{
										color: theme.colors.textDim,
										fontWeight: 600,
										backgroundColor: theme.colors.bgSidebar,
										outline: 'none',
									}}
								>
									{collapsedGroups.has(row.groupKey) ? (
										<ChevronRight className="w-3 h-3" />
									) : (
										<ChevronDown className="w-3 h-3" />
									)}
									{row.groupName}
									<span style={{ color: theme.colors.textDim, opacity: 0.5, marginLeft: 'auto' }}>
										{row.type === 'header' ? row.count : 0}
									</span>
								</div>
							);
						}

						// Skip items in collapsed groups
						if (activeGroup && collapsedGroups.has(activeGroup)) return null;

						const itm = row.item;
						const idx = row.index;
						const isCurrent = idx === currentIndex;
						const statusColor = resolveStatusColor(itm.state, theme);

						const previewText = itm.lastMessage
							? itm.lastMessage.replace(/[#*`>]/g, '').slice(0, 60)
							: '';

						return (
							<div
								key={`${itm.sessionId}-${itm.tabId}`}
								ref={isCurrent ? currentRowRef : undefined}
								tabIndex={0}
								role="option"
								aria-selected={isCurrent}
								onClick={() => onNavigateItem(idx)}
								onKeyDown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										onNavigateItem(idx);
									}
								}}
								className="flex items-center gap-2 px-3 cursor-pointer transition-colors"
								style={{
									height: 48,
									backgroundColor: isCurrent ? `${theme.colors.accent}15` : 'transparent',
									borderLeft: isCurrent
										? `2px solid ${theme.colors.accent}`
										: '2px solid transparent',
								}}
								onMouseEnter={(e) => {
									if (!isCurrent)
										e.currentTarget.style.backgroundColor = `${theme.colors.accent}08`;
								}}
								onMouseLeave={(e) => {
									if (!isCurrent) e.currentTarget.style.backgroundColor = 'transparent';
								}}
								onFocus={(e) => {
									if (!isCurrent)
										e.currentTarget.style.backgroundColor = `${theme.colors.accent}08`;
								}}
								onBlur={(e) => {
									if (!isCurrent) e.currentTarget.style.backgroundColor = 'transparent';
								}}
							>
								{/* Status dot with unread badge (matches Left Bar) */}
								<div className="relative flex-shrink-0">
									<div className="w-2 h-2 rounded-full" style={{ backgroundColor: statusColor }} />
									{itm.hasUnread && (
										<div
											className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full"
											style={{ backgroundColor: theme.colors.accent }}
											title="Unread messages"
										/>
									)}
								</div>
								{/* Name + preview vertical stack */}
								<div className="flex-1 flex flex-col gap-0.5 min-w-0">
									<span
										className="text-xs truncate"
										style={{
											color: isCurrent ? theme.colors.textMain : theme.colors.textDim,
											fontWeight: isCurrent ? 600 : 400,
										}}
									>
										{itm.tabName || 'Tab'}
									</span>
									{previewText && (
										<span
											className="text-[10px] truncate"
											style={{ color: theme.colors.textDim, opacity: 0.5 }}
										>
											{previewText}
										</span>
									)}
								</div>
							</div>
						);
					});
				})()}
			</div>
		</div>
	);
}

export default function FocusModeView({
	theme,
	item,
	items,
	sessions,
	currentIndex,
	enterToSendAI,
	filterMode,
	setFilterMode,
	sortMode,
	onClose,
	onExitFocus,
	onNavigateItem,
	onQuickReply,
	onOpenAndReply,
	onMarkAsRead,
	onToggleThinking,
}: FocusModeViewProps) {
	const statusColor = resolveStatusColor(item.state, theme);
	const hasValidContext = item.contextUsage !== undefined && !isNaN(item.contextUsage);

	// ---- Resizable sidebar ----
	const [sidebarWidth, setSidebarWidth] = useState(300);
	const sidebarWidthRef = useRef(sidebarWidth);
	sidebarWidthRef.current = sidebarWidth;
	const isResizingRef = useRef(false);
	const resizeCleanupRef = useRef<(() => void) | null>(null);

	// Unmount safety: clean up resize listeners if component unmounts mid-drag
	useEffect(() => {
		return () => {
			resizeCleanupRef.current?.();
			resizeCleanupRef.current = null;
		};
	}, []);

	const handleResizeStart = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		// Clean up any lingering listeners from rapid clicks
		resizeCleanupRef.current?.();
		isResizingRef.current = true;
		const startX = e.clientX;
		const startWidth = sidebarWidthRef.current;

		const onMouseMove = (ev: MouseEvent) => {
			if (!isResizingRef.current) return;
			const newWidth = Math.max(200, Math.min(440, startWidth + (ev.clientX - startX)));
			setSidebarWidth(newWidth);
		};

		const cleanup = () => {
			isResizingRef.current = false;
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			resizeCleanupRef.current = null;
		};

		const onMouseUp = () => {
			cleanup();
		};

		resizeCleanupRef.current = cleanup;
		document.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', onMouseUp);
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
	}, []);
	const contextColor = hasValidContext
		? resolveContextUsageColor(item.contextUsage!, theme)
		: undefined;

	// Truncate helper
	const truncate = (str: string, max: number) =>
		str.length > max ? str.slice(0, max) + '...' : str;

	// Session existence check (session may be deleted while focus mode is open)
	const sessionExists = sessions.some((s) => s.id === item.sessionId);

	// ---- Thinking toggle state (3-state: off → on → sticky → off) ----
	// Read showThinking from the actual tab property (synced with main app)
	const showThinking: ThinkingMode = useMemo(() => {
		const session = sessions.find((s) => s.id === item.sessionId);
		if (!session) return 'off';
		const tab = session.aiTabs.find((t) => t.id === item.tabId);
		return tab?.showThinking ?? 'off';
	}, [sessions, item.sessionId, item.tabId]);

	const cycleThinking = useCallback(() => {
		const nextMode: ThinkingMode =
			showThinking === 'off' ? 'on' : showThinking === 'on' ? 'sticky' : 'off';
		if (onToggleThinking) {
			onToggleThinking(item.sessionId, item.tabId, nextMode);
		}
	}, [showThinking, item.sessionId, item.tabId, onToggleThinking]);

	// ---- Raw markdown toggle (per-session, not per-log) ----
	const [showRawMarkdown, setShowRawMarkdown] = useState(false);

	// Compute conversation tail — last N renderable log entries
	const logs = useMemo(() => {
		const session = sessions.find((s) => s.id === item.sessionId);
		if (!session) return [];
		const tab = session.aiTabs.find((t) => t.id === item.tabId);
		if (!tab) return [];
		// Include all renderable log types
		const relevant = tab.logs.filter(
			(log) =>
				log.source === 'ai' ||
				log.source === 'stdout' ||
				log.source === 'user' ||
				log.source === 'thinking' ||
				log.source === 'tool'
		);
		// Take last N entries
		return relevant.slice(-MAX_LOG_ENTRIES);
	}, [sessions, item.sessionId, item.tabId]);

	// Filter out thinking/tool when toggle is off
	const visibleLogs = useMemo(() => {
		if (showThinking !== 'off') return logs;
		return logs.filter((log) => log.source !== 'thinking' && log.source !== 'tool');
	}, [logs, showThinking]);

	// Memoized prose styles — same as TerminalOutput, scoped to .focus-mode-prose
	const proseStyles = useMemo(
		() => generateTerminalProseStyles(theme, '.focus-mode-prose'),
		[theme]
	);

	// Auto-scroll to bottom ONLY if user is near bottom (within 150px) or item changed
	const scrollRef = useRef<HTMLDivElement>(null);
	const prevScrollItemRef = useRef<string>('');

	useEffect(() => {
		if (!scrollRef.current) return;
		const el = scrollRef.current;
		const itemKey = `${item.sessionId}:${item.tabId}`;
		const isNewItem = prevScrollItemRef.current !== itemKey;
		if (isNewItem) {
			prevScrollItemRef.current = itemKey;
			el.scrollTop = el.scrollHeight;
			return;
		}
		// Only auto-scroll if user is near bottom
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		if (distanceFromBottom < 150) {
			el.scrollTop = el.scrollHeight;
		}
	}, [visibleLogs, item.sessionId, item.tabId]);

	// ---- Reply state ----
	const [replyText, setReplyText] = useState('');
	const replyInputRef = useRef<HTMLTextAreaElement>(null);

	// Auto-focus reply input when entering focus mode or switching items.
	useEffect(() => {
		const rafId = requestAnimationFrame(() => {
			replyInputRef.current?.focus();
		});
		return () => cancelAnimationFrame(rafId);
	}, [item.sessionId, item.tabId]);

	// Reset reply text and textarea height when item changes (prev/next navigation)
	useEffect(() => {
		setReplyText('');
		if (replyInputRef.current) {
			replyInputRef.current.style.height = 'auto';
		}
	}, [item.sessionId, item.tabId]);

	const handleQuickReply = useCallback(() => {
		const text = replyText.trim();
		if (!text) return;
		if (onQuickReply) {
			onQuickReply(item.sessionId, item.tabId, text);
		}
		onMarkAsRead?.(item.sessionId, item.tabId);
		setReplyText('');
	}, [replyText, item, onQuickReply, onMarkAsRead]);

	const handleOpenAndReply = useCallback(() => {
		const text = replyText.trim();
		if (!text) return;
		if (onOpenAndReply) {
			onOpenAndReply(item.sessionId, item.tabId, text);
		}
		onMarkAsRead?.(item.sessionId, item.tabId);
	}, [replyText, item, onOpenAndReply, onMarkAsRead]);

	// ---- Smooth transition on item change ----
	const [isTransitioning, setIsTransitioning] = useState(false);
	const prevItemRef = useRef<string>(`${item.sessionId}-${item.tabId}`);

	useEffect(() => {
		const currentKey = `${item.sessionId}-${item.tabId}`;
		if (prevItemRef.current !== currentKey) {
			setIsTransitioning(true);
			const timer = setTimeout(() => setIsTransitioning(false), 150);
			prevItemRef.current = currentKey;
			return () => clearTimeout(timer);
		}
	}, [item.sessionId, item.tabId]);

	// Mark as read only on explicit interaction (reply), not on view.
	// This preserves the Unread filter — items stay unread until the user acts.

	return (
		<div className="flex flex-col flex-1" style={{ minHeight: 0 }}>
			{/* Header bar — single h-16 bar matching MainPanel */}
			<div
				className="h-16 border-b flex items-center justify-between px-6 shrink-0"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
			>
				{/* Left: Back button */}
				<button
					aria-label="Return to inbox list"
					onClick={onExitFocus}
					className="flex items-center gap-1.5 text-sm font-medium shrink-0"
					style={{
						background: 'transparent',
						border: 'none',
						cursor: 'pointer',
						color: theme.colors.textDim,
						padding: 0,
					}}
					onMouseEnter={(e) => (e.currentTarget.style.color = theme.colors.textMain)}
					onMouseLeave={(e) => (e.currentTarget.style.color = theme.colors.textDim)}
				>
					<ArrowLeft style={{ width: 16, height: 16 }} />
					<span>Inbox</span>
				</button>

				{/* Center: Group | Agent Name | Tab — matches app title bar pattern */}
				<div className="flex-1 flex items-center justify-center min-w-0 mx-3">
					<span
						className="text-xs select-none truncate"
						style={{ color: theme.colors.textDim, opacity: 0.5 }}
					>
						{(() => {
							const parts: string[] = [];
							if (item.groupName) parts.push(item.groupName);
							parts.push(item.sessionName);
							if (item.tabName) parts.push(item.tabName);
							return parts.join(' | ');
						})()}
					</span>
				</div>

				{/* Right: metadata badges + thinking toggle + close */}
				<div
					className="flex items-center gap-2 shrink-0 text-xs"
					style={{ color: theme.colors.textDim }}
				>
					{item.gitBranch && (
						<span
							className="px-1.5 py-0.5 rounded hidden sm:inline"
							style={{
								fontFamily: "'SF Mono', 'Menlo', monospace",
								backgroundColor: `${theme.colors.border}40`,
								color: theme.colors.textDim,
								fontSize: 11,
							}}
						>
							{truncate(item.gitBranch, 20)}
						</span>
					)}
					{hasValidContext && (
						<span className="hidden sm:inline" style={{ color: contextColor, fontSize: 11 }}>
							{item.contextUsage}%
						</span>
					)}
					<span
						style={{
							padding: '1px 8px',
							borderRadius: 10,
							backgroundColor: `${statusColor}20`,
							color: statusColor,
							whiteSpace: 'nowrap',
							fontSize: 11,
						}}
					>
						{STATUS_LABELS[item.state]}
					</span>
					{/* Thinking toggle — 3-state: off → on → sticky → off */}
					<button
						onClick={cycleThinking}
						className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all ${
							showThinking !== 'off' ? '' : 'opacity-40 hover:opacity-70'
						}`}
						style={{
							backgroundColor:
								showThinking === 'sticky'
									? `${theme.colors.warning}30`
									: showThinking === 'on'
										? `${theme.colors.accentText}25`
										: 'transparent',
							color:
								showThinking === 'sticky'
									? theme.colors.warning
									: showThinking === 'on'
										? theme.colors.accentText
										: theme.colors.textDim,
							border:
								showThinking === 'sticky'
									? `1px solid ${theme.colors.warning}50`
									: showThinking === 'on'
										? `1px solid ${theme.colors.accentText}50`
										: '1px solid transparent',
						}}
						title={
							showThinking === 'off'
								? 'Show Thinking - Click to stream AI reasoning'
								: showThinking === 'on'
									? 'Thinking (temporary) - Click for sticky mode'
									: 'Thinking (sticky) - Click to turn off'
						}
					>
						<Brain className="w-3 h-3" />
						<span>Thinking</span>
						{showThinking === 'sticky' && <Pin className="w-2.5 h-2.5" />}
					</button>
					<button
						onClick={onClose}
						aria-label="Close inbox"
						className="p-1.5 rounded ml-1"
						style={{ color: theme.colors.textDim }}
						onMouseEnter={(e) =>
							(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
						}
						onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
						title="Close (Esc)"
					>
						<X className="w-4 h-4" />
					</button>
				</div>
			</div>

			{/* Prose styles for markdown rendering — injected once at container level */}
			<style>{proseStyles}</style>

			{/* Two-column layout: sidebar + main content */}
			<div className="flex flex-1" style={{ minHeight: 0 }}>
				{/* Sidebar mini-list */}
				<div
					className="flex-shrink-0 overflow-y-auto"
					style={{
						width: sidebarWidth,
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgSidebar,
					}}
					data-testid="focus-sidebar"
				>
					<FocusSidebar
						items={items}
						currentIndex={currentIndex}
						theme={theme}
						sortMode={sortMode}
						filterMode={filterMode}
						setFilterMode={setFilterMode}
						onNavigateItem={onNavigateItem}
					/>
				</div>

				{/* Resize handle */}
				<div
					onMouseDown={handleResizeStart}
					tabIndex={0}
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize sidebar"
					onKeyDown={(e) => {
						if (e.key === 'ArrowLeft') {
							e.preventDefault();
							setSidebarWidth((w) => Math.max(200, w - 16));
						} else if (e.key === 'ArrowRight') {
							e.preventDefault();
							setSidebarWidth((w) => Math.min(440, w + 16));
						}
					}}
					style={{
						width: 4,
						cursor: 'col-resize',
						backgroundColor: 'transparent',
						borderRight: `1px solid ${theme.colors.border}`,
						flexShrink: 0,
					}}
					onMouseEnter={(e) => {
						e.currentTarget.style.backgroundColor = `${theme.colors.accent}30`;
					}}
					onMouseLeave={(e) => {
						if (!isResizingRef.current) {
							e.currentTarget.style.backgroundColor = 'transparent';
						}
					}}
					onFocus={(e) => {
						e.currentTarget.style.backgroundColor = `${theme.colors.accent}30`;
					}}
					onBlur={(e) => {
						if (!isResizingRef.current) {
							e.currentTarget.style.backgroundColor = 'transparent';
						}
					}}
				/>

				{/* Main content: conversation body + reply input */}
				<div className="flex-1 flex flex-col" style={{ minWidth: 0, minHeight: 0 }}>
					{/* Body — conversation tail */}
					{!sessionExists ? (
						<div
							className="flex-1 flex items-center justify-center"
							style={{ color: theme.colors.textDim }}
						>
							<span className="text-sm">Agent no longer available</span>
						</div>
					) : (
						<div
							ref={scrollRef}
							role="log"
							aria-label="Agent conversation"
							className="focus-mode-prose flex-1 overflow-y-auto p-4"
							style={{
								minHeight: 0,
								opacity: isTransitioning ? 0.3 : 1,
								transition: 'opacity 150ms ease',
							}}
						>
							{visibleLogs.length === 0 ? (
								<div
									className="flex items-center justify-center h-full"
									style={{ color: theme.colors.textDim }}
								>
									<span className="text-sm">No conversation yet</span>
								</div>
							) : (
								<div className="flex flex-col gap-3">
									{visibleLogs.map((log) => (
										<FocusLogEntry
											key={log.id}
											log={log}
											theme={theme}
											showRawMarkdown={showRawMarkdown}
											onToggleRaw={() => setShowRawMarkdown((v) => !v)}
										/>
									))}
								</div>
							)}
						</div>
					)}

					{/* Reply input bar */}
					<div
						className="flex items-center gap-2 px-4 py-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<textarea
							ref={replyInputRef}
							value={replyText}
							onChange={(e) => setReplyText(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') {
									if (enterToSendAI) {
										// Enter sends, Shift+Enter = Open & Reply
										if (!e.shiftKey && !e.metaKey) {
											e.preventDefault();
											handleQuickReply();
										} else if (e.shiftKey && !e.metaKey) {
											e.preventDefault();
											handleOpenAndReply();
										}
									} else {
										// Cmd+Enter sends, Shift+Enter = Open & Reply
										if (e.metaKey && !e.shiftKey) {
											e.preventDefault();
											handleQuickReply();
										} else if (e.shiftKey && !e.metaKey) {
											e.preventDefault();
											handleOpenAndReply();
										}
									}
									e.stopPropagation();
									return;
								}
								// CRITICAL: Prevent focus-mode keyboard shortcuts from firing while typing
								e.stopPropagation();
							}}
							placeholder="Reply to agent..."
							rows={1}
							aria-label="Reply to agent"
							className="flex-1 resize-none rounded-lg px-3 py-2 text-sm outline-none"
							style={{
								backgroundColor: theme.colors.bgMain, // token: bgSidebar=chrome | bgActivity=content | bgMain=nested
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
								minHeight: 36,
								maxHeight: 80,
							}}
							onInput={(e) => {
								// Auto-resize textarea
								const target = e.target as HTMLTextAreaElement;
								target.style.height = 'auto';
								target.style.height = Math.min(target.scrollHeight, 80) + 'px';
							}}
						/>
						{/* Quick Reply button (primary) */}
						<button
							onClick={handleQuickReply}
							disabled={!replyText.trim()}
							className="p-2 rounded-lg transition-colors flex-shrink-0"
							style={{
								backgroundColor: replyText.trim()
									? theme.colors.accent
									: `${theme.colors.accent}30`,
								color: replyText.trim() ? theme.colors.accentForeground : theme.colors.textDim,
								cursor: replyText.trim() ? 'pointer' : 'default',
							}}
							title={enterToSendAI ? 'Quick reply (Enter)' : 'Quick reply (⌘Enter)'}
						>
							<ArrowUp className="w-4 h-4" />
						</button>
						{/* Open & Reply button (secondary) */}
						<button
							onClick={handleOpenAndReply}
							disabled={!replyText.trim()}
							className="p-1.5 rounded-lg transition-colors flex-shrink-0 text-xs"
							style={{
								border: `1px solid ${theme.colors.border}`,
								color: replyText.trim() ? theme.colors.textMain : theme.colors.textDim,
								backgroundColor: 'transparent',
								cursor: replyText.trim() ? 'pointer' : 'default',
								opacity: replyText.trim() ? 1 : 0.5,
							}}
							title="Open session & reply (Shift+Enter)"
						>
							<ExternalLink className="w-3.5 h-3.5" />
						</button>
					</div>
				</div>
			</div>

			{/* Footer — 44px */}
			<div
				className="flex items-center justify-between px-4 border-t"
				style={{
					height: 44,
					borderColor: theme.colors.border,
				}}
			>
				{/* Prev button with shortcut badge */}
				<button
					onClick={() => onNavigateItem((currentIndex - 1 + items.length) % items.length)}
					disabled={items.length <= 1}
					aria-disabled={items.length <= 1 ? 'true' : undefined}
					aria-label="Previous item"
					className="flex items-center gap-2 text-xs px-3 py-1.5 rounded transition-colors"
					style={{
						border: `1px solid ${theme.colors.border}`,
						color: items.length > 1 ? theme.colors.textMain : theme.colors.textDim,
						backgroundColor: 'transparent',
						cursor: items.length > 1 ? 'pointer' : 'default',
						opacity: items.length <= 1 ? 0.4 : 1,
					}}
					onMouseEnter={(e) => {
						if (items.length > 1)
							e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
					}}
					onMouseLeave={(e) => {
						e.currentTarget.style.backgroundColor = 'transparent';
					}}
					title="Previous item (⌘[)"
				>
					<ChevronLeft className="w-3 h-3" />
					Prev
					<kbd
						className="text-[10px] px-1.5 py-0.5 rounded"
						style={{
							backgroundColor: `${theme.colors.border}60`,
							color: theme.colors.textDim,
						}}
					>
						⌘[
					</kbd>
				</button>

				{/* Center: counter + Esc hint */}
				<div className="flex flex-col items-center gap-0.5">
					<span
						aria-live="polite"
						className="text-sm font-medium"
						style={{ color: theme.colors.textMain }}
					>
						{currentIndex + 1} / {items.length}
					</span>
					<span className="text-xs" style={{ color: theme.colors.textDim, opacity: 0.6 }}>
						Esc Back
					</span>
				</div>

				{/* Next button with shortcut badge */}
				<button
					onClick={() => onNavigateItem((currentIndex + 1) % items.length)}
					disabled={items.length <= 1}
					aria-disabled={items.length <= 1 ? 'true' : undefined}
					aria-label="Next item"
					className="flex items-center gap-2 text-xs px-3 py-1.5 rounded transition-colors"
					style={{
						border: `1px solid ${theme.colors.border}`,
						color: items.length > 1 ? theme.colors.textMain : theme.colors.textDim,
						backgroundColor: 'transparent',
						cursor: items.length > 1 ? 'pointer' : 'default',
						opacity: items.length <= 1 ? 0.4 : 1,
					}}
					onMouseEnter={(e) => {
						if (items.length > 1)
							e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
					}}
					onMouseLeave={(e) => {
						e.currentTarget.style.backgroundColor = 'transparent';
					}}
					title="Next item (⌘])"
				>
					<kbd
						className="text-[10px] px-1.5 py-0.5 rounded"
						style={{
							backgroundColor: `${theme.colors.border}60`,
							color: theme.colors.textDim,
						}}
					>
						⌘]
					</kbd>
					Next
					<ChevronRight className="w-3 h-3" />
				</button>
			</div>
		</div>
	);
}
