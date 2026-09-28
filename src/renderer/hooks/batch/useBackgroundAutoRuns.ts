import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBatchStore } from '../../stores/batchStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { BackgroundAutoRun } from '../../types';

/**
 * Every Auto Run in progress on an agent OTHER than `activeSessionId`.
 *
 * The Thinking pill gets the viewed agent's run as a prop, and its thinking
 * items come from busy tabs - which Auto Run never sets. Without this, a run on
 * another agent is invisible from the pill: no +N badge, no dropdown row.
 *
 * Subscribes narrowly: to the running agents' ids, their names, and their run
 * states. Log streaming on any agent does not re-render the caller.
 */
export function useBackgroundAutoRuns(activeSessionId?: string): BackgroundAutoRun[] {
	const runningIds = useBatchStore(
		useShallow((s) =>
			Object.keys(s.batchRunStates).filter(
				(id) => id !== activeSessionId && s.batchRunStates[id].isRunning
			)
		)
	);
	const states = useBatchStore(useShallow((s) => runningIds.map((id) => s.batchRunStates[id])));
	const names = useSessionStore(
		useShallow((s) => runningIds.map((id) => s.sessions.find((session) => session.id === id)?.name))
	);

	return useMemo(
		() =>
			runningIds.flatMap((sessionId, i) =>
				// A run whose agent is gone has nowhere to jump to; leave it out.
				names[i] !== undefined && states[i]
					? [{ sessionId, sessionName: names[i]!, state: states[i] }]
					: []
			),
		[runningIds, names, states]
	);
}
