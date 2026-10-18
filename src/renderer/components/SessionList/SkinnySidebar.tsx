import { useHeadlessActivityStore } from '../../stores/headlessActivityStore';
import { memo, useMemo } from 'react';
import type { Session, Group, Theme } from '../../types';
import { getStatusColor } from '../../utils/theme';
import { hasNoClaudeProviderSession } from '../SessionItem';
import { SessionTooltipContent } from './SessionTooltipContent';
import { PluginUiItemsSlot } from '../plugins/PluginUiItemsSlot';
import {
	sessionNeedsAttention,
	outageIdsFromSignature,
	type AttentionContext,
} from '../../utils/sessionAttention';
import { CornerDot } from '../ui/CornerDot';
import { hasUnreadVisibleTab } from '../../utils/tabHelpers';
import { useConsultedSessionIds } from '../../stores/crossAgentInFlightStore';
import { buildAgentInitials } from '../../../shared/agentInitials';
import { readableTextOn, transparentize } from '../../../shared/colorContrast';

/**
 * How much of the status color the initials badge is filled with. The active
 * agent gets the heavier fill plus a ring, which is what the 100% vs 25% dot
 * opacity says in dot mode.
 */
const INITIALS_FILL_ACTIVE = 0.34;
const INITIALS_FILL_INACTIVE = 0.16;

interface SkinnySidebarProps {
	theme: Theme;
	sortedSessions: Session[];
	activeSessionId: string;
	groups: Group[];
	activeBatchSessionIds: string[];
	contextWarningYellowThreshold: number;
	contextWarningRedThreshold: number;
	getFileCount: (sessionId: string) => number;
	setActiveSessionId: (id: string) => void;
	handleContextMenu: (e: React.MouseEvent, sessionId: string) => void;
	showUnreadAgentsOnly: boolean;
	/** Comma-joined signature of agents stuck auto-retrying an outage. */
	stuckOutageSignature: string;
	/** Draw each agent as a two-letter badge instead of a bare status dot. */
	showInitials: boolean;
}

