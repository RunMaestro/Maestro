/**
 * Maestro Web Remote Control
 *
 * Lightweight interface for controlling sessions from mobile/tablet devices.
 * Focused on quick command input and session monitoring.
 */

import React, { useEffect, useCallback, useState, useMemo, useRef } from 'react';
import { useThemeColors, useTheme } from '../components/ThemeProvider';
import { ResponsiveModal, Button } from '../components';
import {
	useWebSocket,
	type CustomCommand,
	type AutoRunState,
	type AITabData,
	type GroupData,
	type GroupChatMessage,
	type GroupChatState,
} from '../hooks/useWebSocket';
// Command history is no longer used in the mobile UI
import { useNotifications } from '../hooks/useNotifications';
import { useUnreadBadge } from '../hooks/useUnreadBadge';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { useMobileSessionManagement } from '../hooks/useMobileSessionManagement';
import { useOfflineStatus, useDesktopTheme } from '../main';
import { buildApiUrl } from '../utils/config';
import { triggerHaptic, HAPTIC_PATTERNS, type BreakpointTier } from './constants';
import { applyMainMinWidthGuard, getPanelMode, type MostRecentlyOpenedPanel } from './panelModes';
import { webLogger } from '../utils/logger';
import { AllSessionsView } from './AllSessionsView';
import { type RightDrawerTab } from './RightDrawer';
import { RightPanel } from './RightPanel';
import { LeftPanel } from './LeftPanel';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useGitStatus } from '../hooks/useGitStatus';
import { useResizableWebPanel } from '../hooks/useResizableWebPanel';
import { GitDiffViewer } from './GitDiffViewer';
import { CommandInputBar, type InputMode } from './CommandInputBar';
import type { ThinkingMode } from '../../shared/types';
import { DEFAULT_SLASH_COMMANDS, type SlashCommand } from './SlashCommandAutocomplete';
// CommandHistoryDrawer and RecentCommandChips removed for simpler mobile UI
import { ResponseViewer, type ResponseItem } from './ResponseViewer';
import { OfflineQueueBanner } from './OfflineQueueBanner';
import { MessageHistory } from './MessageHistory';
import { WebTerminal, type WebTerminalHandle } from './WebTerminal';
import { AutoRunIndicator } from './AutoRunIndicator';
import { AutoRunPanel } from './AutoRunPanel';
import { AutoRunDocumentViewer } from './AutoRunDocumentViewer';
import { AutoRunSetupSheet } from './AutoRunSetupSheet';
import { NotificationSettingsSheet } from './NotificationSettingsSheet';
import { SettingsPanel } from './SettingsPanel';
import { AgentCreationSheet } from './AgentCreationSheet';
import { GroupChatPanel } from './GroupChatPanel';
import { GroupChatSetupSheet } from './GroupChatSetupSheet';
import { ContextManagementSheet } from './ContextManagementSheet';
import { CuePanel } from './CuePanel';
import { UsageDashboardPanel } from './UsageDashboardPanel';
import { AchievementsPanel } from './AchievementsPanel';
import { useGroupChat } from '../hooks/useGroupChat';
import { useCue } from '../hooks/useCue';
import { useAutoRun, type LaunchConfig } from '../hooks/useAutoRun';
import { useSettings, type WebSettings } from '../hooks/useSettings';
import { useAgentManagement } from '../hooks/useAgentManagement';
import { TabBar } from './TabBar';
import { TabSearchModal } from './TabSearchModal';
import type { Session, LastResponsePreview } from '../hooks/useSessions';
// View state utilities are now accessed through useMobileViewState hook
// Keeping import for TypeScript types only if needed
import { QuickActionsMenu, type CommandPaletteAction } from './QuickActionsMenu';
import { useMobileKeyboardHandler } from '../hooks/useMobileKeyboardHandler';
import { resolveWebShortcuts } from '../constants/webShortcuts';
import { useMobileViewState } from '../hooks/useMobileViewState';
import { useMobileAutoReconnect } from '../hooks/useMobileAutoReconnect';

interface SessionCommandDrafts {
	aiByTab: Record<string, string>;
	terminal: string;
}

type CommandDraftStore = Record<string, SessionCommandDrafts>;
const SESSION_LEVEL_AI_DRAFT_KEY = '__session__';

function getEmptyDrafts(): SessionCommandDrafts {
	return {
		aiByTab: {},
		terminal: '',
	};
}

/**
 * Get the active tab from a session
 */
function getActiveTabFromSession(session: Session | null | undefined): AITabData | null {
	if (!session?.aiTabs || !session.activeTabId) return null;
	return session.aiTabs.find((tab) => tab.id === session.activeTabId) || null;
}

/**
 * Shared icon-button className for the header.
 *
 * Tailwind tokens resolve the live `--maestro-*` CSS custom properties, so the
 * active/inactive states continue to react to theme hot-swaps. The active
 * background uses the same `color-mix(..., 12%, transparent)` pattern as
 * `Badge.tsx`'s subtle style to emulate the legacy `${hex}20` alpha (~12.5%)
 * — Tailwind's opacity modifiers don't compose with `var()` tokens.
 *
 * The global 44px touch-target floor (see `src/web/index.css`) still applies
 * because `<button>` matches the universal selector there; the `w-8 h-8`
 * utilities set the 32px square icon box while min-height keeps the hit zone
 * at 44px. When `compact` is true (short viewport, Phase 5 Task 5.4), the
 * `min-h-10` utility overrides the global 44px floor down to a 40px hit zone
 * so the thinned header stays under 48px total — still well above the 32px
 * icon box, so the tap target shrinks via reduced surrounding padding rather
 * than by scaling the icon.
 *
 * Phase 6 Task 6.4: When `withLabel` is true (desktop tier), the button
 * relaxes from a fixed 32px square to `h-8 px-2 gap-1.5` so a short inline
 * label can sit beside the SVG. `aria-label` and `title` still fire for
 * screen readers and native hover, so the label is additive, not a
 * replacement.
 */
const HEADER_ICON_BUTTON_BASE_SQUARE =
	'w-8 h-8 flex items-center justify-center rounded-md flex-shrink-0 relative p-0 cursor-pointer touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-accent';

const HEADER_ICON_BUTTON_BASE_LABELED =
	'h-8 flex items-center justify-center rounded-md flex-shrink-0 relative px-2 gap-1.5 cursor-pointer touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-accent';

// Kept for backwards compatibility with the overflow-button inline string.
const HEADER_ICON_BUTTON_BASE = HEADER_ICON_BUTTON_BASE_SQUARE;

function headerIconButtonClasses(isActive = false, compact = false, withLabel = false): string {
	const base = withLabel ? HEADER_ICON_BUTTON_BASE_LABELED : HEADER_ICON_BUTTON_BASE_SQUARE;
	const state = isActive
		? 'bg-[color-mix(in_srgb,var(--maestro-accent)_12%,transparent)] border border-accent text-accent'
		: 'bg-transparent border border-border text-text-dim';
	const sizing = compact ? 'min-h-10' : '';
	return `${base} ${state}${sizing ? ` ${sizing}` : ''}`;
}

/**
 * Overflow menu item component
 */
function OverflowMenuItem({
	icon,
	label,
	onClick,
}: {
	icon: React.ReactNode;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			onClick={onClick}
			className="flex items-center gap-2.5 w-full px-3.5 py-2.5 border-none bg-transparent text-text-main text-sm cursor-pointer touch-manipulation text-left rounded-md hover:bg-[color-mix(in_srgb,var(--maestro-text-dim)_8%,transparent)]"
		>
			<span className="text-text-dim flex-shrink-0 flex items-center">{icon}</span>
			<span>{label}</span>
		</button>
	);
}

/**
 * Header component for the mobile app
 * Reorganized: Left (menu) | Center (session name + status) | Right (priority icons + overflow)
 *
 * ---------------------------------------------------------------------------
 * Icon priority (Phase 1 Task 1.6)
 *
 * The right-side icon row is tier-responsive. As the viewport narrows, lower-
 * priority icons drop into the overflow dropdown. Secondary icons (rare
 * actions like Usage Dashboard) live in the overflow on `phone`/`tablet`
 * and promote inline on `desktop`, where the overflow button is hidden.
 *
 * Phase 6 maintainers: adjust `PRIMARY_HEADER_ICONS` (order = priority) and
 * `PRIMARY_SLOTS_BY_TIER` to re-tune what's visible per breakpoint.
 *
 * Slot counts by tier (right-side only; left Agents toggle + center session
 * title always render):
 *   - phone   → 2 primary icons + overflow
 *   - tablet  → 4 primary icons + overflow
 *   - desktop → all 6 primary + all 4 secondary inline, no overflow
 * ---------------------------------------------------------------------------
 */
type HeaderIconId =
	| 'rightPanel'
	| 'notifications'
	| 'search'
	| 'cue'
	| 'settings'
	| 'groupChat'
	| 'usageDashboard'
	| 'achievements'
	| 'contextManagement'
	| 'newAgent';

/** Primary icons, ordered high→low priority. Index < slot count = inline. */
const PRIMARY_HEADER_ICONS: readonly HeaderIconId[] = [
	'rightPanel',
	'notifications',
	'search',
	'cue',
	'settings',
	'groupChat',
] as const;

/** Secondary icons — always overflow on phone/tablet, inline on desktop. */
const SECONDARY_HEADER_ICONS: readonly HeaderIconId[] = [
	'usageDashboard',
	'achievements',
	'contextManagement',
	'newAgent',
] as const;

const PRIMARY_SLOTS_BY_TIER: Record<BreakpointTier, number> = {
	phone: 2,
	tablet: 4,
	desktop: PRIMARY_HEADER_ICONS.length,
};

function isHeaderIconInline(id: HeaderIconId, tier: BreakpointTier): boolean {
	if ((SECONDARY_HEADER_ICONS as readonly HeaderIconId[]).includes(id)) {
		return tier === 'desktop';
	}
	const idx = PRIMARY_HEADER_ICONS.indexOf(id);
	return idx >= 0 && idx < PRIMARY_SLOTS_BY_TIER[tier];
}

interface MobileHeaderProps {
	activeSession?: Session | null;
	onMenuTap?: () => void;
	isLeftPanelOpen?: boolean;
	onSearchTap?: () => void;
	onRightDrawerTap?: () => void;
	isRightPanelOpen?: boolean;
	onCueTap?: () => void;
	hasRunningCue?: boolean;
	onNotificationTap?: () => void;
	onSettingsTap?: () => void;
	notificationCount?: number;
	completedAgents?: Array<{
		sessionId: string;
		sessionName: string;
		timestamp: number;
		eventType: string;
	}>;
	onSelectAgent?: (sessionId: string) => void;
	onClearNotifications?: () => void;
	onOpenNotificationSettings?: () => void;
	// Overflow menu actions
	onGroupChatTap?: () => void;
	groupChatCount?: number;
	onUsageDashboardTap?: () => void;
	onAchievementsTap?: () => void;
	onContextManagementTap?: () => void;
	onNewAgentTap?: () => void;
}

