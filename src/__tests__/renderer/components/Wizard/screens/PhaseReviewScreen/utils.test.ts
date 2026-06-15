import { describe, expect, it, vi } from 'vitest';
import {
	buildPhaseReviewStatsText,
	buildWizardCompletionMetrics,
	countTasks,
} from '../../../../../../renderer/components/Wizard/screens/PhaseReviewScreen/utils/documentStats';

describe('PhaseReviewScreen utils', () => {
	it('counts markdown tasks and builds stats text', () => {
		expect(countTasks('- [ ] One\n- [x] Two\nNope')).toBe(2);
		expect(
			buildPhaseReviewStatsText(
				[
					{ filename: 'a.md', content: '- [ ] One', taskCount: 1 },
					{ filename: 'b.md', content: '- [ ] Two', taskCount: 1 },
				],
				'- [ ] One\n- [ ] Two'
			)
		).toBe('2 total tasks - 2 documents - 2 tasks in this document');
		expect(
			buildPhaseReviewStatsText([{ filename: 'a.md', content: '', taskCount: 0 }], '- [ ] One')
		).toBe('1 tasks ready to run');
	});

	it('builds wizard completion metrics', () => {
		vi.useFakeTimers();
		vi.setSystemTime(5000);
		expect(
			buildWizardCompletionMetrics({
				wizardStartTime: 1000,
				conversationHistory: [
					{ id: '1', role: 'user', content: 'Hi', timestamp: 1 },
					{ id: '2', role: 'assistant', content: 'Hello', timestamp: 2 },
				],
				generatedDocuments: [{ filename: 'a.md', content: '- [ ] One\n- [ ] Two', taskCount: 2 }],
			})
		).toEqual({
			durationMs: 4000,
			conversationExchanges: 1,
			phasesGenerated: 1,
			tasksGenerated: 2,
		});
		vi.useRealTimers();
	});
});
