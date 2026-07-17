/**
 * ThinkingStatusPill - Displays status when AI is actively processing/thinking.
 * Shows session name, bytes received, elapsed time, and Claude session ID.
 * Appears centered above the input area when the AI is busy.
 *
 * When AutoRun is active, shows a special AutoRun pill with total elapsed time instead.
 */
import { memo, useState, useEffect, useRef } from 'react';
import { GitBranch } from 'lucide-react';
import type { Session, Theme, AITab, BatchRunState, ThinkingItem } from '../types';
import { formatTokensCompact } from '../utils/formatters';
import { useThoughtStreamStore } from '../stores/thoughtStreamStore';
import { useUIStore } from '../stores/uiStore';

/**
 * Open the live Thought Stream for a session and make sure it's visible.
 *
 * The Thought Stream is docked inside the Right Panel and renders nothing while
 * that panel is collapsed (see ThoughtStreamPanel), so we open the Right Panel
 * too. Capture itself is session-agnostic (useThoughtStreamCaptureListener taps
 * the raw thinking stream for any owned session), so this works for a regular
 * interactive "thinking" session, not just an Auto Run - it's what turns the
 * previously inert status pill into a "zoom in and see what the agent is doing"
 * affordance. Uses getState() so wiring a click handler doesn't add a store
 * subscription to the memoized pill.
 */
function openThoughtStreamForSession(sessionId: string): void {
	useUIStore.getState().setRightPanelOpen(true);
	useThoughtStreamStore.getState().openPanel(sessionId);
}

interface ThinkingStatusPillProps {
	/** Pre-filtered flat list of (session, tab) pairs — one entry per busy tab across all agents.
	 * PERF: Caller should memoize this to avoid O(n) filter on every render. */
	thinkingItems: ThinkingItem[];
	theme: Theme;
	onSessionClick?: (sessionId: string, tabId?: string) => void;
	namedSessions?: Record<string, string>; // Claude session ID -> custom name
	// AutoRun state for the active session - when provided and running, shows AutoRun pill instead
	autoRunState?: BatchRunState;
	activeSessionId?: string;
	// Active AI tab within the active session. When forced-parallel runs two busy tabs in
	// the same agent, the pill follows this tab so the display matches what Stop interrupts.
	activeTabId?: string;
	// Callback to stop auto-run (shows stop button in AutoRunPill when provided)
	onStopAutoRun?: () => void;
	// Callback to interrupt the current AI session
	onInterrupt?: () => void;
}

// ElapsedTimeDisplay - shows time since thinking started
const ElapsedTimeDisplay = memo(
	({ startTime, textColor }: { startTime: number; textColor: string }) => {
		const [elapsedSeconds, setElapsedSeconds] = useState(() =>
			Math.floor((Date.now() - startTime) / 1000)
		);

		useEffect(() => {
			const interval = setInterval(() => {
				setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
			}, 1000);
			return () => clearInterval(interval);
		}, [startTime]);

		const formatTime = (seconds: number): string => {
			const days = Math.floor(seconds / 86400);
			const hours = Math.floor((seconds % 86400) / 3600);
			const mins = Math.floor((seconds % 3600) / 60);
			const secs = seconds % 60;

			if (days > 0) {
				return `${days}d ${hours}h ${mins}m ${secs}s`;
			} else if (hours > 0) {
				return `${hours}h ${mins}m ${secs}s`;
			} else {
				return `${mins}m ${secs}s`;
			}
		};

		return (
			<span className="font-mono text-xs" style={{ color: textColor }}>
				{formatTime(elapsedSeconds)}
			</span>
		);
	}
);

ElapsedTimeDisplay.displayName = 'ElapsedTimeDisplay';

// Helper to get display name for a thinking item (used in pill and dropdown)
// Priority: 1. namedSessions lookup, 2. tab name, 3. UUID octet
function getItemDisplayName(
	session: Session,
	tab: AITab | null,
	namedSessions?: Record<string, string>
): string {
	// Use tab's agentSessionId if available, fallback to session's (legacy)
	const agentSessionId = tab?.agentSessionId || session.agentSessionId;

	// Priority 1: Named session from namedSessions lookup
	if (agentSessionId) {
		const customName = namedSessions?.[agentSessionId];
		if (customName) return customName;
	}

	// Priority 2: Tab name if available
	if (tab?.name) {
		return tab.name;
	}

	// Priority 3: UUID octet (first 8 chars uppercase)
	if (agentSessionId) {
		return agentSessionId.substring(0, 8).toUpperCase();
	}

	// Fall back to Maestro session name
	return session.name;
}

