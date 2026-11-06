import type { Board } from '../../shared/board/types';

/** Loaded board runs are observations, not a global reservation source. */
export function observedWorkerRuns(boards: Board[]): Map<string, string> {
	const observed = new Map<string, string>();
	for (const board of boards) {
		for (const card of board.cards) {
			const run = card.runs?.[card.runs.length - 1];
			if (
				card.status === 'running' &&
				typeof run?.workerAgentId === 'string' &&
				!run.endedAt &&
				!observed.has(run.workerAgentId)
			) {
				observed.set(run.workerAgentId, card.title);
			}
		}
	}
	return observed;
}
