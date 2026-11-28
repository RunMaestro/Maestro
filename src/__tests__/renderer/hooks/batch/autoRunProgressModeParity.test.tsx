/**
 * Parity round 5, P4: the Auto Run progress card reads the same in every mode while a run works.
 * A local and an SSH run are driven by this window (`useBatchRunner` starts the run state and its
 * time tracker); a hosted run is drawn from the host's frames (`buildMirroredBatchState()`), with
 * the start time and the pre-checked baseline the host sends. ELAPSED counts in all three, and
 * REMAINING says the same thing. The end of the run raises the same "Auto-Run Complete" toast.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AutoRunProgressStats } from '../../../../renderer/components/AutoRun/AutoRunProgressStats';
import { buildMirroredBatchState } from '../../../../renderer/hooks/batch/useAutoRunStateMirror';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import { autoRunActiveElapsedMs } from '../../../../renderer/hooks/batch/useTimeTracking';
import { mirroredRunCompleteInfo } from '../../../../renderer/services/autoRunCompletion';
import {
	parseAutoRunBroadcastState,
	type AutoRunBroadcastState,
} from '../../../../shared/autoRunBroadcast';
import { parseAutoRunProgress } from '../../../../shared/maestro-lib/autorun/progress';
import { progressToWire } from '../../../../shared/maestro-lib/runtime/server-frames';
import type { BatchRunState } from '../../../../renderer/types';
import { AGENT_MODES, type AgentMode } from '../../../helpers';
import { mockTheme } from '../../../helpers/mockTheme';

const START = Date.UTC(2026, 10, 26, 12, 0, 0);
const NOW = START + 95_000;

/** One document of six tasks, two checked before the run, one checked by it so far. */
const RUN = { total: 6, preChecked: 2, doneNow: 3 };

/** A run this window drives, as `useBatchRunner` starts it and its tracker keeps it. */
function localRun(): BatchRunState {
	return {
		...DEFAULT_BATCH_STATE,
		isRunning: true,
		documents: ['phase-1'],
		totalTasksAcrossAllDocs: RUN.total,
		completedTasksAcrossAllDocs: RUN.doneNow,
		initialCompletedTasks: RUN.preChecked,
		totalTasks: RUN.total,
		completedTasks: RUN.doneNow - RUN.preChecked,
		startTime: START,
		accumulatedElapsedMs: 0,
		lastActiveTimestamp: START,
	};
}

/** The same run as its host's frame says it (a headless or a desktop host). */
function hostFrame(): AutoRunBroadcastState {
	return {
		isRunning: true,
		documents: ['phase-1'],
		totalTasks: RUN.total,
		completedTasks: RUN.doneNow - RUN.preChecked,
		currentTaskIndex: RUN.doneNow,
		totalTasksAcrossAllDocs: RUN.total,
		completedTasksAcrossAllDocs: RUN.doneNow,
		initialCompletedTasks: RUN.preChecked,
		startTime: START,
	};
}

/**
 * A host's run state as the desktop receives it: the host publishes it as `AutoRunProgress`
 * (`publish()` in runtime/autorun.ts), its server writes the `autorun_state` frame
 * (`progressToWire()`), and the client reads the frame off the socket.
 */
function overTheWire(state: AutoRunBroadcastState): AutoRunBroadcastState {
	const progress = parseAutoRunProgress(state);
	if (!progress) throw new Error('no progress');
	const received = parseAutoRunBroadcastState(JSON.parse(JSON.stringify(progressToWire(progress))));
	if (!received) throw new Error('no frame');
	return received;
}

function runState(mode: AgentMode): BatchRunState {
	if (mode !== 'hosted') return localRun();
	// Two frames, as a run sends them: the second is built on the first mirror.
	const first = buildMirroredBatchState(
		overTheWire({ ...hostFrame(), completedTasksAcrossAllDocs: 2 })
	);
	return buildMirroredBatchState(overTheWire(hostFrame()), first);
}

/** The card's ELAPSED and REMAINING cells, as RightPanel feeds it. */
function cardText(mode: AgentMode): string {
	const state = runState(mode);
	const { container, unmount } = render(
		<AutoRunProgressStats
			theme={mockTheme}
			batchState={state}
			elapsedMs={autoRunActiveElapsedMs(state, NOW)}
			halted={false}
			errorPaused={false}
		/>
	);
	const text = container.textContent ?? '';
	unmount();
	return text;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('the Auto Run progress card, in every mode', () => {
	it.each(AGENT_MODES)('%s: ELAPSED counts and REMAINING waits for more tasks', (mode) => {
		render(
			<AutoRunProgressStats
				theme={mockTheme}
				batchState={runState(mode)}
				elapsedMs={autoRunActiveElapsedMs(runState(mode), NOW)}
				halted={false}
				errorPaused={false}
			/>
		);
		expect(screen.queryByText('not available')).toBeNull();
		expect(screen.getByText('after 2 more tasks')).not.toBeNull();
		expect(screen.queryByText('0s')).toBeNull();
		expect(autoRunActiveElapsedMs(runState(mode), NOW)).toBe(95_000);
	});

	it('draws the same card in all three modes', () => {
		const [local, ssh, hosted] = AGENT_MODES.map(cardText);
		expect(ssh).toBe(local);
		expect(hosted).toBe(local);
	});

	it('gives the end toast the counts a local run reports', () => {
		// A local run reports the tasks it did over the run's total (pre-checked tasks included).
		expect(mirroredRunCompleteInfo('row', 'Docs', runState('hosted'), NOW)).toEqual({
			sessionId: 'row',
			sessionName: 'Docs',
			completedTasks: RUN.doneNow - RUN.preChecked,
			totalTasks: RUN.total,
			wasStopped: false,
			elapsedTimeMs: 95_000,
		});
		const goal = buildMirroredBatchState({
			...hostFrame(),
			goalMode: true,
			goalProgress: 100,
			isStopping: true,
		});
		expect(mirroredRunCompleteInfo('row', 'Docs', goal, NOW)).toMatchObject({
			completedTasks: 100,
			totalTasks: 100,
			wasStopped: true,
		});
	});
});