// formatTokensCompact imported from ../utils/formatters

// Single row in the expanded dropdown — represents one (session, tab) thinking item
const ThinkingItemRow = memo(
	({
		item,
		theme,
		namedSessions,
		onSessionClick,
	}: {
		item: ThinkingItem;
		theme: Theme;
		namedSessions?: Record<string, string>;
		onSessionClick?: (sessionId: string, tabId?: string) => void;
	}) => {
		const { session, tab } = item;
		const tabDisplayName = getItemDisplayName(session, tab, namedSessions);
		const maestroName = session.name; // The name from the left sidebar
		const tokens = session.currentCycleTokens || 0;
		const thinkingStartTime = tab?.thinkingStartTime || session.thinkingStartTime;

		return (
			<button
				onClick={() => {
					onSessionClick?.(session.id, tab?.id);
					openThoughtStreamForSession(session.id);
				}}
				className="flex items-center justify-between gap-3 w-full px-3 py-2 text-left hover:bg-white/5 transition-colors"
				style={{ color: theme.colors.textMain }}
			>
				<div className="flex items-center gap-2 min-w-0">
					{/* Pulsing yellow circle indicator */}
					<div
						className="w-2 h-2 rounded-full shrink-0 animate-pulse"
						style={{ backgroundColor: theme.colors.warning }}
					/>
					{/* Maestro session name (from left bar) + Tab name */}
					<span className="text-xs truncate">
						<span className="font-medium">{maestroName}</span>
						<span style={{ color: theme.colors.textDim }}> / </span>
						<span className="font-mono" style={{ color: theme.colors.textDim }}>
							{tabDisplayName}
						</span>
					</span>
				</div>
				<div
					className="flex items-center gap-2 shrink-0 text-xs"
					style={{ color: theme.colors.textDim }}
				>
					{tokens > 0 && <span>{formatTokensCompact(tokens)}</span>}
					{thinkingStartTime && (
						<ElapsedTimeDisplay startTime={thinkingStartTime} textColor={theme.colors.textDim} />
					)}
				</div>
			</button>
		);
	}
);

ThinkingItemRow.displayName = 'ThinkingItemRow';

// Resolve AutoRun task progress: prefer multi-doc aggregate counts when available,
// fall back to single-doc legacy fields. Mirrors RightPanel.tsx so displays stay in sync.
function getAutoRunTaskCounts(autoRunState: BatchRunState): { completed: number; total: number } {
	const { totalTasksAcrossAllDocs } = autoRunState;
	const useAggregate = !!totalTasksAcrossAllDocs && totalTasksAcrossAllDocs > 0;
	return {
		completed: useAggregate
			? autoRunState.completedTasksAcrossAllDocs
			: autoRunState.completedTasks,
		total: useAggregate ? totalTasksAcrossAllDocs : autoRunState.totalTasks,
	};
}

