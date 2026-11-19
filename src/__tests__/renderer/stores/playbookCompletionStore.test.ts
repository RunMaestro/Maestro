/**
 * playbookCompletionStore: finished runs' reports wait first in, first out,
 * and the queue opens and closes the `playbookReport` modal.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useModalStore } from '../../../renderer/stores/modalStore';
import {
	selectCurrentPlaybookCompletion,
	selectPlaybookCompletionCount,
	usePlaybookCompletionStore,
} from '../../../renderer/stores/playbookCompletionStore';
import { buildFinalSummaryFacts, type PlaybookRunReport } from '../../../shared/playbookRunReport';

function report(playbookName: string): PlaybookRunReport {
	return {
		playbookName,
		status: 'completed',
		facts: buildFinalSummaryFacts({
			wasStopped: false,
			totalCompletedTasks: 1,
			totalElapsedMs: 1_000,
			stalledDocuments: new Map(),
			documents: [{ filename: 'doc' }],
			loopEnabled: false,
			loopIteration: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCost: 0,
		}),
		parameters: [],
		startedAt: 0,
		finishedAt: 1_000,
	};
}

const store = () => usePlaybookCompletionStore.getState();
const modalOpen = () => useModalStore.getState().modals.get('playbookReport')?.open ?? false;
const currentName = () => selectCurrentPlaybookCompletion(store())?.report.playbookName;

describe('playbookCompletionStore', () => {
	beforeEach(() => {
		store().clear();
	});

	it('starts empty with nothing on screen', () => {
		expect(selectCurrentPlaybookCompletion(store())).toBeNull();
		expect(selectPlaybookCompletionCount(store())).toBe(0);
		expect(modalOpen()).toBe(false);
	});

	it('shows the oldest report first and the next one on each dismissal', () => {
		store().enqueue('agent-1', report('First'));
		store().enqueue('agent-2', report('Second'));
		store().enqueue('agent-1', report('Third'));

		expect(selectPlaybookCompletionCount(store())).toBe(3);
		expect(currentName()).toBe('First');
		expect(selectCurrentPlaybookCompletion(store())?.sessionId).toBe('agent-1');

		store().dismissCurrent();
		expect(currentName()).toBe('Second');
		store().dismissCurrent();
		expect(currentName()).toBe('Third');
		store().dismissCurrent();
		expect(selectCurrentPlaybookCompletion(store())).toBeNull();
	});

	it('gives every entry its own id, even for the same report', () => {
		const same = report('Same');
		store().enqueue('agent-1', same);
		store().enqueue('agent-1', same);
		const [a, b] = store().queue;
		expect(a.id).not.toBe(b.id);
	});

	it('opens the modal on the first report and closes it after the last', () => {
		store().enqueue('agent-1', report('First'));
		expect(modalOpen()).toBe(true);
		store().enqueue('agent-1', report('Second'));

		store().dismissCurrent();
		expect(modalOpen()).toBe(true);
		store().dismissCurrent();
		expect(modalOpen()).toBe(false);
	});

	it('dismissing an empty queue is harmless', () => {
		store().dismissCurrent();
		expect(store().queue).toEqual([]);
		expect(modalOpen()).toBe(false);
	});

	it('clear drops every waiting report and closes the modal', () => {
		store().enqueue('agent-1', report('First'));
		store().enqueue('agent-1', report('Second'));
		store().clear();
		expect(store().queue).toEqual([]);
		expect(modalOpen()).toBe(false);
	});
});