export const SkinnySidebar = memo(function SkinnySidebar({
	theme,
	sortedSessions,
	activeSessionId,
	groups,
	activeBatchSessionIds,
	contextWarningYellowThreshold,
	contextWarningRedThreshold,
	getFileCount,
	setActiveSessionId,
	handleContextMenu,
	showUnreadAgentsOnly,
	stuckOutageSignature,
	showInitials,
}: SkinnySidebarProps) {
	const consultedSessionIds = useConsultedSessionIds();
	const headlessCounts = useHeadlessActivityStore((s) => s.counts);
	const attentionCtx: AttentionContext = {
		headlessCounts,
		batchSessionIds: new Set(activeBatchSessionIds),
		stuckOutageIds: outageIdsFromSignature(stuckOutageSignature),
	};
	const visibleSessions = showUnreadAgentsOnly
		? sortedSessions.filter(
				(s) => s.id === activeSessionId || sessionNeedsAttention(s, attentionCtx)
			)
		: sortedSessions;
	// Labels come from the WHOLE list, not the filtered one, so toggling the
	// unread filter cannot rename an agent the user has already learned.
	const initialsById = useMemo(
		() => (showInitials ? buildAgentInitials(sortedSessions) : null),
		[showInitials, sortedSessions]
	);

	return (
		<div className="flex-1 min-h-0 flex flex-col items-center py-4 gap-2 overflow-y-auto overflow-x-visible no-scrollbar">
			<PluginUiItemsSlot surface="activity-bar" />
			{visibleSessions.map((session) => {
				const isInBatch = activeBatchSessionIds.includes(session.id);
				const hasUnreadTabs = hasUnreadVisibleTab(session.aiTabs);
				const isUnboundClaude = hasNoClaudeProviderSession(session);
				// A cross-agent consult never touches `session.state` (hidden tab,
				// synthetic process id), so it is folded in beside Auto Run: real work
				// the collapsed rail would otherwise draw as a green idle dot. It also
				// outranks the unbound-Claude hollow dot, since a consult tab has no
				// provider session of its own until the agent answers.
				const isConsulted = consultedSessionIds.has(session.id);
				// One flag for "working, but not via `session.state`", so the color and
				// the hollow-dot branch below cannot disagree about which wins.
				const isBusyOffState = isInBatch || isConsulted || (headlessCounts[session.id] ?? 0) > 0;
				const effectiveStatusColor = isBusyOffState
					? theme.colors.warning
					: isUnboundClaude
						? undefined
						: getStatusColor(session.state, theme);
				const shouldPulse = session.state === 'busy' || isBusyOffState;
				const isActive = activeSessionId === session.id;
				// Hollow means "no provider session yet": an outline, never a fill.
				const isHollow = isUnboundClaude && !isBusyOffState;
				const statusTitle =
					(headlessCounts[session.id] ?? 0) > 0
						? 'Running headless turn'
						: isConsulted
							? 'Answering a consult'
							: isUnboundClaude
								? 'No active Claude session'
								: undefined;
				const initials = initialsById?.get(session.id);
				const unreadDot = !isActive && hasUnreadTabs && (
					<CornerDot color={theme.colors.error} title="Unread messages" />
				);
				const badgeColor = effectiveStatusColor ?? theme.colors.textDim;
				const badgeFill = transparentize(
					badgeColor,
					theme.colors.bgSidebar,
					isActive ? INITIALS_FILL_ACTIVE : INITIALS_FILL_INACTIVE
				);

				return (
					<div
						key={session.id}
						role="button"
						tabIndex={0}
						aria-label={`Switch to ${session.name}`}
						onClick={() => setActiveSessionId(session.id)}
						onContextMenu={(e) => handleContextMenu(e, session.id)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								setActiveSessionId(session.id);
							}
						}}
						className={`group relative w-8 h-8 rounded-full flex items-center justify-center cursor-pointer transition-all outline-none ${isActive ? '' : 'hover:bg-white/10'}`}
					>
						{initials ? (
							<div
								className="relative w-8 h-8 flex items-center justify-center"
								title={statusTitle}
								data-testid="skinny-initials-badge"
							>
								{/* The fill is its own layer so a busy agent pulses its
								    background while the letters stay readable. */}
								<div
									className={`absolute inset-0 rounded-full transition-[filter] ${isActive ? '' : 'group-hover:brightness-125'} ${shouldPulse ? 'animate-pulse' : ''}`}
									style={
										isHollow
											? {
													border: `1.5px solid ${theme.colors.textDim}`,
													backgroundColor: 'transparent',
													opacity: isActive ? 1 : 0.6,
												}
											: {
													backgroundColor: badgeFill,
													border: `1.5px solid ${isActive ? badgeColor : 'transparent'}`,
												}
									}
									data-testid="skinny-initials-fill"
								/>
								<span
									className="relative text-xs-plus font-semibold leading-none tracking-tight select-none"
									style={{
										color: isHollow
											? theme.colors.textDim
											: readableTextOn(badgeColor, [badgeFill]),
										opacity: isActive ? 1 : 0.8,
									}}
									aria-hidden
								>
									{initials}
								</span>
								{unreadDot}
							</div>
						) : (
							<div className="relative">
								<div
									className={`w-3 h-3 rounded-full ${shouldPulse ? 'animate-pulse' : ''}`}
									style={{
										opacity: isActive ? 1 : 0.25,
										...(isHollow
											? {
													border: `1.5px solid ${theme.colors.textDim}`,
													backgroundColor: 'transparent',
												}
											: {
													backgroundColor: effectiveStatusColor,
												}),
									}}
									title={statusTitle}
								/>
								{unreadDot}
							</div>
						)}

						{/* Hover Tooltip for Skinny Mode */}
						<div
							className="fixed rounded px-3 py-2 z-[100] opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity shadow-xl"
							style={{
								minWidth: '240px',
								left: '80px',
								backgroundColor: theme.colors.bgSidebar,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<SessionTooltipContent
								session={session}
								theme={theme}
								gitFileCount={getFileCount(session.id)}
								groupName={groups.find((g) => g.id === session.groupId)?.name}
								isInBatch={isInBatch}
								contextWarningYellowThreshold={contextWarningYellowThreshold}
								contextWarningRedThreshold={contextWarningRedThreshold}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
});
