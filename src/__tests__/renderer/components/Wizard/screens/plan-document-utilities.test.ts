// Source: src/__tests__/renderer/components/Wizard/screens/PreparingPlanScreen/utils.test.ts
// Source: src/__tests__/renderer/components/Wizard/screens/PhaseReviewScreen/utils.test.ts
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { getFactPlainText } from '../../../../../renderer/components/Wizard/screens/PreparingPlanScreen/utils/austinFacts';
import { countCreatedFileTasks } from '../../../../../renderer/components/Wizard/screens/PreparingPlanScreen/utils/createdFiles';
import { upsertCreatedFile } from '../../../../../renderer/components/Wizard/screens/PreparingPlanScreen/utils/createdFiles';
import { vi } from 'vitest';
import { buildPhaseReviewStatsText } from '../../../../../renderer/components/Wizard/screens/PhaseReviewScreen/utils/documentStats';
import { buildWizardCompletionMetrics } from '../../../../../renderer/components/Wizard/screens/PhaseReviewScreen/utils/documentStats';
import { countTasks } from '../../../../../renderer/components/Wizard/screens/PhaseReviewScreen/utils/documentStats';
describe('PreparingPlanScreen.utils', () => {
	describe('PreparingPlanScreen utils', () => {
		it('removes markdown link URLs from Austin facts', () => {
			expect(getFactPlainText('Visit [Austin](https://example.com) today')).toBe(
				'Visit Austin today'
			);
		});

		it('upserts created files by filename and counts tasks', () => {
			const files = upsertCreatedFile([], {
				filename: 'Phase-01.md',
				path: '/project/Phase-01.md',
				size: 10,
				taskCount: 2,
			});
			const updated = upsertCreatedFile(files, {
				filename: 'Phase-01.md',
				path: '/project/Phase-01.md',
				size: 20,
				taskCount: 3,
			});

			expect(updated).toHaveLength(1);
			expect(updated[0].size).toBe(20);
			expect(countCreatedFileTasks(updated)).toBe(3);
		});
	});
});
describe('PhaseReviewScreen.utils', () => {
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
});