// AutoRun entry inside a "Running Processes" dropdown. When onStop is provided it renders a
// per-row Stop button — used when AutoRun is demoted from the pill (because the focused tab is
// busy) so the user can still stop AutoRun without losing it to a navigation-only list.
const AutoRunRow = memo(
	({
		theme,
		completedTasks,
		totalTasks,
		isStopping,
		onStop,
	}: {
		theme: Theme;
		completedTasks: number;
		totalTasks: number;
		isStopping?: boolean;
		onStop?: () => void;
	}) => (
		<div
			className="flex items-center justify-between gap-3 w-full px-3 py-2"
			style={{ color: theme.colors.textMain }}
		>
			<div className="flex items-center gap-2 min-w-0">
				<div
					className="w-2 h-2 rounded-full shrink-0 animate-pulse"
					style={{ backgroundColor: theme.colors.accent }}
				/>
				<span className="text-xs font-medium">{isStopping ? 'AutoRun Stopping' : 'AutoRun'}</span>
			</div>
			<div className="flex items-center gap-2 shrink-0">
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					{completedTasks}/{totalTasks} tasks
				</span>
				{onStop && (
					<button
						onClick={() => !isStopping && onStop()}
						disabled={isStopping}
						className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
							isStopping ? 'cursor-not-allowed' : 'hover:opacity-80'
						}`}
						style={{
							backgroundColor: isStopping ? theme.colors.warning : theme.colors.error,
							color: isStopping ? theme.colors.bgMain : 'white',
							pointerEvents: isStopping ? 'none' : 'auto',
						}}
						title={
							isStopping ? 'Stopping after current task...' : 'Stop auto-run after current task'
						}
					>
						<svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor">
							<rect x="6" y="6" width="12" height="12" rx="1" />
						</svg>
						{isStopping ? 'Stopping' : 'Stop'}
					</button>
				)}
			</div>
		</div>
	)
);

AutoRunRow.displayName = 'AutoRunRow';

/**
 * AutoRunPill - Shows when AutoRun is active
 * Displays total elapsed time since AutoRun started, with task progress.
 * Includes a stop button when onStop callback is provided.
 */
const AutoRunPill = memo(
	({
		theme,
		autoRunState,
		onStop,
		thinkingItems,
		namedSessions,
		onSessionClick,
	}: {
		theme: Theme;
		autoRunState: BatchRunState;
		onStop?: () => void;
		thinkingItems?: ThinkingItem[];
		namedSessions?: Record<string, string>;
		onSessionClick?: (sessionId: string, tabId?: string) => void;
	}) => {
		const [isExpanded, setIsExpanded] = useState(false);
		const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		const startTime = autoRunState.startTime || Date.now();
		const { isStopping } = autoRunState;
		const { completed: completedTasks, total: totalTasks } = getAutoRunTaskCounts(autoRunState);
		const concurrentCount = thinkingItems?.length || 0;

		const handleHoverEnter = () => {
			if (closeTimerRef.current) {
				clearTimeout(closeTimerRef.current);
				closeTimerRef.current = null;
			}
			setIsExpanded(true);
		};

		const handleHoverLeave = () => {
			if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
			closeTimerRef.current = setTimeout(() => {
				setIsExpanded(false);
				closeTimerRef.current = null;
			}, 150);
		};

		useEffect(() => {
			return () => {
				if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
			};
		}, []);

		return (
			// `status-pill-container` enables the container queries in index.css that drop
			// non-essential segments on narrow widths so the Stop button never bleeds off-screen.
			<div className="status-pill-container relative flex justify-center pb-2 -mt-2 min-w-0 px-2">
				<div
					className="relative flex items-center gap-2 px-4 py-1.5 rounded-full max-w-full min-w-0"
					style={{
						backgroundColor: theme.colors.accent + '20',
						border: `1px solid ${theme.colors.accent}50`,
					}}
				>
					{/* Pulsing accent circle indicator */}
					<div
						className="w-2.5 h-2.5 rounded-full shrink-0 animate-pulse"
						style={{ backgroundColor: theme.colors.accent }}
					/>

					{/* AutoRun label */}
					<span
						className="text-xs font-semibold shrink-0"
						style={{ color: isStopping ? theme.colors.warning : theme.colors.accent }}
					>
						{isStopping ? 'AutoRun Stopping' : 'AutoRun'}
					</span>

					{/* Worktree indicator */}
					{autoRunState.worktreeActive && (
						<span title={`Worktree: ${autoRunState.worktreeBranch || 'active'}`}>
							<GitBranch className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />
						</span>
					)}

					{/* Progress — goal percent for goal runs, task count otherwise. Each branch
					    carries its own divider; the label words drop on very narrow widths (pill-label). */}
					{autoRunState.goalMode ? (
						<div
							className="flex items-center gap-2 shrink-0 text-xs"
							style={{ color: theme.colors.textDim }}
							title={autoRunState.goalRationale || undefined}
						>
							<div className="w-px h-4" style={{ backgroundColor: theme.colors.border }} />
							<div className="flex items-center gap-1">
								<span className="pill-label">Goal:</span>
								<span className="font-medium" style={{ color: theme.colors.textMain }}>
									{autoRunState.goalProgress ?? 0}%
								</span>
								{autoRunState.goalIteration ? (
									<span className="opacity-70 pill-label">
										· iteration {autoRunState.goalIteration}
									</span>
								) : null}
							</div>
						</div>
					) : (
						<div
							className="flex items-center gap-2 shrink-0 text-xs"
							style={{ color: theme.colors.textDim }}
						>
							<div className="w-px h-4" style={{ backgroundColor: theme.colors.border }} />
							<div className="flex items-center gap-1">
								<span className="pill-label">Tasks:</span>
								<span className="font-medium" style={{ color: theme.colors.textMain }}>
									{completedTasks}/{totalTasks}
								</span>
							</div>
						</div>
					)}

					{/* Total elapsed time */}
					<div
						className="flex items-center gap-2 shrink-0 text-xs"
						style={{ color: theme.colors.textDim }}
					>
						<div className="w-px h-4" style={{ backgroundColor: theme.colors.border }} />
						<div className="flex items-center gap-1">
							<span className="pill-label">Elapsed:</span>
							<ElapsedTimeDisplay startTime={startTime} textColor={theme.colors.textMain} />
						</div>
					</div>

					{/* Stop button - only show when callback provided and not already stopping */}
					{onStop && (
						<>
							<div className="w-px h-4 shrink-0" style={{ backgroundColor: theme.colors.border }} />
							<button
								onClick={() => !isStopping && onStop()}
								disabled={isStopping}
								className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors ${
									isStopping ? 'cursor-not-allowed' : 'hover:opacity-80'
								}`}
								style={{
									backgroundColor: isStopping ? theme.colors.warning : theme.colors.error,
									color: isStopping ? theme.colors.bgMain : 'white',
									pointerEvents: isStopping ? 'none' : 'auto',
								}}
								title={
									isStopping ? 'Stopping after current task...' : 'Stop auto-run after current task'
								}
							>
								{isStopping ? (
									<svg
										className="w-3 h-3 animate-spin"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
									>
										<circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
										<path d="M12 2a10 10 0 0 1 10 10" />
									</svg>
								) : (
									<svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
										<rect x="6" y="6" width="12" height="12" rx="1" />
									</svg>
								)}
								{isStopping ? 'Stopping' : 'Stop'}
							</button>
						</>
					)}

					{/* Concurrent thinking items indicator */}
					{concurrentCount > 0 && (
						<>
							<div className="w-px h-4 shrink-0" style={{ backgroundColor: theme.colors.border }} />
							<div
								onMouseEnter={handleHoverEnter}
								onMouseLeave={handleHoverLeave}
								className="w-5 h-5 rounded-full flex items-center justify-center cursor-pointer hover:scale-110 transition-transform"
								style={{
									backgroundColor: theme.colors.warning + '40',
									border: `1px solid ${theme.colors.warning}60`,
								}}
								title={`+${concurrentCount} more running`}
							>
								<span className="text-[10px] font-bold" style={{ color: theme.colors.warning }}>
									+{concurrentCount}
								</span>
							</div>
						</>
					)}

					{/* Expanded dropdown — anchored to the pill so its width matches the pill. */}
					{concurrentCount > 0 && isExpanded && (
						<div
							className="absolute inset-x-0 bottom-full pb-1 z-50"
							onMouseEnter={handleHoverEnter}
							onMouseLeave={handleHoverLeave}
						>
							<div
								className="rounded-lg shadow-xl overflow-hidden"
								style={{
									backgroundColor: theme.colors.bgSidebar,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								<div
									className="px-3 py-1.5 text-[10px] uppercase tracking-wide font-semibold"
									style={{
										color: theme.colors.textDim,
										backgroundColor: theme.colors.bgActivity,
									}}
								>
									Running Processes
								</div>
								{/* AutoRun entry — stop lives on the pill itself, so no per-row Stop here */}
								<AutoRunRow
									theme={theme}
									completedTasks={completedTasks}
									totalTasks={totalTasks}
									isStopping={isStopping}
								/>
								{/* Concurrent thinking items */}
								{thinkingItems?.map((item) => (
									<ThinkingItemRow
										key={`${item.session.id}-${item.tab?.id ?? 'legacy'}`}
										item={item}
										theme={theme}
										namedSessions={namedSessions}
										onSessionClick={onSessionClick}
									/>
								))}
							</div>
						</div>
					)}
				</div>
			</div>
		);
	}
);

