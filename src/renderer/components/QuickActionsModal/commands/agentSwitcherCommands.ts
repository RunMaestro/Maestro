import {
	autoRunProgressPercent,
	type AutoRunProgressInput,
} from '../../../../shared/autorunProgress';
import type { Session } from '../../../types';
import { sessionJumpShortcut } from '../../../utils/sessionJumpSlots';
import { getTabDisplayName } from '../../../utils/tabHelpers';
import type { QuickAction } from '../types';
import { alphabetizeKey } from '../utils/quickActionSorting';
import { makeAgentJumpAction, type GetSessionWindow } from './agentJumpAction';

interface BuildAgentSwitcherCommandsArgs {
	sessions: Session[];
	activeBatchSessionIds: string[];
	/** Live Auto Run state per agent, for the percent drawn inside the AUTO pill. */
	batchRunStates?: Record<string, AutoRunProgressInput | undefined>;
	setActiveSessionId: (id: string) => void;
	revealJumpTarget: (session: Session) => void;
	/** Multi-window: resolves an agent's owning window so cross-window picks focus
	 * that window instead of stealing the agent. Omitted = single-window behavior. */
	getSessionWindow?: GetSessionWindow;
	/** Agent ID -> Opt+Cmd+# digit, for agents in the Left Bar's first ten slots. */
	jumpSlots?: Map<string, string>;
	/**
	 * Groups parked out of the Left Bar. Their agents stay in this list - the
	 * switcher is how you REACH a hidden agent - they just sort into the last
	 * tier. Deliberately the raw hidden set rather than the sidebar's resolved
	 * one: "Show Hidden" decides what the list draws, not what the group is.
	 */
	hiddenGroupIds?: ReadonlySet<string>;
}

export function buildAgentSwitcherCommands({
	sessions,
	activeBatchSessionIds,
	batchRunStates,
	setActiveSessionId,
	revealJumpTarget,
	getSessionWindow,
	jumpSlots,
	hiddenGroupIds,
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
		const batchState = isInBatch ? batchRunStates?.[session.id] : undefined;
		// Rounded the same way as the Auto Run card's Progress column, so the two
		// surfaces never show different numbers for one run.
		const autoRunProgress = batchState
			? {
					percent: Math.round(autoRunProgressPercent(batchState)),
					goalMode: !!batchState.goalMode,
				}
			: undefined;
		const jumpDigit = jumpSlots?.get(session.id);

		return {
			id: `jump-${session.id}`,
			label: session.name,
			shortcut: jumpDigit ? sessionJumpShortcut(jumpDigit) : undefined,
			// Drawn literally: the slot's own digit. All ten rows share the one
			// `jumpToSession` action, so asking the resolver for that id would
			// print the family's range spelling (`Opt+Cmd+1-0`) on every row.
			shortcutKeys: jumpDigit ? sessionJumpShortcut(jumpDigit).keys : undefined,
			action: makeAgentJumpAction({
				session,
				setActiveSessionId,
				revealJumpTarget,
				getSessionWindow,
			}),
			subtext: undefined,
			isRunningAgent,
			isInBatch,
			autoRunProgress,
			runningInfo,
			bookmarked: !!session.bookmarked,
			agentSortKey: alphabetizeKey(session.name),
			inHiddenGroup: !!session.groupId && !!hiddenGroupIds?.has(session.groupId),
		};
	});
}
