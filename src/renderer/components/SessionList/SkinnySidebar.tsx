import { memo } from 'react';
import type { Session, Group, Theme } from '../../types';
import { getStatusColor } from '../../utils/theme';
import { SessionTooltipContent } from './SessionTooltipContent';

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
}: SkinnySidebarProps) {
	return (
		<div className="flex-1 flex flex-col items-center py-4 gap-2 overflow-y-auto overflow-x-visible no-scrollbar">
			{sortedSessions.map((session) => {
				const isInBatch = activeBatchSessionIds.includes(session.id);
				const hasUnreadTabs = session.aiTabs?.some((tab) => tab.hasUnread);
				const effectiveStatusColor = isInBatch
					? theme.colors.warning
					: session.toolType === 'claude-code' && !session.agentSessionId
						? undefined
						: getStatusColor(session.state, theme);
				const shouldPulse = session.state === 'busy' || isInBatch;

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
									...(session.toolType === 'claude-code' && !session.agentSessionId && !isInBatch
										? {
												border: `1.5px solid ${theme.colors.textDim}`,
												backgroundColor: 'transparent',
											}
										: {
												backgroundColor: effectiveStatusColor,
											}),
								}}
								title={
									session.toolType === 'claude-code' && !session.agentSessionId
										? 'No active Claude session'
										: undefined
								}
							/>
							{activeSessionId !== session.id && hasUnreadTabs && (
								<div
									className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full"
									style={{ backgroundColor: theme.colors.error }}
									title="Unread messages"
								/>
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