function MobileHeader({
	activeSession,
	onMenuTap,
	isLeftPanelOpen = false,
	onSearchTap,
	onRightDrawerTap,
	isRightPanelOpen = false,
	onCueTap,
	hasRunningCue = false,
	onNotificationTap: _onNotificationTap,
	onSettingsTap,
	notificationCount: _notificationCount = 0,
	completedAgents = [],
	onSelectAgent,
	onClearNotifications,
	onOpenNotificationSettings,
	onGroupChatTap,
	groupChatCount = 0,
	onUsageDashboardTap,
	onAchievementsTap,
	onContextManagementTap,
	onNewAgentTap,
}: MobileHeaderProps) {
	const [showOverflow, setShowOverflow] = useState(false);
	const overflowRef = useRef<HTMLDivElement>(null);
	const [showNotifDropdown, setShowNotifDropdown] = useState(false);
	const notifDropdownRef = useRef<HTMLDivElement>(null);

	// Close notification dropdown on outside click
	useEffect(() => {
		if (!showNotifDropdown) return;
		const handleClick = (e: MouseEvent) => {
			if (notifDropdownRef.current && !notifDropdownRef.current.contains(e.target as Node)) {
				setShowNotifDropdown(false);
			}
		};
		document.addEventListener('mousedown', handleClick);
		return () => document.removeEventListener('mousedown', handleClick);
	}, [showNotifDropdown]);

	// Get active tab for per-tab data (agentSessionId, usageStats)
	const activeTab = getActiveTabFromSession(activeSession);

	// Session status and usage - prefer tab-level data
	const sessionState = activeTab?.state || activeSession?.state || 'idle';
	const isThinking = sessionState === 'busy';

	// Responsive: tier drives which icons render inline vs. in the overflow
	// menu (see PRIMARY_HEADER_ICONS / PRIMARY_SLOTS_BY_TIER at top of file).
	// `isShortViewport` (Phase 5 Task 5.4) halves vertical padding and relaxes
	// the per-button 44px min-height floor to 40px so the header stays ≤48px
	// tall in landscape phone orientations.
	const { tier, isShortViewport, isDesktop } = useBreakpoint();

	// Close overflow menu when clicking outside
	useEffect(() => {
		if (!showOverflow) return;
		const handler = (e: MouseEvent) => {
			if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
				setShowOverflow(false);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [showOverflow]);

	// Status dot color maps to a Tailwind bg token so theme hot-swaps pick up
	// the new palette without re-rendering the dot element.
	const statusDotBgClass =
		sessionState === 'busy' || sessionState === 'connecting'
			? 'bg-warning'
			: sessionState === 'error'
				? 'bg-error'
				: 'bg-success';

	const handleOverflowAction = useCallback((action: (() => void) | undefined) => {
		setShowOverflow(false);
		action?.();
	}, []);

	const headerPaddingClass = isShortViewport
		? 'pb-0.5 pt-[max(3px,env(safe-area-inset-top))] min-h-10'
		: 'pb-1.5 pt-[max(6px,env(safe-area-inset-top))] min-h-11';

	return (
		<header
			className={`flex items-center justify-between gap-1.5 px-2.5 border-b border-border bg-bg-sidebar ${headerPaddingClass}`}
		>
			{/* Left: Agents panel toggle */}
			<button
				onClick={onMenuTap}
				className={headerIconButtonClasses(isLeftPanelOpen, isShortViewport, isDesktop)}
				aria-label="Agents"
				title="Agents"
			>
				{/* Robot head agent icon */}
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<rect x="4" y="8" width="16" height="12" rx="2" />
					<circle cx="9" cy="14" r="1.5" fill="currentColor" stroke="none" />
					<circle cx="15" cy="14" r="1.5" fill="currentColor" stroke="none" />
					<line x1="12" y1="4" x2="12" y2="8" />
					<circle cx="12" cy="3" r="1" />
				</svg>
				{isDesktop && (
					<span className="text-[13px] font-medium leading-none whitespace-nowrap">Agents</span>
				)}
			</button>

			{/* Center: Session name + status dot */}
			{activeSession ? (
				<div className="flex flex-1 items-center justify-center gap-1.5 min-w-0 overflow-hidden">
					{/* Session status dot */}
					<span
						className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDotBgClass} ${
							isThinking ? '[animation:pulse_1.5s_ease-in-out_infinite]' : ''
						}`}
						title={`Session ${sessionState}`}
					/>
					{/* Session name */}
					<span className="text-sm font-semibold text-text-main overflow-hidden text-ellipsis whitespace-nowrap">
						{activeSession.name}
					</span>
				</div>
			) : (
				<div className="flex flex-1 items-center justify-center">
					<span className="text-sm font-semibold text-text-main">Maestro</span>
				</div>
			)}

			{/* Right: Priority icon buttons + overflow */}
			<div className="flex items-center gap-1 flex-shrink-0">
				{/* Search / Quick Actions (Cmd+K) — inline on tablet+ */}
				{isHeaderIconInline('search', tier) && (
					<button
						onClick={onSearchTap}
						className={headerIconButtonClasses(false, isShortViewport, isDesktop)}
						aria-label="Search"
						title="Quick Actions (Cmd+K)"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<circle cx="11" cy="11" r="8" />
							<line x1="21" y1="21" x2="16.65" y2="16.65" />
						</svg>
						{isDesktop && (
							<span className="text-[13px] font-medium leading-none whitespace-nowrap">Search</span>
						)}
					</button>
				)}

				{/* Right Panel toggle — priority #1, always inline */}
				{isHeaderIconInline('rightPanel', tier) && (
					<button
						onClick={onRightDrawerTap}
						className={headerIconButtonClasses(isRightPanelOpen, isShortViewport, isDesktop)}
						aria-label="Files & History"
						title="Files / History / Git"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
							<polyline points="13 2 13 9 20 9" />
						</svg>
						{isDesktop && (
							<span className="text-[13px] font-medium leading-none whitespace-nowrap">Files</span>
						)}
					</button>
				)}

				{/* Cue status — inline on tablet+ */}
				{isHeaderIconInline('cue', tier) && (
					<button
						onClick={onCueTap}
						className={headerIconButtonClasses(hasRunningCue, isShortViewport, isDesktop)}
						aria-label="Maestro Cue"
						title="Maestro Cue"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill={hasRunningCue ? 'currentColor' : 'none'}
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
						</svg>
						{isDesktop && (
							<span className="text-[13px] font-medium leading-none whitespace-nowrap">Cue</span>
						)}
						{hasRunningCue && (
							<span className="absolute -top-0.5 -right-0.5 w-[7px] h-[7px] rounded-full bg-success [animation:pulse_1.5s_ease-in-out_infinite]" />
						)}
					</button>
				)}

				{/* Notifications (badge with count + dropdown) — priority #2, always inline */}
				{isHeaderIconInline('notifications', tier) && (
					<div ref={notifDropdownRef} className="relative">
						<button
							onClick={() => setShowNotifDropdown((prev) => !prev)}
							className={headerIconButtonClasses(showNotifDropdown, isShortViewport, isDesktop)}
							aria-label="Notifications"
							title="Notifications"
						>
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
								<path d="M13.73 21a2 2 0 0 1-3.46 0" />
							</svg>
							{isDesktop && (
								<span className="text-[13px] font-medium leading-none whitespace-nowrap">
									Alerts
								</span>
							)}
							{completedAgents.length > 0 && (
								<span className="absolute -top-1 -right-1 text-[8px] font-bold text-white bg-error rounded-lg min-w-[14px] text-center leading-3 px-[3px] py-px">
									{completedAgents.length > 99 ? '99+' : completedAgents.length}
								</span>
							)}
						</button>
						{showNotifDropdown && (
							<div className="absolute top-full right-0 mt-2 w-[280px] max-w-[calc(100vw-16px)] max-h-[360px] bg-bg-sidebar border border-border rounded-[10px] shadow-[0_8px_24px_rgba(0,0,0,0.3)] z-[200] overflow-hidden flex flex-col">
								{/* Header */}
								<div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
									<span className="text-[13px] font-semibold text-text-main">Completed Agents</span>
									<div className="flex gap-1">
										{onClearNotifications && completedAgents.length > 0 && (
											<button
												onClick={() => {
													onClearNotifications();
													setShowNotifDropdown(false);
												}}
												className="border-none bg-transparent text-text-dim text-[11px] cursor-pointer px-1.5 py-0.5 rounded"
											>
												Clear
											</button>
										)}
										{onOpenNotificationSettings && (
											<button
												onClick={() => {
													onOpenNotificationSettings();
													setShowNotifDropdown(false);
												}}
												className="border-none bg-transparent text-text-dim cursor-pointer px-1 py-0.5 rounded flex items-center"
												title="Notification Settings"
											>
												<svg
													width="12"
													height="12"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													strokeWidth="2"
													strokeLinecap="round"
													strokeLinejoin="round"
												>
													<circle cx="12" cy="12" r="3" />
													<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
												</svg>
											</button>
										)}
									</div>
								</div>
								{/* Agent list */}
								<div className="overflow-y-auto flex-1">
									{completedAgents.length === 0 ? (
										<div className="px-3 py-6 text-center text-text-dim text-[13px]">
											No completed agents yet
										</div>
									) : (
										completedAgents.map((agent, i) => {
											const timeAgo = Math.round((Date.now() - agent.timestamp) / 60000);
											const timeLabel =
												timeAgo < 1
													? 'just now'
													: timeAgo < 60
														? `${timeAgo}m ago`
														: `${Math.round(timeAgo / 60)}h ago`;
											return (
												<button
													key={`${agent.sessionId}-${agent.timestamp}`}
													onClick={() => {
														onSelectAgent?.(agent.sessionId);
														setShowNotifDropdown(false);
													}}
													className={`flex items-center gap-2.5 w-full px-3 py-2.5 border-none bg-transparent text-text-main text-[13px] cursor-pointer text-left ${
														i > 0
															? 'border-t border-t-[color-mix(in_srgb,var(--maestro-border)_12%,transparent)]'
															: ''
													}`}
												>
													<span
														className={`w-2 h-2 rounded-full flex-shrink-0 ${
															agent.eventType === 'agent_error' ? 'bg-error' : 'bg-success'
														}`}
													/>
													<span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
														{agent.sessionName}
													</span>
													<span className="text-[11px] text-text-dim flex-shrink-0">
														{timeLabel}
													</span>
												</button>
											);
										})
									)}
								</div>
							</div>
						)}
					</div>
				)}

				{/* Settings — inline on desktop */}
				{isHeaderIconInline('settings', tier) && (
					<button
						onClick={onSettingsTap}
						className={headerIconButtonClasses(false, isShortViewport, isDesktop)}
						aria-label="Settings"
						title="Settings"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<circle cx="12" cy="12" r="3" />
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
						</svg>
						{isDesktop && (
							<span className="text-[13px] font-medium leading-none whitespace-nowrap">
								Settings
							</span>
						)}
					</button>
				)}

				{/* Group Chat — inline on desktop */}
				{isHeaderIconInline('groupChat', tier) && (
					<button
						onClick={onGroupChatTap}
						className={headerIconButtonClasses(groupChatCount > 0, isShortViewport, isDesktop)}
						aria-label="Group Chat"
						title="Group Chat"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
						</svg>
						{isDesktop && (
							<span className="text-[13px] font-medium leading-none whitespace-nowrap">Chat</span>
						)}
						{groupChatCount > 0 && (
							<span className="absolute -top-1 -right-1 text-[8px] font-bold text-white bg-accent rounded-lg min-w-[14px] text-center leading-3 px-[3px] py-px">
								{groupChatCount}
							</span>
						)}
					</button>
				)}

				{/* Usage Dashboard — secondary, inline on desktop */}
				{isHeaderIconInline('usageDashboard', tier) && (
					<button
						onClick={onUsageDashboardTap}
						className={headerIconButtonClasses(false, isShortViewport, isDesktop)}
						aria-label="Usage Dashboard"
						title="Usage Dashboard"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
							<path d="M22 12A10 10 0 0 0 12 2v10z" />
						</svg>
						{isDesktop && (
							<span className="text-[13px] font-medium leading-none whitespace-nowrap">Usage</span>
						)}
					</button>
				)}

				{/* Achievements — secondary, inline on desktop */}
				{isHeaderIconInline('achievements', tier) && (
					<button
						onClick={onAchievementsTap}
						className={headerIconButtonClasses(false, isShortViewport, isDesktop)}
						aria-label="Achievements"
						title="Achievements"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<circle cx="12" cy="8" r="7" />
							<polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88" />
						</svg>
						{isDesktop && (
							<span className="text-[13px] font-medium leading-none whitespace-nowrap">Awards</span>
						)}
					</button>
				)}

				{/* Context Management — secondary, inline on desktop (requires active session) */}
				{isHeaderIconInline('contextManagement', tier) && activeSession && (
					<button
						onClick={onContextManagementTap}
						className={headerIconButtonClasses(false, isShortViewport, isDesktop)}
						aria-label="Context Management"
						title="Context Management"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<circle cx="12" cy="12" r="10" />
							<path d="M8 12h8" />
							<path d="M12 8v8" />
						</svg>
						{isDesktop && (
							<span className="text-[13px] font-medium leading-none whitespace-nowrap">
								Context
							</span>
						)}
					</button>
				)}

				{/* New Agent — secondary, inline on desktop */}
				{isHeaderIconInline('newAgent', tier) && (
					<button
						onClick={onNewAgentTap}
						className={headerIconButtonClasses(false, isShortViewport, isDesktop)}
						aria-label="New Agent"
						title="New Agent"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="12" y1="5" x2="12" y2="19" />
							<line x1="5" y1="12" x2="19" y2="12" />
						</svg>
						{isDesktop && (
							<span className="text-[13px] font-medium leading-none whitespace-nowrap">
								New Agent
							</span>
						)}
					</button>
				)}

				{/* Overflow menu (⋯) — hidden on desktop (all icons inline) */}
				{tier !== 'desktop' && (
					<div ref={overflowRef} className="relative">
						<button
							onClick={() => setShowOverflow((prev) => !prev)}
							className={`${HEADER_ICON_BUTTON_BASE} border-none text-text-dim ${
								showOverflow
									? 'bg-[color-mix(in_srgb,var(--maestro-text-dim)_8%,transparent)]'
									: 'bg-transparent'
							}${isShortViewport ? ' min-h-10' : ''}`}
							aria-label="More actions"
							title="More actions"
						>
							{/* Three dots icon */}
							<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
								<circle cx="12" cy="5" r="2" />
								<circle cx="12" cy="12" r="2" />
								<circle cx="12" cy="19" r="2" />
							</svg>
						</button>

						{/* Overflow dropdown */}
						{showOverflow && (
							<div className="absolute top-full right-0 mt-1 min-w-[200px] bg-bg-sidebar border border-border rounded-[10px] shadow-[0_8px_24px_rgba(0,0,0,0.25)] z-[300] p-1 overflow-hidden">
								{/* Search — overflow on phone (priority #3) */}
								{!isHeaderIconInline('search', tier) && (
									<OverflowMenuItem
										icon={
											<svg
												width="16"
												height="16"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<circle cx="11" cy="11" r="8" />
												<line x1="21" y1="21" x2="16.65" y2="16.65" />
											</svg>
										}
										label="Quick Actions (Cmd+K)"
										onClick={() => handleOverflowAction(onSearchTap)}
									/>
								)}
								{/* Cue — overflow on phone (priority #4) */}
								{!isHeaderIconInline('cue', tier) && (
									<OverflowMenuItem
										icon={
											<svg
												width="16"
												height="16"
												viewBox="0 0 24 24"
												fill={hasRunningCue ? 'currentColor' : 'none'}
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
											</svg>
										}
										label={`Maestro Cue${hasRunningCue ? ' (running)' : ''}`}
										onClick={() => handleOverflowAction(onCueTap)}
									/>
								)}
								{/* Settings — overflow on phone/tablet */}
								{!isHeaderIconInline('settings', tier) && (
									<OverflowMenuItem
										icon={
											<svg
												width="16"
												height="16"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<circle cx="12" cy="12" r="3" />
												<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
											</svg>
										}
										label="Settings"
										onClick={() => handleOverflowAction(onSettingsTap)}
									/>
								)}
								{/* Group Chat — overflow on phone/tablet */}
								{!isHeaderIconInline('groupChat', tier) && (
									<OverflowMenuItem
										icon={
											<svg
												width="16"
												height="16"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
											</svg>
										}
										label={`Group Chat${groupChatCount > 0 ? ` (${groupChatCount})` : ''}`}
										onClick={() => handleOverflowAction(onGroupChatTap)}
									/>
								)}
								{/* Usage Dashboard — secondary, overflow on phone/tablet */}
								{!isHeaderIconInline('usageDashboard', tier) && (
									<OverflowMenuItem
										icon={
											<svg
												width="16"
												height="16"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
												<path d="M22 12A10 10 0 0 0 12 2v10z" />
											</svg>
										}
										label="Usage Dashboard"
										onClick={() => handleOverflowAction(onUsageDashboardTap)}
									/>
								)}
								{/* Achievements — secondary, overflow on phone/tablet */}
								{!isHeaderIconInline('achievements', tier) && (
									<OverflowMenuItem
										icon={
											<svg
												width="16"
												height="16"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<circle cx="12" cy="8" r="7" />
												<polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88" />
											</svg>
										}
										label="Achievements"
										onClick={() => handleOverflowAction(onAchievementsTap)}
									/>
								)}
								{/* Context Management — secondary, overflow on phone/tablet (requires active session) */}
								{!isHeaderIconInline('contextManagement', tier) && activeSession && (
									<OverflowMenuItem
										icon={
											<svg
												width="16"
												height="16"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<circle cx="12" cy="12" r="10" />
												<path d="M8 12h8" />
												<path d="M12 8v8" />
											</svg>
										}
										label="Context Management"
										onClick={() => handleOverflowAction(onContextManagementTap)}
									/>
								)}
								{/* New Agent — secondary, overflow on phone/tablet */}
								{!isHeaderIconInline('newAgent', tier) && (
									<OverflowMenuItem
										icon={
											<svg
												width="16"
												height="16"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<line x1="12" y1="5" x2="12" y2="19" />
												<line x1="5" y1="12" x2="19" y2="12" />
											</svg>
										}
										label="New Agent"
										onClick={() => handleOverflowAction(onNewAgentTap)}
									/>
								)}
							</div>
						)}
					</div>
				)}
			</div>
		</header>
	);
}

/**
 * Modal listing available group chats with a "New" button.
 *
 * Uses `ResponsiveModal` so it renders as a bottom sheet on phones and a
 * centered dialog at tablet+. The "+ New" primary action lives in the footer —
 * ResponsiveModal keeps the footer pinned to the bottom and thumb-reachable on
 * mobile.
 */
interface GroupChatListSheetProps {
	isOpen: boolean;
	chats: GroupChatState[];
	onSelectChat: (chatId: string) => void;
	onNewChat: () => void;
	onClose: () => void;
}

function GroupChatListSheet({
	isOpen,
	chats,
	onSelectChat,
	onNewChat,
	onClose,
}: GroupChatListSheetProps) {
	const colors = useThemeColors();

	const activeChats = chats.filter((c) => c.isActive);
	const endedChats = chats.filter((c) => !c.isActive);

	return (
		<ResponsiveModal
			isOpen={isOpen}
			onClose={onClose}
			title="Group Chats"
			zIndex={220}
			footer={
				<Button variant="primary" fullWidth onClick={onNewChat} aria-label="New group chat">
					+ New
				</Button>
			}
		>
			{chats.length === 0 && (
				<div style={{ textAlign: 'center', padding: 20, color: colors.textDim, fontSize: 13 }}>
					No group chats yet
				</div>
			)}
			{activeChats.map((chat) => (
				<button
					key={chat.id}
					onClick={() => onSelectChat(chat.id)}
					style={{
						width: '100%',
						textAlign: 'left',
						padding: '12px 14px',
						borderRadius: 10,
						border: `1px solid ${colors.accent}30`,
						backgroundColor: `${colors.accent}08`,
						color: colors.textMain,
						cursor: 'pointer',
						marginBottom: 6,
						touchAction: 'manipulation',
					}}
				>
					<div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>{chat.topic}</div>
					<div style={{ fontSize: 12, color: colors.textDim }}>
						{chat.participants.length} participants · {chat.messages.length} messages · Active
					</div>
				</button>
			))}
			{endedChats.map((chat) => (
				<button
					key={chat.id}
					onClick={() => onSelectChat(chat.id)}
					style={{
						width: '100%',
						textAlign: 'left',
						padding: '12px 14px',
						borderRadius: 10,
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.bgSidebar,
						color: colors.textMain,
						cursor: 'pointer',
						marginBottom: 6,
						opacity: 0.7,
						touchAction: 'manipulation',
					}}
				>
					<div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>{chat.topic}</div>
					<div style={{ fontSize: 12, color: colors.textDim }}>
						{chat.participants.length} participants · {chat.messages.length} messages · Ended
					</div>
				</button>
			))}
		</ResponsiveModal>
	);
}

/**
 * Main mobile app component with WebSocket connection management
 */
export default function MobileApp() {
	const colors = useThemeColors();
	const { theme } = useTheme();
	const isOffline = useOfflineStatus();
	const webTerminalRef = useRef<WebTerminalHandle>(null);
	const { bionifyReadingMode, setDesktopTheme, setDesktopBionifyReadingMode } = useDesktopTheme();

	// View state persistence and screen tracking (hook consolidates multiple effects)
	const {
		isSmallScreen,
		savedState,
		savedScrollState: _savedScrollState,
		persistViewState,
		persistHistoryState,
		persistSessionSelection,
	} = useMobileViewState();

	// Responsive: tier + viewport drive the three-column layout decisions in
	// `./panelModes`. `tier` picks the base overlay/inline layout and
	// `viewportWidth` feeds the main-column min-width guard.
	const { tier, width: viewportWidth, isShortViewport } = useBreakpoint();

	// Resizable panel hooks
	const leftPanelResize = useResizableWebPanel({
		side: 'left',
		defaultWidth: 240,
		minWidth: 200,
		maxWidth: 400,
		storageKey: 'maestro-web-left-panel-width',
	});

	const rightPanelResize = useResizableWebPanel({
		side: 'right',
		defaultWidth: 320,
		minWidth: 260,
		maxWidth: 500,
		storageKey: 'maestro-web-right-panel-width',
	});

	// UI state (not part of session management)
	const [showAllSessions, setShowAllSessions] = useState(savedState.showAllSessions);
	const [showLeftPanel, setShowLeftPanel] = useState(false);
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
	// Bell filter state is lifted so it survives LeftPanel unmount/remount on mobile.
	const [showUnreadAgentsOnly, setShowUnreadAgentsOnly] = useState(false);
	const [showRightDrawer, setShowRightDrawer] = useState(false);
	const [rightDrawerTab, setRightDrawerTab] = useState<RightDrawerTab>('files');

	// Track which panel the user most recently opened so `applyMainMinWidthGuard`
	// can demote the freshest panel to overlay when the desktop-tier inline
	// layout would squeeze `main` below `MAIN_MIN_WIDTH`.
	const [mostRecentlyOpened, setMostRecentlyOpened] = useState<MostRecentlyOpenedPanel>(null);
	const prevLeftOpenRef = useRef(showLeftPanel);
	const prevRightOpenRef = useRef(showRightDrawer);
	useEffect(() => {
		const leftJustOpened = showLeftPanel && !prevLeftOpenRef.current;
		const rightJustOpened = showRightDrawer && !prevRightOpenRef.current;
		if (leftJustOpened) {
			setMostRecentlyOpened('left');
		} else if (rightJustOpened) {
			setMostRecentlyOpened('right');
		}
		prevLeftOpenRef.current = showLeftPanel;
		prevRightOpenRef.current = showRightDrawer;
	}, [showLeftPanel, showRightDrawer]);

	// Derive each panel's rendering mode from tier + open state, then apply the
	// min-width guard so the main column never drops below `MAIN_MIN_WIDTH`.
	// Closed panels contribute zero width to the guard, so a single open panel
	// isn't demoted to overlay just because the hidden side has a non-zero
	// resize width on file.
	const panelModes = useMemo(
		() =>
			applyMainMinWidthGuard(getPanelMode(tier, showLeftPanel, showRightDrawer), {
				viewportWidth,
				leftInlineWidth: showLeftPanel ? leftPanelResize.width : 0,
				rightInlineWidth: showRightDrawer ? rightPanelResize.width : 0,
				mostRecentlyOpened,
			}),
		[
			tier,
			showLeftPanel,
			showRightDrawer,
			viewportWidth,
			leftPanelResize.width,
			rightPanelResize.width,
			mostRecentlyOpened,
		]
	);

	const [showTabSearch, setShowTabSearch] = useState(savedState.showTabSearch);
	const [thinkingMode, setThinkingMode] = useState<ThinkingMode>('off');
	const [commandDrafts, setCommandDrafts] = useState<CommandDraftStore>({});
	const [showResponseViewer, setShowResponseViewer] = useState(false);
	const [selectedResponse, setSelectedResponse] = useState<LastResponsePreview | null>(null);
	const [responseIndex, setResponseIndex] = useState(0);
	// Measured height of the sticky CommandInputBar — drives dynamic bottom padding
	// so the last chat line stays visible when the bar grows with multi-line drafts.
	const [inputBarHeight, setInputBarHeight] = useState(80);

	// Custom slash commands from desktop
	const [customCommands, setCustomCommands] = useState<CustomCommand[]>([]);

	// AutoRun state per session (batch processing on desktop)
	const [autoRunStates, setAutoRunStates] = useState<Record<string, AutoRunState | null>>({});

	// AutoRun panel state
	const [showAutoRunPanel, setShowAutoRunPanel] = useState(false);
	const [autoRunViewingDoc, setAutoRunViewingDoc] = useState<string | null>(null);
	const [showAutoRunSetup, setShowAutoRunSetup] = useState(false);

	// Notification settings sheet state
	const [showNotificationSettings, setShowNotificationSettings] = useState(false);
	const [notificationCount, setNotificationCount] = useState(0);

	// Completed agents for notification dropdown
	const [completedAgents, setCompletedAgents] = useState<
		Array<{ sessionId: string; sessionName: string; timestamp: number; eventType: string }>
	>([]);

	// Settings panel state
	const [showSettingsPanel, setShowSettingsPanel] = useState(false);

	// Agent creation sheet state
	const [showAgentCreation, setShowAgentCreation] = useState(false);

	// Group chat state
	const [showGroupChatSetup, setShowGroupChatSetup] = useState(false);
	const [showGroupChatList, setShowGroupChatList] = useState(false);
	const [activeGroupChatId, setActiveGroupChatId] = useState<string | null>(null);

	// Command palette state
	const [showCommandPalette, setShowCommandPalette] = useState(false);

	// Context management sheet state
	const [showContextManagement, setShowContextManagement] = useState(false);

	// Cue panel state
	const [showCuePanel, setShowCuePanel] = useState(false);

	// Usage Dashboard panel state
	const [showUsageDashboard, setShowUsageDashboard] = useState(false);

	// Achievements panel state
	const [showAchievements, setShowAchievements] = useState(false);

	// Git diff viewer state
	const [gitDiffFile, setGitDiffFile] = useState<string | null>(null);

	// History panel state (persisted — used by right drawer's history tab)
	const [historyFilter] = useState<'all' | 'AUTO' | 'USER'>(savedState.historyFilter);
	const [historySearchQuery] = useState(savedState.historySearchQuery);
	const [historySearchOpen] = useState(savedState.historySearchOpen);

	// Notification permission hook - requests permission on first visit
	const {
		permission: notificationPermission,
		showNotification,
		handleNotificationEvent,
		preferences: notificationPreferences,
		setPreferences: setNotificationPreferences,
	} = useNotifications({
		autoRequest: true,
		requestDelay: 3000, // Wait 3 seconds before prompting
		onGranted: () => {
			webLogger.debug('Notification permission granted', 'Mobile');
			triggerHaptic(HAPTIC_PATTERNS.success);
		},
		onDenied: () => {
			webLogger.debug('Notification permission denied', 'Mobile');
		},
	});

	// Unread badge hook - tracks unread responses and updates app badge
	const {
		addUnread: addUnreadResponse,
		markAllRead: markAllResponsesRead,
		unreadCount: _unreadCount,
	} = useUnreadBadge({
		autoClearOnVisible: true, // Clear badge when user opens the app
		onCountChange: (count) => {
			webLogger.debug(`Unread response count: ${count}`, 'Mobile');
		},
	});

	// Reference to send function for offline queue (will be set after useWebSocket)
	const sendRef = useRef<((sessionId: string, command: string) => boolean) | null>(null);

	// Ref for settings changed handler (bridges useWebSocket → useSettings ordering)
	const settingsChangedRef = useRef<((settings: WebSettings) => void) | null>(null);

	// Ref for groups changed handler (bridges useWebSocket → useAgentManagement ordering)
	const groupsChangedRef = useRef<((groups: GroupData[]) => void) | null>(null);

	// Refs for group chat handlers (bridges useWebSocket → useGroupChat ordering)
	const groupChatMessageRef = useRef<((chatId: string, message: GroupChatMessage) => void) | null>(
		null
	);
	const groupChatStateChangeRef = useRef<
		((chatId: string, state: Partial<GroupChatState>) => void) | null
	>(null);

	// Save view state when overlays change (using hook's persistence function)
	useEffect(() => {
		persistViewState({ showAllSessions, showHistoryPanel: showRightDrawer, showTabSearch });
	}, [showAllSessions, showRightDrawer, showTabSearch, persistViewState]);

	// Save history panel state when it changes (using hook's persistence function)
	useEffect(() => {
		persistHistoryState({ historyFilter, historySearchQuery, historySearchOpen });
	}, [historyFilter, historySearchQuery, historySearchOpen, persistHistoryState]);

	/**
	 * Get the first line of a response for notification display
	 * Strips markdown/code markers and truncates to reasonable length
	 */
	const getFirstLineOfResponse = useCallback((text: string): string => {
		if (!text) return 'Response completed';

		// Split by newlines and find first non-empty, non-markdown line
		const lines = text.split('\n');
		for (const line of lines) {
			const trimmed = line.trim();
			// Skip empty lines and common markdown markers
			if (!trimmed) continue;
			if (trimmed.startsWith('```')) continue;
			if (trimmed === '---') continue;

			// Found a content line - truncate if too long
			const maxLength = 100;
			if (trimmed.length > maxLength) {
				return trimmed.substring(0, maxLength) + '...';
			}
			return trimmed;
		}

		return 'Response completed';
	}, []);

	// Ref to WebSocket send function (updated after useWebSocket is initialized)
	const wsSendRef = useRef<((message: Record<string, unknown>) => boolean) | null>(null);

	// Callback when session response completes - shows notification
	const handleResponseComplete = useCallback(
		(session: Session, response?: unknown) => {
			// Only show if app is backgrounded
			if (document.visibilityState !== 'hidden') {
				return;
			}

			const lastResponse = response as LastResponsePreview | undefined;

			// Generate a unique ID for this response using session ID and timestamp
			const responseId = `${session.id}-${lastResponse?.timestamp || Date.now()}`;

			// Add to unread badge count (works even without notification permission)
			addUnreadResponse(responseId);
			webLogger.debug(`Added unread response: ${responseId}`, 'Mobile');

			// Only show notification if permission is granted
			if (notificationPermission !== 'granted') {
				return;
			}

			const title = `${session.name} - Response Ready`;
			const firstLine = lastResponse?.text
				? getFirstLineOfResponse(lastResponse.text)
				: 'AI response completed';

			const notification = showNotification(title, {
				body: firstLine,
				tag: `maestro-response-${session.id}`, // Prevent duplicate notifications for same session
				silent: false,
				requireInteraction: false, // Auto-dismiss on mobile
			} as NotificationOptions);

			if (notification) {
				webLogger.debug(`Notification shown for session: ${session.name}`, 'Mobile');

				// Handle notification click - focus the app
				notification.onclick = () => {
					window.focus();
					notification.close();
					// Set this session as active and clear badge
					setActiveSessionId(session.id);
					markAllResponsesRead();
				};
			}
		},
		[
			notificationPermission,
			showNotification,
			getFirstLineOfResponse,
			addUnreadResponse,
			markAllResponsesRead,
		]
	);

	// Session management hook - handles session state, logs, and WebSocket handlers
	const {
		sessions,
		setSessions,
		activeSessionId,
		setActiveSessionId,
		activeTabId,
		activeSession,
		sessionLogs,
		isLoadingLogs,
		handleSelectSession,
		handleSelectTab,
		handleNewTab,
		handleCloseTab,
		handleRenameTab,
		handleStarTab,
		handleReorderTab,
		addUserLogEntry,
		sessionsHandlers,
	} = useMobileSessionManagement({
		savedActiveSessionId: savedState.activeSessionId,
		savedActiveTabId: savedState.activeTabId,
		isOffline,
		sendRef: wsSendRef,
		triggerHaptic,
		hapticTapPattern: HAPTIC_PATTERNS.tap,
		onResponseComplete: handleResponseComplete,
		onThemeUpdate: setDesktopTheme,
		onBionifyReadingModeUpdate: setDesktopBionifyReadingMode,
		onCustomCommands: setCustomCommands,
		onAutoRunStateChange: (sessionId, state) => {
			webLogger.info(
				`[App] AutoRun state change: session=${sessionId}, isRunning=${state?.isRunning}, tasks=${state?.completedTasks}/${state?.totalTasks}`,
				'Mobile'
			);
			setAutoRunStates((prev) => ({
				...prev,
				[sessionId]: state,
			}));
		},
	});

	// Save session selection when it changes (using hook's persistence function)
	useEffect(() => {
		persistSessionSelection({ activeSessionId, activeTabId });
	}, [activeSessionId, activeTabId, persistSessionSelection]);

	const {
		state: connectionState,
		connect,
		send,
		sendRequest,
		error,
		reconnectAttempts,
	} = useWebSocket({
		autoReconnect: false, // Only retry manually via the retry button
		handlers: {
			...sessionsHandlers,
			onNotificationEvent: (event) => {
				handleNotificationEvent({
					eventType: event.eventType,
					sessionId: event.sessionId,
					sessionName: event.sessionName,
					message: event.message,
					severity: event.severity,
				});
				// Both the badge and the dropdown are keyed off `completedAgents`,
				// so only count events that actually land somewhere in the UI.
				// Counting non-completion events here used to make the badge
				// number drift from the dropdown contents (warning/info events
				// would silently inflate the count).
				if (event.eventType === 'agent_complete' || event.eventType === 'agent_error') {
					setNotificationCount((prev) => prev + 1);
					setCompletedAgents((prev) =>
						[
							{
								sessionId: event.sessionId,
								sessionName: event.sessionName || 'Unknown Agent',
								timestamp: Date.now(),
								eventType: event.eventType,
							},
							...prev,
						].slice(0, 50)
					);
				}
			},
			onTerminalData: (sessionId, data) => {
				const inputMode = (activeSession?.inputMode as InputMode | undefined) || 'ai';
				if (sessionId !== activeSessionId || inputMode !== 'terminal') return;
				webTerminalRef.current?.write(data);
			},
			onTerminalReady: (sessionId) => {
				const inputMode = (activeSession?.inputMode as InputMode | undefined) || 'ai';
				if (sessionId !== activeSessionId || inputMode !== 'terminal') return;
				// PTY just spawned — refit xterm and re-send current dimensions
				// so the PTY matches the actual terminal viewport.
				// Use wsSendRef (not send) to avoid circular dependency — send
				// comes from useWebSocket which is still being initialized here.
				const size = webTerminalRef.current?.fitAndGetSize();
				if (size && size.cols > 0 && size.rows > 0) {
					wsSendRef.current?.({
						type: 'terminal_resize',
						sessionId,
						cols: size.cols,
						rows: size.rows,
					});
				}
			},
			onSettingsChanged: (settings) => {
				settingsChangedRef.current?.(settings as WebSettings);
			},
			onGroupsChanged: (groups) => {
				groupsChangedRef.current?.(groups);
			},
			onGroupChatMessage: (chatId, message) => {
				groupChatMessageRef.current?.(chatId, message);
			},
			onGroupChatStateChange: (chatId, state) => {
				groupChatStateChangeRef.current?.(chatId, state);
			},
		},
	});

	// Update wsSendRef after WebSocket is initialized (for session management hook)
	useEffect(() => {
		wsSendRef.current = send;
	}, [send]);

	// Listen for notification click events to navigate to the relevant session
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.sessionId) {
				setActiveSessionId(detail.sessionId);
			}
		};
		window.addEventListener('maestro-notification-click', handler);
		return () => window.removeEventListener('maestro-notification-click', handler);
	}, [setActiveSessionId]);

	// Auto Run hook for panel operations
	const currentAutoRunState = activeSessionId ? (autoRunStates[activeSessionId] ?? null) : null;
	const {
		documents: autoRunDocuments,
		loadDocuments: loadAutoRunDocuments,
		launchAutoRun,
	} = useAutoRun(sendRequest, send, currentAutoRunState);

	// Auto Run panel handlers
	const handleOpenAutoRunPanel = useCallback(() => {
		setShowAutoRunPanel(true);
		triggerHaptic(HAPTIC_PATTERNS.tap);
	}, []);

	const handleCloseAutoRunPanel = useCallback(() => {
		setShowAutoRunPanel(false);
		setAutoRunViewingDoc(null);
		setShowAutoRunSetup(false);
	}, []);

	const handleAutoRunOpenDocument = useCallback((filename: string) => {
		setAutoRunViewingDoc(filename);
	}, []);

	const handleAutoRunBackFromDocument = useCallback(() => {
		setAutoRunViewingDoc(null);
	}, []);

	const handleAutoRunOpenSetup = useCallback(() => {
		setShowAutoRunSetup(true);
		// Load documents when setup sheet opens so it has the latest list
		if (activeSessionId) {
			loadAutoRunDocuments(activeSessionId);
		}
	}, [activeSessionId, loadAutoRunDocuments]);

	const handleAutoRunCloseSetup = useCallback(() => {
		setShowAutoRunSetup(false);
	}, []);

	// Notification settings handlers
	const handleOpenNotificationSettings = useCallback(() => {
		setShowNotificationSettings(true);
		setNotificationCount(0); // Clear badge when opening
		triggerHaptic(HAPTIC_PATTERNS.tap);
	}, []);

	const handleCloseNotificationSettings = useCallback(() => {
		setShowNotificationSettings(false);
	}, []);

	// Settings panel handlers
	const handleOpenSettingsPanel = useCallback(() => {
		setShowSettingsPanel(true);
		triggerHaptic(HAPTIC_PATTERNS.tap);
	}, []);

	const handleCloseSettingsPanel = useCallback(() => {
		setShowSettingsPanel(false);
	}, []);

	const handleAutoRunLaunch = useCallback(
		(config: LaunchConfig) => {
			if (!activeSessionId) return;
			launchAutoRun(activeSessionId, config);
			setShowAutoRunSetup(false);
			triggerHaptic(HAPTIC_PATTERNS.success);
		},
		[activeSessionId, launchAutoRun]
	);

	// Connect on mount - use empty dependency array to only connect once
	// The connect function is stable via useRef pattern in useWebSocket
	// On mobile browsers, ensure the document is fully loaded before connecting
	// to avoid race conditions with __MAESTRO_CONFIG__ injection
	useEffect(() => {
		let timeoutId: number | null = null;
		let cancelled = false;

		const scheduleAttempt = (delay: number) => {
			timeoutId = window.setTimeout(() => {
				if (cancelled) return;
				attemptConnect();
			}, delay);
		};

		const attemptConnect = () => {
			if (cancelled) return;
			// Verify config is available before connecting
			if (window.__MAESTRO_CONFIG__) {
				connect();
			} else {
				// Config not ready, retry after a short delay
				webLogger.warn('Config not ready, retrying connection in 100ms', 'Mobile');
				scheduleAttempt(100);
			}
		};

		const scheduleInitialConnect = () => {
			scheduleAttempt(50);
		};

		let onLoad: (() => void) | null = null;

		// On mobile Safari, the document may not be fully ready even when React mounts
		// Use a small delay to ensure everything is initialized
		if (document.readyState === 'complete') {
			scheduleInitialConnect();
		} else {
			// Wait for page to fully load
			onLoad = () => {
				scheduleInitialConnect();
			};
			window.addEventListener('load', onLoad);
		}

		return () => {
			cancelled = true;
			if (timeoutId) {
				window.clearTimeout(timeoutId);
			}
			if (onLoad) {
				window.removeEventListener('load', onLoad);
			}
		};
	}, []);

	// Update sendRef after WebSocket is initialized (for offline queue)
	useEffect(() => {
		sendRef.current = (sessionId: string, command: string) => {
			return send({
				type: 'send_command',
				sessionId,
				command,
			});
		};
	}, [send]);

	// Determine if we're actually connected
	const isActuallyConnected =
		!isOffline && (connectionState === 'connected' || connectionState === 'authenticated');

	// Settings hook — uses WebSocket for fetching/updating settings
	const settingsHook = useSettings(sendRequest, isActuallyConnected);

	// Agent management hook — uses WebSocket for agent/group CRUD
	const agentManagement = useAgentManagement(sendRequest, isActuallyConnected);

	// Group chat hook — uses WebSocket for group chat management
	const groupChat = useGroupChat(sendRequest, send, isActuallyConnected);

	// Git status hook — uses WebSocket for git status/diff
	const gitStatus = useGitStatus(sendRequest, isActuallyConnected, activeSessionId || undefined);

	// Cue automation hook — uses WebSocket for Cue subscription/activity management
	const cue = useCue(sendRequest, send, isActuallyConnected);

	// Keep settings changed ref in sync
	useEffect(() => {
		settingsChangedRef.current = settingsHook.handleSettingsChanged;
	}, [settingsHook.handleSettingsChanged]);

	// Keep groups changed ref in sync
	useEffect(() => {
		groupsChangedRef.current = agentManagement.handleGroupsChanged;
	}, [agentManagement.handleGroupsChanged]);

	// Keep group chat refs in sync
	useEffect(() => {
		groupChatMessageRef.current = groupChat.handleGroupChatMessage;
	}, [groupChat.handleGroupChatMessage]);
	useEffect(() => {
		groupChatStateChangeRef.current = groupChat.handleGroupChatStateChange;
	}, [groupChat.handleGroupChatStateChange]);

	// Offline queue hook - stores commands typed while offline and sends when reconnected
	const {
		queue: offlineQueue,
		queueLength: offlineQueueLength,
		status: offlineQueueStatus,
		queueCommand,
		removeCommand: removeQueuedCommand,
		clearQueue: clearOfflineQueue,
		processQueue: processOfflineQueue,
	} = useOfflineQueue({
		isOnline: !isOffline,
		isConnected: isActuallyConnected,
		sendCommand: (sessionId, command) => {
			if (sendRef.current) {
				return sendRef.current(sessionId, command);
			}
			return false;
		},
		onCommandSent: (cmd) => {
			webLogger.debug(`Queued command sent: ${cmd.command.substring(0, 50)}`, 'Mobile');
			triggerHaptic(HAPTIC_PATTERNS.success);
		},
		onCommandFailed: (cmd, error) => {
			webLogger.error(`Queued command failed: ${cmd.command.substring(0, 50)}`, 'Mobile', error);
		},
		onProcessingStart: () => {
			webLogger.debug('Processing offline queue...', 'Mobile');
		},
		onProcessingComplete: (successCount, failCount) => {
			webLogger.debug(
				`Offline queue processed. Success: ${successCount}, Failed: ${failCount}`,
				'Mobile'
			);
			if (successCount > 0) {
				triggerHaptic(HAPTIC_PATTERNS.success);
			}
		},
	});

	// Retry connection handler
	const handleRetry = useCallback(() => {
		connect();
	}, [connect]);

	const currentInputMode = ((activeSession?.inputMode as InputMode | undefined) ||
		'ai') as InputMode;
	const activeAiTabId = activeSession?.activeTabId || activeTabId || null;
	const activeAiTab = activeSession?.aiTabs?.find((tab) => tab.id === activeAiTabId);
	const activeAiDraftKey = activeAiTabId || SESSION_LEVEL_AI_DRAFT_KEY;

	const commandInput = useMemo(() => {
		if (!activeSessionId || !activeSession) return '';

		const draftsForSession = commandDrafts[activeSessionId] || getEmptyDrafts();

		if (currentInputMode === 'terminal') {
			return draftsForSession.terminal;
		}

		return draftsForSession.aiByTab[activeAiDraftKey] ?? activeAiTab?.inputValue ?? '';
	}, [
		activeAiDraftKey,
		activeAiTab,
		activeSession,
		activeSessionId,
		commandDrafts,
		currentInputMode,
	]);

	const updateCommandDraft = useCallback(
		(nextValue: string, mode: InputMode = currentInputMode) => {
			if (!activeSessionId) return;

			setCommandDrafts((prev) => {
				const currentDrafts = prev[activeSessionId] || getEmptyDrafts();

				if (mode === 'terminal') {
					if (currentDrafts.terminal === nextValue) {
						return prev;
					}

					return {
						...prev,
						[activeSessionId]: {
							...currentDrafts,
							terminal: nextValue,
						},
					};
				}

				if (currentDrafts.aiByTab[activeAiDraftKey] === nextValue) {
					return prev;
				}

				return {
					...prev,
					[activeSessionId]: {
						...currentDrafts,
						aiByTab: {
							...currentDrafts.aiByTab,
							[activeAiDraftKey]: nextValue,
						},
					},
				};
			});
		},
		[activeAiDraftKey, activeSessionId, currentInputMode]
	);

	const clearCommandDraft = useCallback(
		(mode: InputMode = currentInputMode) => {
			if (!activeSessionId) return;

			setCommandDrafts((prev) => {
				const currentDrafts = prev[activeSessionId] || getEmptyDrafts();

				if (mode === 'terminal') {
					if (currentDrafts.terminal === '') {
						return prev;
					}

					return {
						...prev,
						[activeSessionId]: {
							...currentDrafts,
							terminal: '',
						},
					};
				}

				if (!(activeAiDraftKey in currentDrafts.aiByTab)) {
					return prev;
				}

				const nextAiByTab = { ...currentDrafts.aiByTab };
				delete nextAiByTab[activeAiDraftKey];

				return {
					...prev,
					[activeSessionId]: {
						...currentDrafts,
						aiByTab: nextAiByTab,
					},
				};
			});
		},
		[activeAiDraftKey, activeSessionId, currentInputMode]
	);

	useEffect(() => {
		setCommandDrafts((prev) => {
			const validSessionIds = new Set(sessions.map((session) => session.id));
			let changed = false;
			const nextDrafts: CommandDraftStore = {};

			for (const [sessionId, drafts] of Object.entries(prev)) {
				if (!validSessionIds.has(sessionId)) {
					changed = true;
					continue;
				}

				const session = sessions.find((item) => item.id === sessionId);
				const validTabIds = new Set(session?.aiTabs?.map((tab) => tab.id) || []);
				validTabIds.add(SESSION_LEVEL_AI_DRAFT_KEY);
				const aiByTab = Object.fromEntries(
					Object.entries(drafts.aiByTab).filter(([tabId]) => validTabIds.has(tabId))
				);

				if (Object.keys(aiByTab).length !== Object.keys(drafts.aiByTab).length) {
					changed = true;
				}

				nextDrafts[sessionId] = {
					aiByTab,
					terminal: drafts.terminal,
				};
			}

			return changed ? nextDrafts : prev;
		});
	}, [sessions]);

	// Auto-reconnect with countdown timer (extracted to hook)
	const { reconnectCountdown } = useMobileAutoReconnect({
		connectionState,
		isOffline,
		connect,
	});

	// Handle opening All Sessions view
	// Handle closing All Sessions view
	const handleCloseAllSessions = useCallback(() => {
		setShowAllSessions(false);
	}, []);

	// Handle opening agent creation sheet
	const handleOpenAgentCreation = useCallback(() => {
		setShowAgentCreation(true);
		triggerHaptic(HAPTIC_PATTERNS.tap);
	}, []);

	// Handle agent created — select the new agent
	const handleAgentCreated = useCallback(
		(sessionId: string) => {
			handleSelectSession(sessionId);
			setShowAllSessions(false);
		},
		[handleSelectSession]
	);

	// Group chat handlers
	const activeGroupChats = useMemo(
		() => groupChat.chats.filter((c) => c.isActive),
		[groupChat.chats]
	);

	const handleGroupChatTap = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		if (activeGroupChats.length > 0) {
			setShowGroupChatList(true);
		} else {
			setShowGroupChatSetup(true);
		}
	}, [activeGroupChats.length]);

	const handleGroupChatStart = useCallback(
		async (topic: string, participantIds: string[]) => {
			const chatId = await groupChat.startChat(topic, participantIds);
			if (chatId) {
				setActiveGroupChatId(chatId);
				await groupChat.loadChatState(chatId);
			}
		},
		[groupChat]
	);

	const handleGroupChatOpen = useCallback(
		(chatId: string) => {
			setActiveGroupChatId(chatId);
			setShowGroupChatList(false);
			groupChat.loadChatState(chatId);
		},
		[groupChat]
	);

	const handleGroupChatBack = useCallback(() => {
		setActiveGroupChatId(null);
	}, []);

	const handleGroupChatSendMessage = useCallback(
		(message: string) => {
			if (activeGroupChatId) {
				groupChat.sendMessage(activeGroupChatId, message);
			}
		},
		[activeGroupChatId, groupChat]
	);

	const handleGroupChatStop = useCallback(async () => {
		if (activeGroupChatId) {
			await groupChat.stopChat(activeGroupChatId);
			await groupChat.loadChatState(activeGroupChatId);
		}
	}, [activeGroupChatId, groupChat]);

	// Cue panel handlers
	const hasRunningCue = useMemo(
		() => cue.activity.some((entry) => entry.status === 'running'),
		[cue.activity]
	);

	const handleCueTap = useCallback(() => {
		setShowCuePanel(true);
		triggerHaptic(HAPTIC_PATTERNS.tap);
	}, []);

	const handleCloseCuePanel = useCallback(() => {
		setShowCuePanel(false);
	}, []);

	const handleCueRefresh = useCallback(() => {
		cue.loadSubscriptions();
		cue.loadActivity();
	}, [cue]);

	// Handle opening the right drawer on a specific tab
	const handleOpenRightDrawer = useCallback((tab: RightDrawerTab = 'files') => {
		setRightDrawerTab(tab);
		setShowRightDrawer(true);
		triggerHaptic(HAPTIC_PATTERNS.tap);
	}, []);

	// Handle closing the right drawer
	const handleCloseRightDrawer = useCallback(() => {
		setShowRightDrawer(false);
	}, []);

	// Handle opening History panel — redirects to right drawer History tab
	// Handle opening Tab Search modal
	const handleOpenTabSearch = useCallback(() => {
		setShowTabSearch(true);
		triggerHaptic(HAPTIC_PATTERNS.tap);
	}, []);

	// Handle closing Tab Search modal
	const handleCloseTabSearch = useCallback(() => {
		setShowTabSearch(false);
	}, []);

	// Handle command submission
	const handleCommandSubmit = useCallback(
		(command: string) => {
			if (!activeSessionId) return;

			// Find the active session to get input mode
			const currentMode = currentInputMode;

			// Provide haptic feedback on send
			triggerHaptic(HAPTIC_PATTERNS.send);

			// Add user message to session logs immediately for display
			addUserLogEntry(command, currentMode);

			// If offline or not connected, queue the command for later
			if (isOffline || !isActuallyConnected) {
				const queued = queueCommand(activeSessionId, command, currentMode);
				if (queued) {
					webLogger.debug(`Command queued for later: ${command.substring(0, 50)}`, 'Mobile');
					// Provide different haptic feedback for queued commands
					triggerHaptic(HAPTIC_PATTERNS.tap);
				} else {
					webLogger.warn('Failed to queue command - queue may be full', 'Mobile');
				}
			} else {
				// Send the command to the active session immediately
				// Include inputMode so the server uses the web's intended mode (not stale server state)
				const sendResult = send({
					type: 'send_command',
					sessionId: activeSessionId,
					command,
					inputMode: currentMode,
				});
				webLogger.info(
					`[Web->Server] Command send result: ${sendResult}, command="${command.substring(0, 50)}" mode=${currentMode} session=${activeSessionId}`,
					'Mobile'
				);
			}

			// Clear the input
			clearCommandDraft(currentMode);
		},
		[
			activeSessionId,
			clearCommandDraft,
			currentInputMode,
			send,
			isOffline,
			isActuallyConnected,
			queueCommand,
			addUserLogEntry,
		]
	);

	// Handle command input change
	const handleCommandChange = useCallback(
		(value: string) => {
			updateCommandDraft(value);
		},
		[updateCommandDraft]
	);

	// Handle mode toggle between AI and Terminal
	const handleModeToggle = useCallback(
		(mode: InputMode) => {
			if (!activeSessionId) return;

			// Provide haptic feedback
			triggerHaptic(HAPTIC_PATTERNS.tap);

			// Send mode switch command via WebSocket
			send({ type: 'switch_mode', sessionId: activeSessionId, mode });

			// Optimistically update local session state
			setSessions((prev) =>
				prev.map((s) => (s.id === activeSessionId ? { ...s, inputMode: mode } : s))
			);

			webLogger.debug(`Mode switched to: ${mode} for session: ${activeSessionId}`, 'Mobile');
		},
		[activeSessionId, send]
	);

	// Handle interrupt request
	const handleInterrupt = useCallback(async () => {
		if (!activeSessionId) return;

		// Provide haptic feedback
		triggerHaptic(HAPTIC_PATTERNS.tap);

		try {
			// Build the API URL with security token in path
			const apiUrl = buildApiUrl(`/session/${activeSessionId}/interrupt`);
			const response = await fetch(apiUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
			});

			const result = await response.json();

			if (response.ok && result.success) {
				webLogger.debug(`Session interrupted: ${activeSessionId}`, 'Mobile');
				triggerHaptic(HAPTIC_PATTERNS.success);
			} else {
				webLogger.error(`Failed to interrupt session: ${result.error}`, 'Mobile');
			}
		} catch (error) {
			webLogger.error('Error interrupting session', 'Mobile', error);
		}
	}, [activeSessionId]);

	// Combined slash commands (default + custom from desktop)
	const allSlashCommands = useMemo((): SlashCommand[] => {
		// Convert custom commands to SlashCommand format
		const customSlashCommands: SlashCommand[] = customCommands.map((cmd) => ({
			command: cmd.command.startsWith('/') ? cmd.command : `/${cmd.command}`,
			description: cmd.description,
			aiOnly: true, // Custom commands are AI-only
		}));
		// Combine defaults with custom commands
		return [...DEFAULT_SLASH_COMMANDS, ...customSlashCommands];
	}, [customCommands]);

	// Collect all responses from sessions for navigation
	const allResponses = useMemo((): ResponseItem[] => {
		return (
			sessions
				.filter((s) => (s as any).lastResponse)
				.map((s) => ({
					response: (s as any).lastResponse as LastResponsePreview,
					sessionId: s.id,
					sessionName: s.name,
				}))
				// Sort by timestamp (most recent first)
				.sort((a, b) => b.response.timestamp - a.response.timestamp)
		);
	}, [sessions]);

	// Handle navigating between responses in the viewer
	const handleNavigateResponse = useCallback(
		(index: number) => {
			if (index >= 0 && index < allResponses.length) {
				setResponseIndex(index);
				setSelectedResponse(allResponses[index].response);
				webLogger.debug(`Navigating to response index: ${index}`, 'Mobile');
			}
		},
		[allResponses]
	);

	// Handle closing response viewer
	const handleCloseResponseViewer = useCallback(() => {
		setShowResponseViewer(false);
		// Keep selectedResponse so animation can complete
		setTimeout(() => setSelectedResponse(null), 300);
	}, []);

	// Handle thinking mode toggle (cycles: off -> on -> sticky -> off)
	const handleToggleThinking = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setThinkingMode((prev) => {
			if (prev === 'off') return 'on';
			if (prev === 'on') return 'sticky';
			return 'off';
		});
	}, []);

	// Command palette: open/close handlers (defined before keyboard handler that uses them)
	const handleOpenCommandPalette = useCallback(() => {
		setShowCommandPalette(true);
		triggerHaptic(HAPTIC_PATTERNS.tap);
	}, []);

	const handleCloseCommandPalette = useCallback(() => {
		setShowCommandPalette(false);
	}, []);

	// Configurable keyboard shortcuts — defaults merged with user overrides from
	// desktop settings. Web-supported action IDs are curated in webShortcuts.ts.
	const resolvedShortcuts = useMemo(
		() => resolveWebShortcuts(settingsHook.settings?.shortcuts),
		[settingsHook.settings?.shortcuts]
	);

	useMobileKeyboardHandler({
		shortcuts: resolvedShortcuts,
		activeSession,
		isCommandPaletteOpen: showCommandPalette,
		onCloseCommandPalette: handleCloseCommandPalette,
		actions: {
			quickAction: () => {
				if (showCommandPalette) handleCloseCommandPalette();
				else handleOpenCommandPalette();
			},
			toggleMode: () => {
				if (!activeSessionId) return;
				const currentMode = activeSession?.inputMode || 'ai';
				handleModeToggle(currentMode === 'ai' ? 'terminal' : 'ai');
			},
			prevTab: () => {
				const tabs = activeSession?.aiTabs;
				if (!tabs || tabs.length < 2) return;
				const i = tabs.findIndex((t) => t.id === activeSession?.activeTabId);
				if (i === -1) return;
				handleSelectTab(tabs[(i - 1 + tabs.length) % tabs.length].id);
			},
			nextTab: () => {
				const tabs = activeSession?.aiTabs;
				if (!tabs || tabs.length < 2) return;
				const i = tabs.findIndex((t) => t.id === activeSession?.activeTabId);
				if (i === -1) return;
				handleSelectTab(tabs[(i + 1) % tabs.length].id);
			},
			cyclePrev: () => {
				if (sessions.length < 2) return;
				const i = sessions.findIndex((s) => s.id === activeSessionId);
				if (i === -1) return;
				handleSelectSession(sessions[(i - 1 + sessions.length) % sessions.length].id);
			},
			cycleNext: () => {
				if (sessions.length < 2) return;
				const i = sessions.findIndex((s) => s.id === activeSessionId);
				if (i === -1) return;
				handleSelectSession(sessions[(i + 1) % sessions.length].id);
			},
			newInstance: () => setShowAgentCreation(true),
			settings: () => setShowSettingsPanel(true),
			goToFiles: () => handleOpenRightDrawer('files'),
			goToHistory: () => handleOpenRightDrawer('history'),
			goToAutoRun: () => handleOpenRightDrawer('autorun'),
			agentSessions: () => setShowAllSessions(true),
			usageDashboard: () => setShowUsageDashboard(true),
			openCue: () => setShowCuePanel(true),
			newGroupChat: () => setShowGroupChatSetup(true),
			killInstance: () => {
				void handleInterrupt();
			},
		},
	});

	// Swipe-from-edge gestures to open left panel / right drawer
	const edgeSwipeRef = useRef<{ startX: number; startY: number; edge: 'left' | 'right' } | null>(
		null
	);
	const handleMainTouchStart = useCallback((e: React.TouchEvent) => {
		const touch = e.touches[0];
		const viewportWidth = window.innerWidth;
		// Track touches starting within 20px of either edge
		if (touch.clientX <= 20) {
			edgeSwipeRef.current = { startX: touch.clientX, startY: touch.clientY, edge: 'left' };
		} else if (touch.clientX >= viewportWidth - 20) {
			edgeSwipeRef.current = { startX: touch.clientX, startY: touch.clientY, edge: 'right' };
		}
	}, []);
	const handleMainTouchMove = useCallback(
		(e: React.TouchEvent) => {
			if (!edgeSwipeRef.current) return;
			const touch = e.touches[0];
			const deltaX = touch.clientX - edgeSwipeRef.current.startX;
			const deltaY = Math.abs(touch.clientY - edgeSwipeRef.current.startY);
			const absDeltaX = Math.abs(deltaX);
			// Must move > 60px horizontally and be more horizontal than vertical
			if (absDeltaX > 60 && absDeltaX > deltaY) {
				const { edge } = edgeSwipeRef.current;
				edgeSwipeRef.current = null;
				if (edge === 'right' && deltaX < 0) {
					// Swipe left from right edge — open right drawer
					handleOpenRightDrawer('files');
				} else if (edge === 'left' && deltaX > 0) {
					// Swipe right from left edge — open left panel
					setShowLeftPanel(true);
				}
			}
		},
		[handleOpenRightDrawer]
	);
	const handleMainTouchEnd = useCallback(() => {
		edgeSwipeRef.current = null;
	}, []);

	// Handle viewing a git diff from the right drawer
	const handleViewGitDiff = useCallback(
		(filePath: string) => {
			if (!activeSessionId) return;
			gitStatus.loadDiff(activeSessionId, filePath);
			setGitDiffFile(filePath);
		},
		[activeSessionId, gitStatus]
	);

	const handleBackFromGitDiff = useCallback(() => {
		setGitDiffFile(null);
	}, []);

	// Command palette: build actions list
	const commandPaletteActions = useMemo((): CommandPaletteAction[] => {
		const acts: CommandPaletteAction[] = [];

		// --- Navigation ---
		acts.push({
			id: 'nav-all-sessions',
			label: 'Switch to Session...',
			category: 'Navigation',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
					<line x1="3" y1="9" x2="21" y2="9" />
					<line x1="9" y1="21" x2="9" y2="9" />
				</svg>
			),
			action: () => setShowAllSessions(true),
		});
		acts.push({
			id: 'nav-files',
			label: 'Open Files Panel',
			category: 'Navigation',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
					<polyline points="13 2 13 9 20 9" />
				</svg>
			),
			action: () => handleOpenRightDrawer('files'),
		});
		acts.push({
			id: 'nav-history',
			label: 'Open History Panel',
			category: 'Navigation',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<circle cx="12" cy="12" r="10" />
					<polyline points="12 6 12 12 16 14" />
				</svg>
			),
			action: () => handleOpenRightDrawer('history'),
		});
		acts.push({
			id: 'nav-autorun-tab',
			label: 'Open Auto Run Panel',
			category: 'Navigation',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<polygon points="5 3 19 12 5 21 5 3" />
				</svg>
			),
			action: () => handleOpenRightDrawer('autorun'),
		});
		acts.push({
			id: 'nav-git',
			label: 'Open Git Panel',
			category: 'Navigation',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<circle cx="18" cy="18" r="3" />
					<circle cx="6" cy="6" r="3" />
					<path d="M13 6h3a2 2 0 0 1 2 2v7" />
					<line x1="6" y1="9" x2="6" y2="21" />
				</svg>
			),
			action: () => handleOpenRightDrawer('git'),
		});

		// --- Agent ---
		acts.push({
			id: 'agent-new',
			label: 'New Agent',
			category: 'Agent',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<line x1="12" y1="5" x2="12" y2="19" />
					<line x1="5" y1="12" x2="19" y2="12" />
				</svg>
			),
			action: () => setShowAgentCreation(true),
		});
		acts.push({
			id: 'agent-rename',
			label: 'Rename Current Agent',
			category: 'Agent',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
					<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
				</svg>
			),
			available: () => !!activeSessionId,
			action: () => {
				if (activeSessionId) {
					const newName = window.prompt('Rename agent:', activeSession?.name || '');
					if (newName && newName.trim()) {
						agentManagement.renameAgent(activeSessionId, newName.trim());
					}
				}
			},
		});
		acts.push({
			id: 'agent-delete',
			label: 'Delete Current Agent',
			category: 'Agent',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<polyline points="3 6 5 6 21 6" />
					<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
				</svg>
			),
			available: () => !!activeSessionId,
			action: () => {
				if (activeSessionId && window.confirm('Delete this agent?')) {
					agentManagement.deleteAgent(activeSessionId);
				}
			},
		});

		acts.push({
			id: 'agent-context',
			label: 'Context Management',
			category: 'Agent',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<circle cx="12" cy="12" r="10" />
					<path d="M8 12h8" />
					<path d="M12 8v8" />
				</svg>
			),
			available: () => !!activeSessionId && sessions.length > 0,
			action: () => setShowContextManagement(true),
		});

		// --- Auto Run ---
		acts.push({
			id: 'autorun-launch',
			label: 'Launch Auto Run',
			category: 'Auto Run',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<polygon points="5 3 19 12 5 21 5 3" />
				</svg>
			),
			available: () => !!activeSessionId && !currentAutoRunState?.isRunning,
			action: () => setShowAutoRunSetup(true),
		});
		acts.push({
			id: 'autorun-stop',
			label: 'Stop Auto Run',
			category: 'Auto Run',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<rect x="6" y="6" width="12" height="12" />
				</svg>
			),
			available: () => !!currentAutoRunState?.isRunning,
			action: () => handleOpenAutoRunPanel(),
		});
		acts.push({
			id: 'autorun-documents',
			label: 'View Auto Run Documents',
			category: 'Auto Run',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
					<polyline points="14 2 14 8 20 8" />
					<line x1="16" y1="13" x2="8" y2="13" />
					<line x1="16" y1="17" x2="8" y2="17" />
				</svg>
			),
			action: () => handleOpenAutoRunPanel(),
		});

		// --- Group Chat ---
		acts.push({
			id: 'groupchat-new',
			label: 'Start New Group Chat',
			category: 'Group Chat',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
					<circle cx="9" cy="7" r="4" />
					<path d="M23 21v-2a4 4 0 0 0-3-3.87" />
					<path d="M16 3.13a4 4 0 0 1 0 7.75" />
				</svg>
			),
			action: () => setShowGroupChatSetup(true),
		});
		acts.push({
			id: 'groupchat-active',
			label: 'View Active Chats',
			category: 'Group Chat',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
				</svg>
			),
			available: () => activeGroupChats.length > 0,
			action: () => setShowGroupChatList(true),
		});

		// --- Cue Automation ---
		acts.push({
			id: 'cue-dashboard',
			label: 'Maestro Cue',
			category: 'Cue',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
				</svg>
			),
			action: () => setShowCuePanel(true),
		});

		// --- Analytics ---
		acts.push({
			id: 'analytics-usage',
			label: 'Usage Dashboard',
			category: 'Analytics',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
					<path d="M22 12A10 10 0 0 0 12 2v10z" />
				</svg>
			),
			action: () => setShowUsageDashboard(true),
		});
		acts.push({
			id: 'analytics-achievements',
			label: 'Achievements',
			category: 'Analytics',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<circle cx="12" cy="8" r="7" />
					<polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88" />
				</svg>
			),
			action: () => setShowAchievements(true),
		});

		// --- Settings ---
		acts.push({
			id: 'settings-open',
			label: 'Open Settings',
			category: 'Settings',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<circle cx="12" cy="12" r="3" />
					<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
				</svg>
			),
			action: () => setShowSettingsPanel(true),
		});
		acts.push({
			id: 'settings-toggle-theme',
			label: 'Toggle Dark/Light Theme',
			category: 'Settings',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<circle cx="12" cy="12" r="5" />
					<line x1="12" y1="1" x2="12" y2="3" />
					<line x1="12" y1="21" x2="12" y2="23" />
					<line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
					<line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
					<line x1="1" y1="12" x2="3" y2="12" />
					<line x1="21" y1="12" x2="23" y2="12" />
					<line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
					<line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
				</svg>
			),
			action: () => {
				const currentTheme = settingsHook.settings?.theme;
				const isDark =
					!currentTheme ||
					currentTheme === 'dracula' ||
					currentTheme === 'monokai' ||
					currentTheme === 'solarized-dark' ||
					currentTheme === 'tokyo-night';
				const newTheme = isDark ? 'github-light' : 'dracula';
				settingsHook.setTheme(newTheme);
			},
		});

		// --- View ---
		acts.push({
			id: 'view-notifications',
			label: 'Notification Settings',
			category: 'View',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
					<path d="M13.73 21a2 2 0 0 1-3.46 0" />
				</svg>
			),
			action: () => setShowNotificationSettings(true),
		});
		acts.push({
			id: 'view-all-sessions',
			label: 'Toggle All Sessions View',
			category: 'View',
			icon: (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<line x1="8" y1="6" x2="21" y2="6" />
					<line x1="8" y1="12" x2="21" y2="12" />
					<line x1="8" y1="18" x2="21" y2="18" />
					<line x1="3" y1="6" x2="3.01" y2="6" />
					<line x1="3" y1="12" x2="3.01" y2="12" />
					<line x1="3" y1="18" x2="3.01" y2="18" />
				</svg>
			),
			action: () => setShowAllSessions((prev) => !prev),
		});
		acts.push({
			id: 'view-mode-switch',
			label:
				activeSession?.inputMode === 'terminal' ? 'Switch to AI Mode' : 'Switch to Terminal Mode',
			category: 'View',
			icon:
				activeSession?.inputMode === 'terminal' ? (
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M12 3v2M12 19v2M5.64 5.64l1.42 1.42M16.95 16.95l1.41 1.41M3 12h2M19 12h2M5.64 18.36l1.42-1.42M16.95 7.05l1.41-1.41" />
						<circle cx="12" cy="12" r="4" />
					</svg>
				) : (
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<polyline points="4 17 10 11 4 5" />
						<line x1="12" y1="19" x2="20" y2="19" />
					</svg>
				),
			available: () => !!activeSessionId,
			action: () => {
				const newMode = activeSession?.inputMode === 'terminal' ? 'ai' : 'terminal';
				handleModeToggle(newMode as InputMode);
			},
		});

		return acts;
	}, [
		activeSessionId,
		activeSession,
		sessions,
		currentAutoRunState,
		activeGroupChats.length,
		settingsHook,
		agentManagement,
		handleOpenRightDrawer,
		handleOpenAutoRunPanel,
		handleModeToggle,
	]);

	// Determine content based on connection state
	const renderContent = () => {
		// Show offline state when device has no network connectivity
		if (isOffline) {
			return (
				<div
					style={{
						marginBottom: '24px',
						padding: '16px',
						borderRadius: '12px',
						backgroundColor: colors.bgSidebar,
						border: `1px solid ${colors.border}`,
						maxWidth: '300px',
					}}
				>
					<h2 style={{ fontSize: '16px', marginBottom: '8px', color: colors.textMain }}>
						You're Offline
					</h2>
					<p style={{ fontSize: '14px', color: colors.textDim, marginBottom: '12px' }}>
						No internet connection. Maestro requires a network connection to communicate with your
						desktop app.
					</p>
					<p style={{ fontSize: '12px', color: colors.textDim }}>
						The app will automatically reconnect when you're back online.
					</p>
				</div>
			);
		}

		if (connectionState === 'disconnected') {
			return (
				<div
					style={{
						marginBottom: '24px',
						padding: '16px',
						borderRadius: '12px',
						backgroundColor: colors.bgSidebar,
						border: `1px solid ${colors.border}`,
						maxWidth: '300px',
					}}
				>
					<h2 style={{ fontSize: '16px', marginBottom: '8px', color: colors.textMain }}>
						Connection Lost
					</h2>
					<p style={{ fontSize: '14px', color: colors.textDim, marginBottom: '12px' }}>
						{error || 'Unable to connect to Maestro desktop app.'}
					</p>
					<p style={{ fontSize: '12px', color: colors.textDim, marginBottom: '12px' }}>
						Reconnecting in {reconnectCountdown}s...
						{reconnectAttempts > 0 && ` (attempt ${reconnectAttempts})`}
					</p>
					<button
						onClick={handleRetry}
						style={{
							padding: '8px 16px',
							borderRadius: '6px',
							backgroundColor: colors.accent,
							color: '#fff',
							fontSize: '14px',
							fontWeight: 500,
							border: 'none',
							cursor: 'pointer',
						}}
					>
						Retry Now
					</button>
				</div>
			);
		}

		if (connectionState === 'connecting' || connectionState === 'authenticating') {
			return (
				<div
					style={{
						marginBottom: '24px',
						padding: '16px',
						borderRadius: '12px',
						backgroundColor: colors.bgSidebar,
						border: `1px solid ${colors.border}`,
						maxWidth: '300px',
					}}
				>
					<h2 style={{ fontSize: '16px', marginBottom: '8px', color: colors.textMain }}>
						Connecting to Maestro...
					</h2>
					<p style={{ fontSize: '14px', color: colors.textDim }}>
						Please wait while we establish a connection to your desktop app.
					</p>
				</div>
			);
		}

		// Connected or authenticated state - show conversation or prompt to select session
		if (!activeSession) {
			return (
				<div
					style={{
						marginBottom: '24px',
						padding: '16px',
						textAlign: 'center',
					}}
				>
					<p style={{ fontSize: '14px', color: colors.textDim }}>
						Select a session above to get started
					</p>
				</div>
			);
		}

		// Get logs based on current input mode
		const currentLogs =
			activeSession.inputMode === 'ai' ? sessionLogs.aiLogs : sessionLogs.shellLogs;

		// Show message history
		return (
			<div
				style={{
					width: '100%',
					maxWidth: '100%',
					display: 'flex',
					flexDirection: 'column',
					gap: '8px',
					alignItems: 'stretch',
					flex: 1,
					minHeight: 0, // Required for nested flex scroll to work
					overflow: 'hidden', // Contain MessageHistory's scroll
				}}
			>
				{currentInputMode === 'terminal' ? (
					<WebTerminal
						key={`terminal-${activeSessionId}`}
						ref={webTerminalRef}
						theme={theme}
						onData={(data) => {
							if (activeSessionId) {
								send({
									type: 'terminal_write',
									sessionId: activeSessionId,
									data,
								});
							}
						}}
						onResize={(cols, rows) => {
							if (activeSessionId) {
								send({
									type: 'terminal_resize',
									sessionId: activeSessionId,
									cols,
									rows,
								});
							}
						}}
					/>
				) : isLoadingLogs ? (
					<div
						style={{
							padding: '16px',
							textAlign: 'center',
							color: colors.textDim,
							fontSize: '13px',
						}}
					>
						Loading conversation...
					</div>
				) : currentLogs.length === 0 ? (
					<div
						style={{
							padding: '16px',
							textAlign: 'center',
							color: colors.textDim,
							fontSize: '14px',
						}}
					>
						Ask your AI assistant anything
					</div>
				) : (
					<MessageHistory
						logs={currentLogs}
						inputMode={currentInputMode}
						autoScroll={true}
						maxHeight="none"
						thinkingMode={thinkingMode}
						sessionState={activeSession?.state}
						enableBionifyReadingMode={bionifyReadingMode}
						maxOutputLines={
							// null (wire-serialized Infinity) and undefined both map to "All".
							settingsHook.settings?.maxOutputLines == null
								? Infinity
								: settingsHook.settings.maxOutputLines
						}
					/>
				)}
			</div>
		);
	};

	// CSS variable for dynamic viewport height with fallback
	// The fixed CommandInputBar requires padding at the bottom of the container
	const containerStyle: React.CSSProperties = {
		display: 'flex',
		flexDirection: 'column',
		height: '100dvh',
		maxHeight: '100dvh',
		overflow: 'hidden',
		backgroundColor: colors.bgMain,
		color: colors.textMain,
		fontSize: settingsHook.settings?.fontSize ? `${settingsHook.settings.fontSize}px` : undefined,
	};

	return (
		<div
			style={containerStyle}
			onTouchStart={handleMainTouchStart}
			onTouchMove={handleMainTouchMove}
			onTouchEnd={handleMainTouchEnd}
		>
			{/* Header with session info */}
			<MobileHeader
				activeSession={activeSession}
				onMenuTap={() => setShowLeftPanel((prev) => !prev)}
				isLeftPanelOpen={showLeftPanel}
				onSearchTap={handleOpenCommandPalette}
				onRightDrawerTap={() => {
					if (showRightDrawer) {
						handleCloseRightDrawer();
					} else {
						handleOpenRightDrawer('files');
					}
				}}
				isRightPanelOpen={showRightDrawer}
				onCueTap={handleCueTap}
				hasRunningCue={hasRunningCue}
				onNotificationTap={handleOpenNotificationSettings}
				onSettingsTap={handleOpenSettingsPanel}
				notificationCount={notificationCount}
				completedAgents={completedAgents}
				onSelectAgent={(sessionId) => {
					handleSelectSession(sessionId);
					triggerHaptic(HAPTIC_PATTERNS.tap);
				}}
				onClearNotifications={() => {
					setCompletedAgents([]);
					setNotificationCount(0);
				}}
				onOpenNotificationSettings={handleOpenNotificationSettings}
				onGroupChatTap={handleGroupChatTap}
				groupChatCount={activeGroupChats.length}
				onUsageDashboardTap={() => {
					setShowUsageDashboard(true);
					triggerHaptic(HAPTIC_PATTERNS.tap);
				}}
				onAchievementsTap={() => {
					setShowAchievements(true);
					triggerHaptic(HAPTIC_PATTERNS.tap);
				}}
				onContextManagementTap={() => setShowContextManagement(true)}
				onNewAgentTap={handleOpenAgentCreation}
			/>

			{/* Tab bar - Row 2: Unified tab bar with AI tabs + terminal tab */}
			{activeSession?.aiTabs && activeSession.activeTabId && (
				<TabBar
					tabs={activeSession.aiTabs}
					activeTabId={activeSession.activeTabId}
					onSelectTab={(tabId) => {
						// Selecting an AI tab also switches to AI mode
						if (currentInputMode !== 'ai') {
							handleModeToggle('ai');
						}
						handleSelectTab(tabId);
					}}
					onNewTab={handleNewTab}
					onCloseTab={handleCloseTab}
					onOpenTabSearch={handleOpenTabSearch}
					onRenameTab={handleRenameTab}
					onStarTab={handleStarTab}
					onReorderTab={handleReorderTab}
					inputMode={currentInputMode}
					onSelectTerminal={() => {
						if (currentInputMode !== 'terminal') {
							handleModeToggle('terminal');
						}
					}}
					onCloseTerminal={() => {
						if (currentInputMode === 'terminal') {
							handleModeToggle('ai');
						}
					}}
				/>
			)}

			{/* AutoRun indicator - shown when batch processing is active on desktop */}
			{activeSessionId && autoRunStates[activeSessionId] && (
				<AutoRunIndicator
					state={autoRunStates[activeSessionId]}
					sessionName={activeSession?.name}
					onTap={handleOpenAutoRunPanel}
				/>
			)}

			{/* Offline queue banner - shown when there are queued commands */}
			{offlineQueueLength > 0 && (
				<OfflineQueueBanner
					queue={offlineQueue}
					status={offlineQueueStatus}
					onClearQueue={clearOfflineQueue}
					onProcessQueue={processOfflineQueue}
					onRemoveCommand={removeQueuedCommand}
					isOffline={isOffline}
					isConnected={isActuallyConnected}
				/>
			)}

			{/* All Sessions view - full-screen modal with larger session cards */}
			{showAllSessions && (
				<AllSessionsView
					sessions={sessions}
					activeSessionId={activeSessionId}
					onSelectSession={handleSelectSession}
					onClose={handleCloseAllSessions}
					onRenameAgent={agentManagement.renameAgent}
					onDeleteAgent={agentManagement.deleteAgent}
					onMoveToGroup={agentManagement.moveToGroup}
					groups={agentManagement.groups}
					onOpenCreateAgent={handleOpenAgentCreation}
				/>
			)}

			{/* Git diff viewer - full-screen overlay when viewing a file diff */}
			{gitDiffFile && gitStatus.diff && (
				<GitDiffViewer
					diff={gitStatus.diff.diff}
					filePath={gitDiffFile}
					onBack={handleBackFromGitDiff}
				/>
			)}

			{/* Tab search modal - command palette for searching tabs */}
			{activeSession?.aiTabs && activeSession.activeTabId && (
				<TabSearchModal
					isOpen={showTabSearch}
					tabs={activeSession.aiTabs}
					activeTabId={activeSession.activeTabId}
					onSelectTab={handleSelectTab}
					onClose={handleCloseTabSearch}
				/>
			)}

			{/* Auto Run panel - full-screen management view */}
			{showAutoRunPanel && activeSessionId && (
				<AutoRunPanel
					sessionId={activeSessionId}
					autoRunState={currentAutoRunState}
					onClose={handleCloseAutoRunPanel}
					onOpenDocument={handleAutoRunOpenDocument}
					onOpenSetup={handleAutoRunOpenSetup}
					sendRequest={sendRequest}
					send={send}
				/>
			)}

			{/* Auto Run document viewer - full-screen overlay on top of panel */}
			{showAutoRunPanel && activeSessionId && autoRunViewingDoc && (
				<AutoRunDocumentViewer
					sessionId={activeSessionId}
					filename={autoRunViewingDoc}
					onBack={handleAutoRunBackFromDocument}
					sendRequest={sendRequest}
				/>
			)}

			{/* Auto Run setup — centered modal on tablet+, bottom sheet on phone */}
			{activeSessionId && (
				<AutoRunSetupSheet
					isOpen={showAutoRunSetup}
					sessionId={activeSessionId}
					documents={autoRunDocuments}
					onLaunch={handleAutoRunLaunch}
					onClose={handleAutoRunCloseSetup}
				/>
			)}

			{/* Notification settings bottom sheet */}
			<NotificationSettingsSheet
				isOpen={showNotificationSettings}
				preferences={notificationPreferences}
				onPreferencesChange={setNotificationPreferences}
				permission={notificationPermission}
				onClose={handleCloseNotificationSettings}
			/>

			{/* Settings panel - full-screen overlay */}
			{showSettingsPanel && (
				<SettingsPanel onClose={handleCloseSettingsPanel} settingsHook={settingsHook} />
			)}

			{/* Agent creation sheet */}
			<AgentCreationSheet
				isOpen={showAgentCreation}
				groups={agentManagement.groups}
				defaultCwd={activeSession?.cwd || ''}
				createAgent={agentManagement.createAgent}
				onCreated={handleAgentCreated}
				onClose={() => setShowAgentCreation(false)}
			/>

			{/* Group Chat panel — full-screen overlay */}
			{activeGroupChatId && groupChat.activeChat && (
				<GroupChatPanel
					chatState={groupChat.activeChat}
					onSendMessage={handleGroupChatSendMessage}
					onStop={handleGroupChatStop}
					onBack={handleGroupChatBack}
				/>
			)}

			{/* Cue automation panel — full-screen overlay */}
			{showCuePanel && (
				<CuePanel
					subscriptions={cue.subscriptions}
					activity={cue.activity}
					isLoading={cue.isLoading}
					onToggleSubscription={cue.toggleSubscription}
					onRefresh={handleCueRefresh}
					onClose={handleCloseCuePanel}
				/>
			)}

			{/* Usage Dashboard panel — full-screen overlay */}
			{showUsageDashboard && (
				<UsageDashboardPanel
					onClose={() => setShowUsageDashboard(false)}
					sendRequest={sendRequest}
				/>
			)}

			{/* Achievements panel — full-screen overlay */}
			{showAchievements && (
				<AchievementsPanel onClose={() => setShowAchievements(false)} sendRequest={sendRequest} />
			)}

			{/* Context management sheet */}
			{activeSessionId && (
				<ContextManagementSheet
					isOpen={showContextManagement}
					sessions={sessions}
					currentSessionId={activeSessionId}
					sendRequest={sendRequest}
					onClose={() => setShowContextManagement(false)}
				/>
			)}

			{/* Group Chat setup sheet */}
			<GroupChatSetupSheet
				isOpen={showGroupChatSetup}
				sessions={sessions}
				onStart={handleGroupChatStart}
				onClose={() => setShowGroupChatSetup(false)}
			/>

			{/* Group Chat list — centered modal on tablet+, bottom sheet on phone */}
			<GroupChatListSheet
				isOpen={showGroupChatList}
				chats={groupChat.chats}
				onSelectChat={handleGroupChatOpen}
				onNewChat={() => {
					setShowGroupChatList(false);
					setShowGroupChatSetup(true);
				}}
				onClose={() => setShowGroupChatList(false)}
			/>

			{/* Horizontal layout: left panel + main content + right panel. Each
			    panel's `mode` is derived from tier + open-state + a min-width guard
			    on `main` (see `./panelModes`). */}
			<div className="flex flex-1 flex-row min-h-0 overflow-hidden">
				{/* Left panel — agent list, toggleable */}
				{showLeftPanel && (
					<LeftPanel
						sessions={sessions}
						activeSessionId={activeSessionId}
						onSelectSession={handleSelectSession}
						onClose={() => setShowLeftPanel(false)}
						onNewAgent={handleOpenAgentCreation}
						mode={panelModes.leftMode}
						panelRef={panelModes.leftMode === 'inline' ? leftPanelResize.panelRef : undefined}
						width={panelModes.leftMode === 'inline' ? leftPanelResize.width : undefined}
						onResizeStart={
							panelModes.leftMode === 'inline' ? leftPanelResize.onResizeStart : undefined
						}
						collapsedGroups={collapsedGroups}
						setCollapsedGroups={setCollapsedGroups}
						showUnreadOnly={showUnreadAgentsOnly}
						setShowUnreadOnly={setShowUnreadAgentsOnly}
						groups={agentManagement.groups}
						onCreateGroup={agentManagement.createGroup}
						onMoveToGroup={agentManagement.moveToGroup}
					/>
				)}

				{/* Main content area. Tailwind handles layout / overflow; the
				    bottom padding stays inline because `inputBarHeight` is a
				    dynamic value reported by `CommandInputBar` via
				    `onHeightChange`. The reported height already includes
				    `max(12px, env(safe-area-inset-bottom))`, so we don't add
				    the inset again here (would gap on notched devices). */}
				<main
					className={`flex flex-1 flex-col justify-start min-h-0 min-w-0 overflow-hidden ${
						currentInputMode === 'terminal'
							? 'items-stretch p-0 text-left'
							: 'items-center px-3 pt-3 text-center'
					}`}
					style={{
						paddingBottom: currentInputMode === 'terminal' ? 0 : `${inputBarHeight}px`,
					}}
				>
					{/* Content wrapper */}
					<div
						className={`flex flex-1 flex-col w-full min-h-0 overflow-hidden ${
							currentInputMode === 'terminal' ? 'items-stretch' : 'items-center'
						} ${
							connectionState === 'connected' || connectionState === 'authenticated'
								? 'justify-start'
								: 'justify-center'
						}`}
					>
						{renderContent()}
						{connectionState !== 'connected' && connectionState !== 'authenticated' && (
							<p style={{ fontSize: '12px', color: colors.textDim }}>
								Make sure Maestro desktop app is running
							</p>
						)}
					</div>
				</main>

				{/* Right panel — inline, toggleable */}
				{showRightDrawer && activeSessionId && (
					<RightPanel
						sessionId={activeSessionId}
						activeTab={rightDrawerTab}
						autoRunState={currentAutoRunState}
						gitStatus={gitStatus}
						onClose={handleCloseRightDrawer}
						projectPath={activeSession?.cwd}
						onAutoRunOpenDocument={handleAutoRunOpenDocument}
						onAutoRunOpenSetup={handleAutoRunOpenSetup}
						sendRequest={sendRequest}
						send={send}
						onViewDiff={handleViewGitDiff}
						mode={panelModes.rightMode}
						panelRef={panelModes.rightMode === 'inline' ? rightPanelResize.panelRef : undefined}
						width={panelModes.rightMode === 'inline' ? rightPanelResize.width : undefined}
						onResizeStart={
							panelModes.rightMode === 'inline' ? rightPanelResize.onResizeStart : undefined
						}
					/>
				)}
			</div>

			{/* Sticky bottom command input bar — hidden in terminal mode (xterm.js handles all input) */}
			{currentInputMode !== 'terminal' && (
				<CommandInputBar
					isOffline={isOffline}
					isConnected={connectionState === 'connected' || connectionState === 'authenticated'}
					value={commandInput}
					onChange={handleCommandChange}
					onSubmit={handleCommandSubmit}
					placeholder={
						!activeSessionId
							? 'Select a session first...'
							: isSmallScreen
								? 'Ask AI...'
								: `Ask ${activeSession?.toolType === 'claude-code' ? 'Claude' : activeSession?.toolType || 'AI'} about ${activeSession?.name || 'this session'}...`
					}
					disabled={!activeSessionId}
					inputMode={currentInputMode}
					isSessionBusy={activeSession?.state === 'busy'}
					onInterrupt={handleInterrupt}
					cwd={activeSession?.cwd}
					slashCommands={allSlashCommands}
					showRecentCommands={false}
					onOpenCommandPalette={handleOpenCommandPalette}
					thinkingMode={thinkingMode}
					onToggleThinking={handleToggleThinking}
					supportsThinking={activeSession?.toolType === 'claude-code'}
					compact={isShortViewport}
					onHeightChange={setInputBarHeight}
				/>
			)}

			{/* Command palette */}
			<QuickActionsMenu
				isOpen={showCommandPalette}
				onClose={handleCloseCommandPalette}
				actions={commandPaletteActions}
			/>

			{/* Full-screen response viewer modal */}
			<ResponseViewer
				isOpen={showResponseViewer}
				response={selectedResponse}
				allResponses={allResponses.length > 1 ? allResponses : undefined}
				currentIndex={responseIndex}
				onNavigate={handleNavigateResponse}
				onClose={handleCloseResponseViewer}
				sessionName={activeSession?.name}
				enableBionifyReadingMode={bionifyReadingMode}
			/>
		</div>
	);
}
