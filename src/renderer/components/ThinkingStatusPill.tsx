/**
 * ThinkingStatusPill - Displays status when AI is actively processing/thinking.
 * Shows session name, bytes received, elapsed time, and Claude session ID.
 * Appears centered above the input area when the AI is busy.
 *
 * When AutoRun is active, shows a special AutoRun pill with total elapsed time instead.
 */
import { memo, useState, useEffect } from 'react';
import { GitBranch } from 'lucide-react';
import type { Session, Theme, AITab, BatchRunState, ThinkingItem } from '../types';
import { formatTokensCompact } from '../utils/formatters';

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
				onClick={() => onSessionClick?.(session.id, tab?.id)}
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
		const startTime = autoRunState.startTime || Date.now();
		const { completedTasks, totalTasks, isStopping } = autoRunState;
		const concurrentCount = thinkingItems?.length || 0;

		return (
			<div className="relative flex justify-center pb-2 -mt-2">
				<div
					className="flex items-center gap-2 px-4 py-1.5 rounded-full"
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

					{/* Divider */}
					<div className="w-px h-4 shrink-0" style={{ backgroundColor: theme.colors.border }} />

					{/* Task progress */}
					<div
						className="flex items-center gap-1 shrink-0 text-xs"
						style={{ color: theme.colors.textDim }}
					>
						<span>Tasks:</span>
						<span className="font-medium" style={{ color: theme.colors.textMain }}>
							{completedTasks}/{totalTasks}
						</span>
					</div>

					{/* Divider */}
					<div className="w-px h-4 shrink-0" style={{ backgroundColor: theme.colors.border }} />

					{/* Total elapsed time */}
					<div
						className="flex items-center gap-1 shrink-0 text-xs"
						style={{ color: theme.colors.textDim }}
					>
						<span>Elapsed:</span>
						<ElapsedTimeDisplay startTime={startTime} textColor={theme.colors.textMain} />
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
								className="relative"
								onMouseEnter={() => setIsExpanded(true)}
								onMouseLeave={() => setIsExpanded(false)}
							>
								<div
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

								{/* Expanded dropdown — positioned above to avoid going off-screen */}
								{isExpanded && (
									<div className="absolute right-0 bottom-full pb-1 z-50">
										<div
											className="min-w-[320px] rounded-lg shadow-xl overflow-hidden"
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
											{/* AutoRun entry */}
											<div
												className="flex items-center justify-between gap-3 w-full px-3 py-2"
												style={{ color: theme.colors.textMain }}
											>
												<div className="flex items-center gap-2 min-w-0">
													<div
														className="w-2 h-2 rounded-full shrink-0 animate-pulse"
														style={{ backgroundColor: theme.colors.accent }}
													/>
													<span className="text-xs font-medium">AutoRun</span>
												</div>
												<span className="text-xs" style={{ color: theme.colors.textDim }}>
													{completedTasks}/{totalTasks} tasks
												</span>
											</div>
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
						</>
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
	onStopAutoRun,
	onInterrupt,
}: ThinkingStatusPillProps) {
	const [isExpanded, setIsExpanded] = useState(false);

	// If AutoRun is active for the current session, show the AutoRun pill
	// with concurrent thinking items badge for parallel operations.
	// AutoRun spawns its agent in isolation and does NOT mark any tab as state='busy'
	// (see useAgentExecution.spawnAgentForSession). Every entry in thinkingItems is
	// therefore legitimate concurrent work (e.g. a plan-mode / read-only tab, or a
	// force-parallel write tab) and must surface via the +N badge.
	if (autoRunState?.isRunning) {
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

	// Primary item: prioritize an item from the active session,
	// otherwise fall back to first thinking item.
	// This ensures Stop button stops the session the user is currently viewing.
	const activeItem = thinkingItems.find((item) => item.session.id === activeSessionId);
	const primaryItem = activeItem || thinkingItems[0];
	const additionalItems = thinkingItems.filter((item) => item !== primaryItem);
	const hasMultiple = additionalItems.length > 0;

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
		// Thinking Pill - centered container with negative top margin to offset parent padding
		<div className="relative flex justify-center pb-2 -mt-2">
			{/* Thinking Pill - shrinks to fit content */}
			<div
				className="flex items-center gap-2 px-4 py-1.5 rounded-full"
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

				{/* Maestro session name - always visible, not clickable */}
				<span
					className="text-xs font-medium shrink-0"
					style={{ color: theme.colors.textMain }}
					title={fullTooltip}
				>
					{maestroSessionName}
				</span>

				{/* Divider */}
				<div className="w-px h-4 shrink-0" style={{ backgroundColor: theme.colors.border }} />

				{/* Token info for this thought cycle - only show when available */}
				{primaryTokens > 0 && (
					<div
						className="flex items-center gap-1 shrink-0 text-xs"
						style={{ color: theme.colors.textDim }}
					>
						<span>Tokens:</span>
						<span className="font-medium" style={{ color: theme.colors.textMain }}>
							{formatTokensCompact(primaryTokens)}
						</span>
					</div>
				)}

				{/* Placeholder when no tokens yet */}
				{primaryTokens === 0 && (
					<div
						className="flex items-center gap-1 shrink-0 text-xs"
						style={{ color: theme.colors.textDim }}
					>
						<span>Thinking...</span>
					</div>
				)}

				{/* Elapsed time - prefer tab's time for accurate parallel tracking */}
				{(primaryTab?.thinkingStartTime || primarySession.thinkingStartTime) && (
					<>
						<div className="w-px h-4 shrink-0" style={{ backgroundColor: theme.colors.border }} />
						<div
							className="flex items-center gap-1 shrink-0 text-xs"
							style={{ color: theme.colors.textDim }}
						>
							<span>Elapsed:</span>
							<ElapsedTimeDisplay
								startTime={primaryTab?.thinkingStartTime || primarySession.thinkingStartTime!}
								textColor={theme.colors.textMain}
							/>
						</div>
					</>
				)}

				{/* Thinking Pill - Claude session ID / tab name */}
				{displayClaudeId && (
					<>
						<div className="w-px h-4 shrink-0" style={{ backgroundColor: theme.colors.border }} />
						<button
							onClick={() => onSessionClick?.(primarySession.id, primaryTab?.id)}
							className="text-xs font-mono hover:underline cursor-pointer"
							style={{ color: theme.colors.accent }}
							title={agentSessionId ? `Claude Session: ${agentSessionId}` : 'Claude Session'}
						>
							{displayClaudeId}
						</button>
					</>
				)}

				{/* Additional thinking items indicator */}
				{hasMultiple && (
					<div
						className="relative"
						onMouseEnter={() => setIsExpanded(true)}
						onMouseLeave={() => setIsExpanded(false)}
					>
						<div
							className="w-5 h-5 rounded-full flex items-center justify-center cursor-pointer hover:scale-110 transition-transform"
							style={{
								backgroundColor: theme.colors.warning + '40',
								border: `1px solid ${theme.colors.warning}60`,
							}}
							title={`+${additionalItems.length} more thinking`}
						>
							<span className="text-[10px] font-bold" style={{ color: theme.colors.warning }}>
								+{additionalItems.length}
							</span>
						</div>

						{/* Expanded dropdown - positioned above to avoid going off-screen */}
						{isExpanded && (
							<div className="absolute right-0 bottom-full pb-1 z-50">
								<div
									className="min-w-[320px] rounded-lg shadow-xl overflow-hidden"
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
										All Thinking Sessions
									</div>
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
			prevAutoRun?.isStopping !== nextAutoRun?.isStopping ||
			prevAutoRun?.startTime !== nextAutoRun?.startTime
		) {
			return false;
		}
		// Also check concurrent thinking items (shown as +N badge on AutoRun pill).
		// AutoRun doesn't mark its tab as busy, so every thinkingItem is a concurrent item.
		if (prevProps.activeSessionId !== nextProps.activeSessionId) return false;
		const prevConcurrent = prevProps.thinkingItems;
		const nextConcurrent = nextProps.thinkingItems;
		if (prevConcurrent.length !== nextConcurrent.length) return false;
		for (let i = 0; i < prevConcurrent.length; i++) {
			const prev = prevConcurrent[i];
			const next = nextConcurrent[i];
			if (
				prev.session.id !== next.session.id ||
				prev.session.name !== next.session.name ||
				prev.tab?.id !== next.tab?.id ||
				prev.tab?.name !== next.tab?.name ||
				prev.tab?.thinkingStartTime !== next.tab?.thinkingStartTime
			) {
				return false;
			}
		}
		return prevProps.theme === nextProps.theme;
	}

	// Check if activeSessionId changed - this affects which item shows as primary
	if (prevProps.activeSessionId !== nextProps.activeSessionId) return false;

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