AutoRunPill.displayName = 'AutoRunPill';

/**
 * ThinkingStatusPill Inner Component
 * Shows the primary thinking item with an expandable list when multiple tabs are thinking.
 * Each "thinking item" is a (session, tab) pair — one entry per busy tab across all agents.
 * Features: pulsing indicator, session name, bytes/tokens, elapsed time, Claude session UUID.
 *
 * When AutoRun is active for the active session, shows AutoRunPill with +N badge for concurrent items.
 */
function ThinkingStatusPillInner({
	thinkingItems,
	theme,
	onSessionClick,
	namedSessions,
	autoRunState,
	activeSessionId,
	activeTabId,
	onStopAutoRun,
	onInterrupt,
}: ThinkingStatusPillProps) {
	const [isExpanded, setIsExpanded] = useState(false);
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const handleHoverEnter = () => {
		if (closeTimerRef.current) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
		setIsExpanded(true);
	};

	const handleHoverLeave = () => {
		if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
		closeTimerRef.current = setTimeout(() => {
			setIsExpanded(false);
			closeTimerRef.current = null;
		}, 150);
	};

	useEffect(() => {
		return () => {
			if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
		};
	}, []);

	// Does the tab the user is currently viewing have its own live request? AutoRun spawns its
	// agent in isolation and does NOT mark any tab as state='busy' (see
	// useAgentExecution.spawnAgentForSession), so a matching entry here is a real, separately
	// interruptible request (e.g. a force-send the user fired while AutoRun runs in the background).
	const focusedTabBusy = Boolean(
		activeTabId &&
		thinkingItems.some(
			(item) => item.session.id === activeSessionId && item.tab?.id === activeTabId
		)
	);

	// If AutoRun is active for the current session, show the AutoRun pill with concurrent
	// thinking items badge for parallel operations — UNLESS the focused tab has its own live
	// request. In that case the pill must describe the focused tab so its Stop button interrupts
	// what the user is looking at; AutoRun is demoted into the dropdown (with its own Stop) below.
	if (autoRunState?.isRunning && !focusedTabBusy) {
		return (
			<AutoRunPill
				theme={theme}
				autoRunState={autoRunState}
				onStop={onStopAutoRun}
				thinkingItems={thinkingItems}
				namedSessions={namedSessions}
				onSessionClick={onSessionClick}
			/>
		);
	}

	// thinkingItems is pre-filtered by caller (PERF optimization)
	if (thinkingItems.length === 0) {
		return null;
	}

	// AutoRun is running but demoted because the focused tab is busy — surface it in the dropdown.
	const demotedAutoRun = autoRunState?.isRunning ? autoRunState : null;

	// Primary item selection (each layer falls back to the next):
	//   1. The exact active tab in the active session — when forced-parallel runs two busy
	//      tabs in the same agent, this keeps the pill (name, elapsed time) describing the
	//      tab the user is viewing, which is also the tab Stop will interrupt.
	//   2. Any busy tab in the active session (active tab itself isn't busy).
	//   3. The first thinking item anywhere.
	const activeItem =
		(activeTabId &&
			thinkingItems.find(
				(item) => item.session.id === activeSessionId && item.tab?.id === activeTabId
			)) ||
		thinkingItems.find((item) => item.session.id === activeSessionId);
	const primaryItem = activeItem || thinkingItems[0];
	const additionalItems = thinkingItems.filter((item) => item !== primaryItem);
	// The dropdown lists every other running process. A demoted AutoRun counts as one entry, so the
	// +N badge and dropdown appear even when the focused tab is the only thinking item.
	const extraCount = additionalItems.length + (demotedAutoRun ? 1 : 0);
	const hasMultiple = extraCount > 0;

	const { session: primarySession, tab: primaryTab } = primaryItem;

	// Get tokens for current thinking cycle only (not cumulative context)
	const primaryTokens = primarySession.currentCycleTokens || 0;

	// Get display components
	const maestroSessionName = primarySession.name;

	// Use tab's agentSessionId if available, fallback to session's (legacy)
	const agentSessionId = primaryTab?.agentSessionId || primarySession.agentSessionId;

	// Priority: 1. namedSessions lookup, 2. tab's name, 3. UUID octet
	const customName = agentSessionId ? namedSessions?.[agentSessionId] : undefined;
	const tabName = primaryTab?.name;

	// Display name for the tab slot (to the left of Stop button):
	// prefer namedSessions, then tab name, then UUID octet (NOT session name - that's already shown)
	const displayClaudeId =
		customName || tabName || (agentSessionId ? agentSessionId.substring(0, 8).toUpperCase() : null);

	// For tooltip, show all available info
	const tooltipParts = [maestroSessionName];
	if (agentSessionId) tooltipParts.push(`Claude: ${agentSessionId}`);
	if (tabName) tooltipParts.push(`Tab: ${tabName}`);
	if (customName) tooltipParts.push(`Named: ${customName}`);
	const fullTooltip = tooltipParts.join(' | ');

	return (
		// Thinking Pill - centered container with negative top margin to offset parent padding.
		// `status-pill-container` enables the container queries in index.css that drop
		// non-essential segments on narrow widths so the Stop button never bleeds off-screen.
		<div className="status-pill-container relative flex justify-center pb-2 -mt-2 min-w-0 px-2">
			{/* Thinking Pill - shrinks to fit content; `relative` anchors the expanded dropdown to the pill's full width.
			    `max-w-full min-w-0` bounds the pill to the available width so the session name and an
			    over-long tab name truncate instead of wrapping the whole pill to a second line. */}
			<div
				className="relative flex items-center gap-2 px-4 py-1.5 rounded-full max-w-full min-w-0"
				style={{
					backgroundColor: theme.colors.warning + '20',
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				{/* Thinking Pill - Pulsing yellow circle indicator */}
				<div
					className="w-2.5 h-2.5 rounded-full shrink-0 animate-pulse"
					style={{ backgroundColor: theme.colors.warning }}
				/>

				{/* Maestro session name - always visible, not clickable, truncates on narrow widths */}
				<span
					className="text-xs font-medium truncate min-w-0"
					style={{ color: theme.colors.textMain }}
					title={fullTooltip}
				>
					{maestroSessionName}
				</span>

				{/* Token info / Thinking placeholder - carries its own divider so hiding the
				    segment on narrow widths (pill-seg-tokens) takes the divider with it */}
				<div
					className="pill-seg-tokens flex items-center gap-2 shrink-0 text-xs"
					style={{ color: theme.colors.textDim }}
				>
					<div className="w-px h-4" style={{ backgroundColor: theme.colors.border }} />
					{primaryTokens > 0 ? (
						<div className="flex items-center gap-1">
							<span>Tokens:</span>
							<span className="font-medium" style={{ color: theme.colors.textMain }}>
								{formatTokensCompact(primaryTokens)}
							</span>
						</div>
					) : (
						<span>Thinking...</span>
					)}
				</div>

				{/* Elapsed time - prefer tab's time for accurate parallel tracking.
				    The "Elapsed:" label word drops on very narrow widths (pill-label). */}
				{(primaryTab?.thinkingStartTime || primarySession.thinkingStartTime) && (
					<div
						className="flex items-center gap-2 shrink-0 text-xs"
						style={{ color: theme.colors.textDim }}
					>
						<div className="w-px h-4" style={{ backgroundColor: theme.colors.border }} />
						<div className="flex items-center gap-1">
							<span className="pill-label">Elapsed:</span>
							<ElapsedTimeDisplay
								startTime={primaryTab?.thinkingStartTime || primarySession.thinkingStartTime!}
								textColor={theme.colors.textMain}
							/>
						</div>
					</div>
				)}

				{/* Thinking Pill - Claude session ID / tab name.
				    First segment to drop on narrow widths (pill-seg-claude-id); still in the tooltip. */}
				{displayClaudeId && (
					<div className="pill-seg-claude-id flex items-center gap-2 min-w-0">
						<div className="w-px h-4 shrink-0" style={{ backgroundColor: theme.colors.border }} />
						<button
							onClick={() => {
								onSessionClick?.(primarySession.id, primaryTab?.id);
								openThoughtStreamForSession(primarySession.id);
							}}
							className="text-xs font-mono hover:underline cursor-pointer truncate min-w-0"
							style={{ color: theme.colors.accent }}
							title={
								agentSessionId
									? `View live thoughts · Claude Session: ${agentSessionId}`
									: 'View live thoughts'
							}
						>
							{displayClaudeId}
						</button>
					</div>
				)}

				{/* Additional thinking items indicator */}
				{hasMultiple && (
					<div
						onMouseEnter={handleHoverEnter}
						onMouseLeave={handleHoverLeave}
						className="w-5 h-5 rounded-full flex items-center justify-center cursor-pointer hover:scale-110 transition-transform"
						style={{
							backgroundColor: theme.colors.warning + '40',
							border: `1px solid ${theme.colors.warning}60`,
						}}
						title={`+${extraCount} more running`}
					>
						<span className="text-[10px] font-bold" style={{ color: theme.colors.warning }}>
							+{extraCount}
						</span>
					</div>
				)}

				{/* Stop/Interrupt button */}
				{onInterrupt && (
					<>
						<div className="w-px h-4 shrink-0" style={{ backgroundColor: theme.colors.border }} />
						<button
							type="button"
							onClick={onInterrupt}
							className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors hover:opacity-80"
							style={{
								backgroundColor: theme.colors.error,
								color: 'white',
							}}
							title="Interrupt Claude (Ctrl+C)"
						>
							<svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
								<rect x="6" y="6" width="12" height="12" rx="1" />
							</svg>
							Stop
						</button>
					</>
				)}

				{/* Expanded dropdown — anchored to the pill so its width matches the pill. */}
				{hasMultiple && isExpanded && (
					<div
						className="absolute inset-x-0 bottom-full pb-1 z-50"
						onMouseEnter={handleHoverEnter}
						onMouseLeave={handleHoverLeave}
					>
						<div
							className="rounded-lg shadow-xl overflow-hidden"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<div
								className="px-3 py-1.5 text-[10px] uppercase tracking-wide font-semibold"
								style={{
									color: theme.colors.textDim,
									backgroundColor: theme.colors.bgActivity,
								}}
							>
								{demotedAutoRun ? 'Running Processes' : 'All Thinking Sessions'}
							</div>
							{demotedAutoRun && (
								<AutoRunRow
									theme={theme}
									completedTasks={getAutoRunTaskCounts(demotedAutoRun).completed}
									totalTasks={getAutoRunTaskCounts(demotedAutoRun).total}
									isStopping={demotedAutoRun.isStopping}
									onStop={onStopAutoRun}
								/>
							)}
							{thinkingItems.map((item) => (
								<ThinkingItemRow
									key={`${item.session.id}-${item.tab?.id ?? 'legacy'}`}
									item={item}
									theme={theme}
									namedSessions={namedSessions}
									onSessionClick={onSessionClick}
								/>
							))}
						</div>
					</div>
				)}
			</div>
			{/* End Thinking Pill */}
		</div>
	);
}

// Memoized export
// PERF: thinkingItems is pre-filtered by caller, so comparator is O(n) on thinking items only,
// not O(n) on ALL sessions. This avoids the expensive filter on every keystroke.
export const ThinkingStatusPill = memo(ThinkingStatusPillInner, (prevProps, nextProps) => {
	// Check autoRunState changes first (highest priority)
	const prevAutoRun = prevProps.autoRunState;
	const nextAutoRun = nextProps.autoRunState;

	if (prevAutoRun?.isRunning !== nextAutoRun?.isRunning) return false;
	if (nextAutoRun?.isRunning) {
		// When AutoRun is active, check its properties
		if (
			prevAutoRun?.completedTasks !== nextAutoRun?.completedTasks ||
			prevAutoRun?.totalTasks !== nextAutoRun?.totalTasks ||
			prevAutoRun?.completedTasksAcrossAllDocs !== nextAutoRun?.completedTasksAcrossAllDocs ||
			prevAutoRun?.totalTasksAcrossAllDocs !== nextAutoRun?.totalTasksAcrossAllDocs ||
			prevAutoRun?.isStopping !== nextAutoRun?.isStopping ||
			prevAutoRun?.startTime !== nextAutoRun?.startTime ||
			// Goal-Driven progress fields drive the goal readout on the pill
			prevAutoRun?.goalMode !== nextAutoRun?.goalMode ||
			prevAutoRun?.goalProgress !== nextAutoRun?.goalProgress ||
			prevAutoRun?.goalIteration !== nextAutoRun?.goalIteration ||
			prevAutoRun?.goalRationale !== nextAutoRun?.goalRationale
		) {
			return false;
		}
		// Also check concurrent thinking items (shown as +N badge on AutoRun pill).
		// AutoRun doesn't mark its tab as busy, so every thinkingItem is a concurrent item.
		// activeTabId / currentCycleTokens matter too: when the focused tab has its own live
		// request, AutoRun is demoted and the pill renders that tab's primary item live.
		if (prevProps.activeSessionId !== nextProps.activeSessionId) return false;
		if (prevProps.activeTabId !== nextProps.activeTabId) return false;
		const prevConcurrent = prevProps.thinkingItems;
		const nextConcurrent = nextProps.thinkingItems;
		if (prevConcurrent.length !== nextConcurrent.length) return false;
		for (let i = 0; i < prevConcurrent.length; i++) {
			const prev = prevConcurrent[i];
			const next = nextConcurrent[i];
			if (
				prev.session.id !== next.session.id ||
				prev.session.name !== next.session.name ||
				prev.session.currentCycleTokens !== next.session.currentCycleTokens ||
				prev.tab?.id !== next.tab?.id ||
				prev.tab?.name !== next.tab?.name ||
				prev.tab?.thinkingStartTime !== next.tab?.thinkingStartTime
			) {
				return false;
			}
		}
		return prevProps.theme === nextProps.theme;
	}

	// Check if active session/tab changed - both affect which item shows as primary.
	// activeTabId matters when two busy tabs share the active session (forced parallel):
	// the busy-tab set is identical, so only the active-tab change should re-render the pill.
	if (prevProps.activeSessionId !== nextProps.activeSessionId) return false;
	if (prevProps.activeTabId !== nextProps.activeTabId) return false;

	// thinkingItems is pre-filtered by caller - just compare directly
	const prevItems = prevProps.thinkingItems;
	const nextItems = nextProps.thinkingItems;

	if (prevItems.length !== nextItems.length) return false;

	// Compare each thinking item's relevant properties
	for (let i = 0; i < prevItems.length; i++) {
		const prev = prevItems[i];
		const next = nextItems[i];
		// Compare session-level properties
		if (
			prev.session.id !== next.session.id ||
			prev.session.name !== next.session.name ||
			prev.session.agentSessionId !== next.session.agentSessionId ||
			prev.session.state !== next.session.state ||
			prev.session.thinkingStartTime !== next.session.thinkingStartTime ||
			prev.session.currentCycleTokens !== next.session.currentCycleTokens
		) {
			return false;
		}
		// Compare tab-level properties
		if (
			prev.tab?.id !== next.tab?.id ||
			prev.tab?.name !== next.tab?.name ||
			prev.tab?.agentSessionId !== next.tab?.agentSessionId ||
			prev.tab?.thinkingStartTime !== next.tab?.thinkingStartTime
		) {
			return false;
		}
	}

	// Check if namedSessions changed for any thinking item
	if (prevProps.namedSessions !== nextProps.namedSessions) {
		for (const item of nextItems) {
			const claudeId = item.tab?.agentSessionId || item.session.agentSessionId;
			if (claudeId) {
				const prevName = prevProps.namedSessions?.[claudeId];
				const nextName = nextProps.namedSessions?.[claudeId];
				if (prevName !== nextName) return false;
			}
		}
	}

	// Note: We intentionally don't compare onInterrupt/onStopAutoRun callbacks
	// because they may change reference on parent re-renders but are semantically
	// the same. The component will use the latest callback from props anyway.

	return prevProps.theme === nextProps.theme;
});

ThinkingStatusPill.displayName = 'ThinkingStatusPill';
