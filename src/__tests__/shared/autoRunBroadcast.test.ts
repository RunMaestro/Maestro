/**
 * Tests for `parseAutoRunBroadcastState()`: an `autorun_state` frame from another machine is read
 * field by field, so a frame from an older or damaged host draws less detail instead of crashing.
 */

import { describe, expect, it } from 'vitest';
import { parseAutoRunBroadcastState } from '../../shared/autoRunBroadcast';

describe('parseAutoRunBroadcastState', () => {
	it('answers null for a cleared state or a payload that is not an object', () => {
		expect(parseAutoRunBroadcastState(null)).toBeNull();
		expect(parseAutoRunBroadcastState('running')).toBeNull();
		expect(parseAutoRunBroadcastState([{ isRunning: true }])).toBeNull();
	});

	it('keeps every field of the right type', () => {
		const frame = {
			isRunning: true,
			totalTasks: 4,
			completedTasks: 1,
			currentTaskIndex: 1,
			isStopping: false,
			currentDocumentIndex: 0,
			totalTasksAcrossAllDocs: 6,
			completedTasksAcrossAllDocs: 2,
			errorPaused: true,
			errorMessage: 'Rate limited',
			errorType: 'rate_limited',
			errorRecoverable: true,
			errorDocumentIndex: 0,
			errorTaskDescription: 'Write the tests',
			goalMode: true,
			goalProgress: 40,
			goalRationale: 'halfway',
			goalIteration: 2,
			pendingDelegations: [
				{
					callbackId: 'c1',
					targetAgentId: 'a2',
					targetTabId: 't2',
					targetName: 'Docs',
					subject: 'Write the page',
					startedAt: 5,
				},
			],
			documents: ['phase-1'],
			lockedDocuments: ['phase-1'],
			currentDocTasksTotal: 4,
			currentDocTasksCompleted: 1,
			worktreeActive: true,
			worktreeBranch: 'feat/x',
			startTime: 10,
			loopEnabled: true,
			loopIteration: 1,
			initialCompletedTasks: 0,
		};
		expect(parseAutoRunBroadcastState(frame)).toEqual(frame);
	});

	it('drops a field of the wrong type and fills the required counts', () => {
		expect(
			parseAutoRunBroadcastState({
				isRunning: 'yes',
				totalTasks: '4',
				documents: ['a', 3, null],
				startTime: Number.NaN,
				errorMessage: '',
				pendingDelegations: [{ callbackId: 'c1' }, 'x'],
			})
		).toEqual({
			isRunning: false,
			totalTasks: 0,
			completedTasks: 0,
			currentTaskIndex: 0,
			documents: ['a'],
			pendingDelegations: [],
		});
	});
});
