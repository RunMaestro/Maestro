import { describe, expect, it } from 'vitest';

import { groupChatAutoRunSummary } from '../autorun-summary';

describe('groupChatAutoRunSummary', () => {
	it('says how many tasks a finished run completed', () => {
		expect(
			groupChatAutoRunSummary({
				wasStopped: false,
				completedTasks: 4,
				totalTasks: 4,
				documentsProcessed: 2,
			})
		).toBe('Auto Run complete: 4/4 tasks finished across 2 document(s).');
	});

	it('says a stopped run was stopped, and how far it got', () => {
		expect(
			groupChatAutoRunSummary({
				wasStopped: true,
				completedTasks: 1,
				totalTasks: 4,
				documentsProcessed: 1,
			})
		).toBe('Auto Run stopped: completed 1 of 4 tasks across 1 document(s).');
	});
});
