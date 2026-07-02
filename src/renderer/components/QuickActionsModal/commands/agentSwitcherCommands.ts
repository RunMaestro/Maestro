import type { Session } from '../../../types';
import { getTabDisplayName } from '../../../utils/tabHelpers';
import type { QuickAction } from '../types';
import { alphabetizeKey } from '../utils/quickActionSorting';
import { makeAgentJumpAction, type GetSessionWindow } from './agentJumpAction';

interface BuildAgentSwitcherCommandsArgs {
	sessions: Session[];
	activeBatchSessionIds: string[];
	setActiveSessionId: (id: string) => void;
	revealJumpTarget: (session: Session) => void;
	/** Multi-window: resolves an agent's owning window so cross-window picks focus
	 * that window instead of stealing the agent. Omitted = single-window behavior. */
	getSessionWindow?: GetSessionWindow;
}

export function buildAgentSwitcherCommands({
	sessions,
	activeBatchSessionIds,
	setActiveSessionId,
	revealJumpTarget,
	getSessionWindow,
}: BuildAgentSwitcherCommandsArgs): QuickAction[] {
	const batchSessionIdSet = new Set(activeBatchSessionIds);

	return sessions.map((session) => {
		const isInBatch = batchSessionIdSet.has(session.id);
		const isSessionBusy = session.state !== 'idle';
		const isRunningAgent = isSessionBusy || isInBatch;
		const busyTab = isSessionBusy
			? (session.aiTabs?.find((tab) => tab.state === 'busy') ??
				session.aiTabs?.find((tab) => tab.id === session.activeTabId))
			: undefined;
		const runningInfo = isSessionBusy
			? {
					state: session.state,
					thinkingStartTime: busyTab?.thinkingStartTime ?? session.thinkingStartTime,
					busyTabName: busyTab ? getTabDisplayName(busyTab) : undefined,
					queueCount: session.executionQueue?.length ?? 0,
				}
			: undefined;

		return {
			id: `jump-${session.id}`,
			label: session.name,
			action: makeAgentJumpAction({
				session,
				setActiveSessionId,
				revealJumpTarget,
				getSessionWindow,
			}),
			subtext: undefined,
			isRunningAgent,
			isInBatch,
			runningInfo,
			bookmarked: !!session.bookmarked,
			agentSortKey: alphabetizeKey(session.name),
		};
	});
}
