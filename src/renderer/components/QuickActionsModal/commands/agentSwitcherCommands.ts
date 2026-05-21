import type { Session } from '../../../types';
import { getTabDisplayName } from '../../../utils/tabHelpers';
import type { QuickAction } from '../types';
import { alphabetizeKey } from '../utils/quickActionSorting';

interface BuildAgentSwitcherCommandsArgs {
	sessions: Session[];
	activeBatchSessionIds: string[];
	handleJumpToSession: (session: Session) => void | Promise<void>;
}

export function buildAgentSwitcherCommands({
	sessions,
	activeBatchSessionIds,
	handleJumpToSession,
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
			action: () => {
				void handleJumpToSession(session);
			},
			subtext: undefined,
			isRunningAgent,
			isInBatch,
			runningInfo,
			bookmarked: !!session.bookmarked,
			agentSortKey: alphabetizeKey(session.name),
		};
	});
}
