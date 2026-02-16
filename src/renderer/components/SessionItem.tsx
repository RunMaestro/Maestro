import React, { memo } from 'react';
import {
	Activity,
	GitBranch,
	Bot,
	Bookmark,
	AlertCircle,
	Server,
	FolderTree,
	ChevronRight,
	Pin,
} from 'lucide-react';
import { GhostIconButton } from './ui/GhostIconButton';
import { LongPressable, longPressMouseEvent } from './shared/LongPressable';
import { WorktreePill } from './ui/WorktreePill';
import { CueIndicator } from './SessionList/CueIndicator';
import { StartupCommandIndicator } from './SessionList/StartupCommandIndicator';
import { WizardIndicator } from './SessionList/WizardIndicator';
import { WindowBadge } from './SessionList/WindowBadge';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionHasActiveOutage } from '../stores/retryStore';
import { COLORBLIND_STATUS_COLORS } from '../constants/colorblindPalettes';
import { abbreviateGroupName } from '../../shared/formatters';
import type { Session, Group, Theme } from '../types';

// ============================================================================
// SessionItem - Unified session item component for all list contexts
// ============================================================================

/**
 * True when a Claude Code agent has not bound to any provider session yet.
 *
 * `Session.agentSessionId` was deprecated by commit 505ce17c6 — Claude Code
 * stopped writing it to avoid storing throwaway fork IDs that break `--resume`.
 * Per-tab `aiTabs[].agentSessionId` is now the source of truth, so check both:
 * the agent is only "unbound" when no tab has an ID either.
 */
export function hasNoClaudeProviderSession(session: Session): boolean {
	if (session.toolType !== 'claude-code') return false;
	if (session.agentSessionId) return false;
	return !session.aiTabs?.some((tab) => tab.agentSessionId);
}

/**
 * Maps session state (plus batch / disconnected overrides) to a status color,
 * an animation flag, and a human-readable label used for the status dot tooltip.
 *
 * Special cases:
 * - `isInBatch`: always warning + pulse (Auto Run takes precedence over agent state)
 * - Claude Code with no tab bound to a provider session: hollow dot signal
 */
export function getEnhancedStatusColor(
	session: Session,
	theme: Theme,
	isInBatch: boolean,
	colorBlindMode: boolean = false,
	hasActiveOutage: boolean = false
): { color: string; animate: boolean; label: string } {
	const success = colorBlindMode ? COLORBLIND_STATUS_COLORS.success : theme.colors.success;
	const warning = colorBlindMode ? COLORBLIND_STATUS_COLORS.warning : theme.colors.warning;
	const error = colorBlindMode ? COLORBLIND_STATUS_COLORS.error : theme.colors.error;
	const connecting = colorBlindMode ? COLORBLIND_STATUS_COLORS.connecting : '#ff8800';

	// Agent Resilience: an active outage (auto-retry backing off) is a "stuck,
	// needs attention" state. Pulsing orange, ranked above batch/agent state so a
	// stalled agent is unmistakable in the Left Bar.
	if (hasActiveOutage) {
		return { color: connecting, animate: true, label: 'Auto-retrying (stuck)' };
	}

	if (isInBatch) {
		return { color: warning, animate: true, label: 'Auto Run active' };
	}

	if (hasNoClaudeProviderSession(session)) {
		return { color: theme.colors.textDim, animate: false, label: 'No active Claude session' };
	}

	switch (session.state) {
		case 'idle':
			return { color: success, animate: false, label: 'Ready' };
		case 'busy':
			return { color: warning, animate: true, label: 'Thinking' };
		case 'error':
			return { color: error, animate: false, label: 'Error' };
		case 'connecting':
			return { color: connecting, animate: true, label: 'Connecting' };
		case 'waiting_input':
			return { color: theme.colors.accent, animate: true, label: 'Waiting for input' };
		default:
			return { color: theme.colors.textDim, animate: false, label: 'Unknown' };
	}
}

