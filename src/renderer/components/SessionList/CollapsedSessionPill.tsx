import { memo, useState } from 'react';
import type { Session, Theme } from '../../types';
import { getStatusColor } from '../../utils/theme';
import { hasNoClaudeProviderSession } from '../SessionItem';
import { SessionTooltipContent } from './SessionTooltipContent';

interface CollapsedSessionPillProps {
	session: Session;
	keyPrefix: string;
	theme: Theme;
	activeBatchSessionIds: string[];
	leftSidebarWidth: number;
	contextWarningYellowThreshold: number;
	contextWarningRedThreshold: number;
	getFileCount: (sessionId: string) => number;
	getWorktreeChildren: (parentId: string) => Session[];
	setActiveSessionId: (id: string) => void;
}

/** Bounds + default for the configurable "pills per row" Left Bar setting. */
export const COLLAPSED_PILLS_PER_ROW_MIN = 5;
export const COLLAPSED_PILLS_PER_ROW_MAX = 50;
export const COLLAPSED_PILLS_PER_ROW_DEFAULT = 20;

type CollapsedSessionPillRowsProps = Omit<CollapsedSessionPillProps, 'session'> & {
	sessions: Session[];
	onContainerClick: () => void;
	/** Max pills per row before wrapping. Defaults to {@link COLLAPSED_PILLS_PER_ROW_DEFAULT}. */
	maxPerRow?: number;
};

export function CollapsedSessionPillRows({
	sessions,
	keyPrefix,
	onContainerClick,
	maxPerRow = COLLAPSED_PILLS_PER_ROW_DEFAULT,
	...pillProps
}: CollapsedSessionPillRowsProps) {
	const perRow = Math.max(1, Math.floor(maxPerRow) || COLLAPSED_PILLS_PER_ROW_DEFAULT);
	const rows: Session[][] = [];
	for (let i = 0; i < sessions.length; i += perRow) {
		rows.push(sessions.slice(i, i + perRow));
	}
	return (
		<div
			className="ml-8 mr-3 mt-1 mb-2 flex flex-col gap-1 cursor-pointer"
			onClick={onContainerClick}
		>
			{rows.map((row, rowIdx) => {
				const padding = rows.length > 1 ? perRow - row.length : 0;
				return (
					<div key={`${keyPrefix}-row-${rowIdx}`} className="flex gap-1 h-1.5">
						{row.map((s) => (
							<CollapsedSessionPill
								key={`${keyPrefix}-${s.id}`}
								session={s}
								keyPrefix={keyPrefix}
								{...pillProps}
							/>
						))}
						{padding > 0 &&
							Array.from({ length: padding }).map((_, i) => (
								<div key={`${keyPrefix}-row-${rowIdx}-spacer-${i}`} className="flex-1" />
							))}
					</div>
				);
			})}
		</div>
	);
}

export const CollapsedSessionPill = memo(function CollapsedSessionPill({
	session,
	keyPrefix,
	theme,
	activeBatchSessionIds,
	leftSidebarWidth,
	contextWarningYellowThreshold,
	contextWarningRedThreshold,
	getFileCount,
	getWorktreeChildren,
	setActiveSessionId,
}: CollapsedSessionPillProps) {
	const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);

	const worktreeChildren = getWorktreeChildren(session.id);
	const allSessions = [session, ...worktreeChildren];
	const hasWorktrees = worktreeChildren.length > 0;

	return (
		<div
			key={`${keyPrefix}-${session.id}`}
			className="relative flex-1 flex rounded-full overflow-hidden opacity-50 hover:opacity-100 transition-opacity"
			style={{ gap: hasWorktrees ? '1px' : 0 }}
		>
			{allSessions.map((s, idx) => {
				const hasUnreadTabs = s.aiTabs?.some((tab) => tab.hasUnread);
				const isFirst = idx === 0;
				const isLast = idx === allSessions.length - 1;
				const isInBatch = activeBatchSessionIds.includes(s.id);

				return (
					<div
						key={`${keyPrefix}-part-${s.id}`}
						role="button"
						tabIndex={0}
						aria-label={`Switch to ${s.name}`}
						className={`group/segment relative flex-1 h-full ${isInBatch ? 'animate-pulse' : ''}`}
						style={{
							...(hasNoClaudeProviderSession(s) && !isInBatch
								? { border: `1px solid ${theme.colors.textDim}`, backgroundColor: 'transparent' }
								: {
										backgroundColor: isInBatch
											? theme.colors.warning
											: getStatusColor(s.state, theme),
									}),
							borderRadius: hasWorktrees
								? `${isFirst ? '9999px' : '0'} ${isLast ? '9999px' : '0'} ${isLast ? '9999px' : '0'} ${isFirst ? '9999px' : '0'}`
								: '9999px',
						}}
						onMouseEnter={(e) => setTooltipPosition({ x: e.clientX, y: e.clientY })}
						onMouseLeave={() => setTooltipPosition(null)}
						onFocus={(e) =>
							setTooltipPosition({
								x: e.currentTarget.getBoundingClientRect().x,
								y: e.currentTarget.getBoundingClientRect().y,
							})
						}
						onBlur={() => setTooltipPosition(null)}
						onClick={(e) => {
							e.stopPropagation();
							setActiveSessionId(s.id);
						}}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								e.stopPropagation();
								setActiveSessionId(s.id);
							}
						}}
					>
						{hasUnreadTabs && isLast && (
							<div
								className="absolute -right-0.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full"
								style={{ backgroundColor: theme.colors.error }}
							/>
						)}
						{tooltipPosition && (
							<div
								data-testid="collapsed-session-tooltip"
								className="fixed rounded px-3 py-2 z-[100] pointer-events-none shadow-xl"
								style={{
									minWidth: '240px',
									left: `${leftSidebarWidth + 8}px`,
									top: `${tooltipPosition.y}px`,
									backgroundColor: theme.colors.bgSidebar,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								<SessionTooltipContent
									session={s}
									theme={theme}
									gitFileCount={getFileCount(s.id)}
									isInBatch={isInBatch}
									contextWarningYellowThreshold={contextWarningYellowThreshold}
									contextWarningRedThreshold={contextWarningRedThreshold}
								/>
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
});
