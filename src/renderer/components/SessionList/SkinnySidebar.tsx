import { memo } from 'react';
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
}: SkinnySidebarProps) {
	const consultedSessionIds = useConsultedSessionIds();
	const attentionCtx: AttentionContext = {
		batchSessionIds: new Set(activeBatchSessionIds),
		stuckOutageIds: outageIdsFromSignature(stuckOutageSignature),
	};
	const visibleSessions = showUnreadAgentsOnly
		? sortedSessions.filter(
				(s) => s.id === activeSessionId || sessionNeedsAttention(s, attentionCtx)
			)
		: sortedSessions;

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
				const isBusyOffState = isInBatch || isConsulted;
				const effectiveStatusColor = isBusyOffState
					? theme.colors.warning
					: isUnboundClaude
						? undefined
						: getStatusColor(session.state, theme);
				const shouldPulse = session.state === 'busy' || isBusyOffState;

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
						className={`group relative w-8 h-8 rounded-full flex items-center justify-center cursor-pointer transition-all outline-none ${activeSessionId === session.id ? '' : 'hover:bg-white/10'}`}
					>
						<div className="relative">
							<div
								className={`w-3 h-3 rounded-full ${shouldPulse ? 'animate-pulse' : ''}`}
								style={{
									opacity: activeSessionId === session.id ? 1 : 0.25,
									...(isUnboundClaude && !isBusyOffState
										? {
												border: `1.5px solid ${theme.colors.textDim}`,
												backgroundColor: 'transparent',
											}
										: {
												backgroundColor: effectiveStatusColor,
											}),
								}}
								title={
									isConsulted
										? 'Answering a consult'
										: isUnboundClaude
											? 'No active Claude session'
											: undefined
								}
							/>
							{activeSessionId !== session.id && hasUnreadTabs && (
								<CornerDot color={theme.colors.error} title="Unread messages" />
							)}
						</div>

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