/**
 * Variant determines the context in which the session item is rendered:
 * - 'bookmark': Session in the Bookmarks folder (shows group badge if session belongs to a group)
 * - 'group': Session inside a group folder
 * - 'flat': Session in flat list (when no groups exist)
 * - 'ungrouped': Session in the Ungrouped folder (when groups exist)
 * - 'worktree': Worktree child session nested under parent (shows branch name)
 */
export type SessionItemVariant = 'bookmark' | 'group' | 'flat' | 'ungrouped' | 'worktree';

export interface SessionItemProps {
	session: Session;
	variant: SessionItemVariant;
	theme: Theme;

	// State
	isActive: boolean;
	isKeyboardSelected: boolean;
	isDragging: boolean;
	isEditing: boolean;
	leftSidebarOpen: boolean;

	/**
	 * Stable DOM key for keyboard auto-scroll. Rendered as `data-nav-key` so the
	 * Left Bar can locate this row and scroll it into view when it becomes the
	 * keyboard selection. Format: `idx:<navIndex>`.
	 */
	navDomKey?: string;

	// Optional data
	group?: Group; // The group this session belongs to (for bookmark variant to show group badge)
	groupId?: string; // The group ID context for generating editing key
	gitFileCount?: number;
	isInBatch?: boolean;
	jumpNumber?: string | null; // Session jump shortcut number (1-9, 0)
	cueSubscriptionCount?: number; // Number of active Cue subscriptions (0 or undefined = no indicator)
	cueActiveRun?: boolean; // Whether a Cue pipeline is currently running for this agent
	wizardActive?: boolean; // Inline wizard active on at least one tab of this agent
	wizardGeneratingDocs?: boolean; // Wizard is generating Auto Run documents (drives pulse)
	worktreeChildCount?: number; // Number of worktree children (used for collapsed count badge)
	otherWindowNumber?: number; // 1-based window number when this agent is open in a DIFFERENT window (multi-window)

	/**
	 * When true, the row can neither be dragged nor accept drops. Used for the
	 * Bookmarks section, which is a filtered view: reordering/regrouping there
	 * would be meaningless (and dropping fell through to "ungroup").
	 */
	dragDisabled?: boolean;
	accountUsagePercent?: number | null; // Usage % for assigned account (passed from parent to avoid N hook instances)

	// Handlers
	onSelect: () => void;
	onDragStart: () => void;
	onDragOver?: (e: React.DragEvent) => void;
	onDrop?: () => void;
	onContextMenu: (e: React.MouseEvent) => void;
	onFinishRename: (newName: string) => void;
	onStartRename: () => void;
	onToggleBookmark: () => void;
	onToggleWorktrees?: (sessionId: string) => void;
}

/**
 * SessionItem renders a single session in the sidebar list.
 *
 * This component unifies 4 previously separate implementations:
 * 1. Bookmark items - sessions pinned to the Bookmarks folder
 * 2. Group items - sessions inside a group folder
 * 3. Flat items - sessions in a flat list (no groups)
 * 4. Ungrouped items - sessions in the Ungrouped folder
 *
 * Key differences between variants are handled via props:
 * - Bookmark variant shows group badge and always shows filled bookmark icon
 * - Group/Flat/Ungrouped variants show bookmark icon on hover (unless bookmarked)
 * - Flat variant has slightly different styling (mx-3 vs ml-4)
 */
export const SessionItem = memo(function SessionItem({
	session,
	variant,
	theme,
	isActive,
	isKeyboardSelected,
	isDragging,
	isEditing,
	leftSidebarOpen,
	navDomKey,
	group,
	groupId,
	gitFileCount,
	isInBatch = false,
	jumpNumber,
	cueSubscriptionCount,
	cueActiveRun,
	wizardActive = false,
	wizardGeneratingDocs = false,
	worktreeChildCount,
	otherWindowNumber,
	dragDisabled = false,
	accountUsagePercent,
	onSelect,
	onDragStart,
	onDragOver,
	onDrop,
	onContextMenu,
	onFinishRename,
	onStartRename,
	onToggleBookmark,
	onToggleWorktrees,
}: SessionItemProps) {
	const showWorktreePill = useSettingsStore((s) => s.showWorktreePill);
	const showWorktreeBranchName = useSettingsStore((s) => s.showWorktreeBranchName);
	const showLeftPanelLocationPills = useSettingsStore((s) => s.showLeftPanelLocationPills);
	const showLeftPanelGitIndicator = useSettingsStore((s) => s.showLeftPanelGitIndicator);
	const showLeftPanelCueIndicator = useSettingsStore((s) => s.showLeftPanelCueIndicator);
	const showLeftPanelStartupCommandIndicator = useSettingsStore(
		(s) => s.showLeftPanelStartupCommandIndicator
	);
	const showGroupLabelInBookmarks = useSettingsStore((s) => s.showGroupLabelInBookmarks);
	const showFullGroupLabelInBookmarks = useSettingsStore((s) => s.showFullGroupLabelInBookmarks);
	const maestroCueEnabled = useSettingsStore((s) => s.encoreFeatures.maestroCue);
	const colorBlindMode = useSettingsStore((s) => s.colorBlindMode);
	const cueIndicatorVisible = maestroCueEnabled && showLeftPanelCueIndicator;
	const startupCommandTabCount =
		session.terminalTabs?.reduce(
			(acc, tab) => (tab.startupCommand && tab.startupCommand.trim().length > 0 ? acc + 1 : acc),
			0
		) ?? 0;
	const startupCommandIndicatorActive =
		showLeftPanelStartupCommandIndicator && startupCommandTabCount > 0;

	// Parent agents (sessions with worktreeConfig) get an inline chevron toggle.
	// Default to expanded when worktreesExpanded is undefined to match useSortedSessions.
	const isWorktreeParent = variant !== 'worktree' && Boolean(session.worktreeConfig);
	const worktreesExpanded = session.worktreesExpanded ?? true;
	const showCollapsedCountBadge =
		isWorktreeParent && !worktreesExpanded && (worktreeChildCount ?? 0) > 0;
	// Location pills: SSH indicator always shown (even in bookmarks) since it
	// signals where prompts will run. GIT/LOCAL are suppressed in the bookmark
	// variant to keep the row compact.
	const showLocationPills =
		showLeftPanelLocationPills && variant !== 'worktree' && session.toolType !== 'terminal';
	const showGitLocalBadge = showLocationPills && variant !== 'bookmark';

	// Status indicator: enhanced color/animation/label, plus hollow signal for
	// Claude Code agents that haven't bound to a provider session yet. A stuck
	// Agent Resilience outage overrides to pulsing orange (needs attention).
	const hasActiveOutage = useSessionHasActiveOutage(session.id);
	const statusInfo = getEnhancedStatusColor(
		session,
		theme,
		isInBatch,
		colorBlindMode,
		hasActiveOutage
	);
	const isDisconnected = !isInBatch && hasNoClaudeProviderSession(session);

	// Determine container styling based on variant
	const getContainerClassName = () => {
		// Worktree items get a dashed left border to visually distinguish from regular agents
		const borderClass = variant === 'worktree' ? 'border-l-2 border-dashed' : 'border-l-2';
		const base = `cursor-move flex items-center justify-between group ${borderClass} transition-all hover:bg-opacity-50 ${isDragging ? 'opacity-50' : ''}`;

		if (variant === 'flat') {
			return `mx-3 px-3 py-2 rounded mb-1 ${base}`;
		}
		if (variant === 'worktree') {
			// Worktree children have extra left padding and smaller text
			return `pl-8 pr-4 py-1.5 ${base}`;
		}
		// mr-px keeps the active/selected highlight from bleeding into the
		// sidebar's right divider (border-r / focused inset accent shadow).
		return `px-4 py-2 mr-px ${base}`;
	};

	return (
		<LongPressable
			key={`${variant}-${groupId || ''}-${session.id}`}
			data-nav-key={navDomKey}
			draggable={!dragDisabled}
			onDragStart={dragDisabled ? undefined : onDragStart}
			onDragOver={dragDisabled ? undefined : onDragOver}
			onDrop={dragDisabled ? undefined : onDrop}
			onClick={onSelect}
			onContextMenu={onContextMenu}
			// Touch: a long-press opens the same context menu right-click opens.
			onLongPress={(rect) => onContextMenu(longPressMouseEvent(rect))}
			className={getContainerClassName()}
			style={{
				borderColor: isActive || isKeyboardSelected ? theme.colors.accent : 'transparent',
				backgroundColor: isActive
					? variant === 'worktree'
						? theme.colors.accent + '15'
						: theme.colors.bgActivity
					: isKeyboardSelected
						? theme.colors.bgActivity + '40'
						: 'transparent',
			}}
		>
			{/* Left side: Session name and metadata */}
			<div className="min-w-0 flex-1">
				{isEditing ? (
					<input
						autoFocus
						className="bg-transparent text-sm font-medium outline-none w-full border-b"
						style={{ borderColor: theme.colors.accent }}
						defaultValue={session.name}
						onClick={(e) => e.stopPropagation()}
						onBlur={(e) => onFinishRename(e.target.value)}
						onKeyDown={(e) => {
							e.stopPropagation();
							// Commit through onBlur only — calling onFinishRename here AND
							// letting blur fire would double-fire the IPC. Forcing blur on
							// Enter funnels both code paths through the single handler.
							if (e.key === 'Enter') {
								e.preventDefault();
								e.currentTarget.blur();
							}
						}}
					/>
				) : (
					<div className="flex items-center gap-1.5" onDoubleClick={onStartRename}>
						{/* Worktree expand/collapse chevron for parent agents (rotates 90deg when expanded) */}
						{isWorktreeParent && onToggleWorktrees && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									onToggleWorktrees(session.id);
								}}
								className="w-4 h-4 rounded hover:bg-white/10 shrink-0 flex items-center justify-center transition-colors"
								title={worktreesExpanded ? 'Collapse worktrees' : 'Expand worktrees'}
								aria-label={worktreesExpanded ? 'Collapse worktrees' : 'Expand worktrees'}
								aria-expanded={worktreesExpanded}
							>
								<ChevronRight
									className={`w-3 h-3 transition-transform duration-200 ${worktreesExpanded ? 'rotate-90' : ''}`}
									style={{ color: theme.colors.textDim }}
								/>
							</button>
						)}
						{/* Collapsed worktree child count badge */}
						{showCollapsedCountBadge && (
							<span
								className="text-[9px] px-1.5 py-0.5 rounded-full shrink-0 font-medium"
								style={{
									backgroundColor: theme.colors.accent + '33',
									color: theme.colors.accent,
								}}
								title={`${worktreeChildCount} hidden worktree${worktreeChildCount === 1 ? '' : 's'}`}
							>
								{worktreeChildCount}
							</span>
						)}
						{/* Branch icon for worktree children */}
						{variant === 'worktree' && (
							<GitBranch className="w-3 h-3 shrink-0" style={{ color: theme.colors.accent }} />
						)}
						{/* Parent agent indicator: shown for sessions that have spawned worktree children */}
						{variant !== 'worktree' && session.worktreeConfig && (
							<span
								className="shrink-0 inline-flex"
								title="Parent agent with worktrees"
								aria-label="Parent agent with worktrees"
							>
								<FolderTree size={10} style={{ color: theme.colors.textDim }} />
							</span>
						)}
						{/* Pinned-manager marker: the single Pianola agent is pinned at the top
						    of the Left Bar; the pin distinguishes it without a section header. */}
						{session.isPianola && (
							<span
								className="shrink-0 inline-flex"
								title="Pinned manager agent"
								aria-label="Pinned manager agent"
							>
								<Pin size={11} style={{ color: theme.colors.accent }} />
							</span>
						)}
						<span
							className={`font-medium truncate ${variant === 'worktree' ? 'text-xs' : 'text-sm'}`}
							style={{ color: theme.colors.textMain }}
						>
							{session.name}
						</span>
						{/* Maestro Cue indicator: subscriptions registered (and pulsing when running).
						    Hidden when the Cue Encore Feature is off, or when the user has hidden it. */}
						{cueIndicatorVisible && (
							<CueIndicator
								subscriptionCount={cueSubscriptionCount ?? 0}
								activeRun={!!cueActiveRun}
							/>
						)}
						{/* Persistent-terminal indicator: agent has at least one terminal tab with
						    a saved startup command. Hidden when the user disables the setting. */}
						<StartupCommandIndicator
							active={startupCommandIndicatorActive}
							count={startupCommandTabCount}
						/>
						{/* Inline wizard indicator: shown while /wizard is in dialog or doc-gen phase. */}
						<WizardIndicator active={wizardActive} generatingDocs={wizardGeneratingDocs} />
						{/* Worktree badge to visually mark worktree children */}
						{variant === 'worktree' && showWorktreePill && <WorktreePill theme={theme} />}
					</div>
				)}

				{/* Branch name for worktree children (below session name) */}
				{variant === 'worktree' &&
					showWorktreeBranchName &&
					session.worktreeBranch &&
					!isEditing && (
						<div
							className="text-[10px] mt-0.5 truncate"
							style={{ color: theme.colors.textDim }}
							title={session.worktreeBranch}
						>
							{session.worktreeBranch}
						</div>
					)}

				{/* Session metadata row (hidden for compact worktree variant) */}
				{variant !== 'worktree' && (
					<div className="flex items-center gap-2 text-[10px] mt-0.5 opacity-70">
						{/* Session Jump Number Badge (Opt+Cmd+NUMBER) */}
						{jumpNumber && (
							<div
								className="w-4 h-4 rounded flex items-center justify-center text-[10px] font-bold shrink-0"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.bgMain,
								}}
							>
								{jumpNumber}
							</div>
						)}
						<Activity className="w-3 h-3" /> {session.toolType}
						{session.sessionSshRemoteConfig?.enabled ? ' (SSH)' : ''}
						{/* Account assignment badge */}
						{session.accountId && session.accountName && (
							<span
								className="text-[9px] px-1 py-0.5 rounded font-bold"
								style={{
									backgroundColor: `${theme.colors.accent}25`,
									color: theme.colors.accentText || theme.colors.accent,
								}}
								title={`Virtuoso: ${session.accountName}${accountUsagePercent != null ? ` (${Math.round(accountUsagePercent)}%)` : ''}`}
							>
								{session.accountName.split('@')[0]?.slice(0, 10)?.toUpperCase() || 'ACC'}
							</span>
						)}
					</div>
				)}
			</div>

			{/* Right side: Indicators and actions */}
			<div className="flex items-center gap-2 ml-2">
				{/* Multi-window badge: this agent is open in a different window. Clicking
				    the row focuses that window rather than stealing the agent. */}
				<WindowBadge windowNumber={otherWindowNumber} />
				{/* Group badge (only in bookmark variant when session belongs to a group).
				    Hidden entirely when showGroupLabelInBookmarks is off. Abbreviated by
				    default; the showFullGroupLabelInBookmarks setting swaps in the full group
				    name, truncated with the complete value available on hover. */}
				{variant === 'bookmark' && group && showGroupLabelInBookmarks && (
					<span
						className={`text-[9px] px-1 py-0.5 rounded${
							showFullGroupLabelInBookmarks ? ' max-w-[140px] truncate' : ''
						}`}
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
						title={group.name}
					>
						{showFullGroupLabelInBookmarks ? group.name : abbreviateGroupName(group.name)}
					</span>
				)}
				{/* Git Dirty Indicator (only in wide mode) - placed before GIT/LOCAL for vertical alignment */}
				{showLeftPanelGitIndicator &&
					leftSidebarOpen &&
					session.isGitRepo &&
					gitFileCount !== undefined &&
					gitFileCount > 0 && (
						<div
							className="flex items-center gap-0.5 text-[10px]"
							style={{ color: theme.colors.warning }}
						>
							<GitBranch className="w-2.5 h-2.5" />
							<span>{gitFileCount}</span>
						</div>
					)}

				{/* Location Indicator Pills */}
				{showLocationPills &&
					(session.isGitRepo ? (
						/* Git repo: Show server icon pill (if remote) + GIT pill */
						<>
							{session.sessionSshRemoteConfig?.enabled && (
								<div
									className="px-1.5 py-0.5 rounded text-[9px] font-bold flex items-center"
									style={{
										backgroundColor: theme.colors.warning + '30',
										color: theme.colors.warning,
									}}
									title="Running on remote host via SSH"
								>
									<Server className="w-3 h-3" />
								</div>
							)}
							{showGitLocalBadge && (
								<div
									className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
									style={{
										backgroundColor: theme.colors.accent + '30',
										color: theme.colors.accent,
									}}
									title="Git repository"
								>
									GIT
								</div>
							)}
						</>
					) : session.sessionSshRemoteConfig?.enabled ? (
						/* Plain directory on remote: always show REMOTE */
						<div
							className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
							style={{
								backgroundColor: theme.colors.warning + '30',
								color: theme.colors.warning,
							}}
							title="Running on remote host via SSH"
						>
							REMOTE
						</div>
					) : (
						/* Plain local directory: LOCAL pill suppressed in bookmark variant */
						showGitLocalBadge && (
							<div
								className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
								style={{
									backgroundColor: theme.colors.textDim + '20',
									color: theme.colors.textDim,
								}}
								title="Local directory (not a git repo)"
							>
								LOCAL
							</div>
						)
					))}

				{/* AUTO Mode Indicator */}
				{isInBatch && (
					<div
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
						style={{
							backgroundColor: theme.colors.warning + '30',
							color: theme.colors.warning,
						}}
						title="Auto Run active"
					>
						<Bot className="w-2.5 h-2.5" />
						AUTO
					</div>
				)}

				{/* Agent Error Indicator */}
				{session.agentError && (
					<div
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
						style={{ backgroundColor: theme.colors.error + '30', color: theme.colors.error }}
						title={`Error: ${session.agentError.message}`}
					>
						<AlertCircle className="w-2.5 h-2.5" />
						ERR
					</div>
				)}

				{/* Bookmark toggle - hidden for worktree children (they inherit from parent) */}
				{!session.parentSessionId &&
					(variant !== 'bookmark' ? (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onToggleBookmark();
							}}
							className="p-0.5 rounded hover:bg-white/10 transition-all"
							title={session.bookmarked ? 'Remove bookmark' : 'Add bookmark'}
						>
							<Bookmark
								className="w-3 h-3"
								style={{ color: theme.colors.accent }}
								fill={session.bookmarked ? theme.colors.accent : 'none'}
							/>
						</button>
					) : (
						<GhostIconButton
							onClick={(e) => {
								e.stopPropagation();
								onToggleBookmark();
							}}
							padding="p-0.5"
							title="Remove bookmark"
						>
							<Bookmark
								className="w-3 h-3"
								style={{ color: theme.colors.accent }}
								fill={theme.colors.accent}
							/>
						</GhostIconButton>
					))}

				{/* AI Status Indicator with Unread Badge */}
				<div className="relative w-2 h-2 ml-auto">
					{/* Pulse ring: only renders for animated states, sits behind the dot */}
					{statusInfo.animate && (
						<span
							className="absolute inset-0 rounded-full animate-ping"
							style={{ backgroundColor: statusInfo.color, opacity: 0.3 }}
							aria-hidden="true"
						/>
					)}
					{/* Core status dot: filled by default, hollow when Claude has no provider session.
					    Busy CLI activity overrides the generic "Thinking" tooltip with the playbook name. */}
					<div
						className="relative w-2 h-2 rounded-full"
						style={
							isDisconnected
								? {
										border: `1.5px solid ${theme.colors.textDim}`,
										backgroundColor: 'transparent',
									}
								: {
										backgroundColor: statusInfo.color,
										boxShadow: statusInfo.animate ? `0 0 6px ${statusInfo.color}60` : undefined,
									}
						}
						title={
							session.state === 'busy' && session.cliActivity && !isInBatch
								? `CLI: Running playbook "${session.cliActivity.playbookName}"`
								: statusInfo.label
						}
					/>
					{/* Unread Notification Badge */}
					{!isActive && session.aiTabs?.some((tab) => tab.hasUnread) && (
						<div
							className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full"
							style={{ backgroundColor: theme.colors.error }}
							title="Unread messages"
						/>
					)}
				</div>
			</div>
		</LongPressable>
	);
});

export default SessionItem;
