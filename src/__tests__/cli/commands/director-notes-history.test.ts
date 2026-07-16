import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
	readSettings: vi.fn(),
	readSessions: vi.fn(),
	readHistory: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => storage);
vi.mock('../../../cli/output/formatter', () => ({
	formatError: (message: string) => `Error: ${message}`,
	formatDirectorNotesHistory: vi.fn(),
}));

import { directorNotesHistory } from '../../../cli/commands/director-notes-history';

describe('director-notes history command', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		storage.readSettings.mockReturnValue({ encoreFeatures: { directorNotes: true } });
		storage.readSessions.mockReturnValue([{ id: 'agent-1', name: 'Agent One' }]);
		storage.readHistory.mockReturnValue([
			{
				id: 'entry-1',
				type: 'AUTO',
				timestamp: 0,
				summary: 'Completed work',
				sessionId: 'agent-1',
				elapsedTimeMs: 86_400_000,
			},
			{
				id: 'entry-2',
				type: 'USER',
				timestamp: 1,
				summary: 'No duration',
				sessionId: 'agent-1',
				elapsedTimeMs: 0,
			},
		]);
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	it('preserves the markdown duration table output bytes', () => {
		directorNotesHistory({ format: 'markdown', days: '0' });

		const date = new Date(0).toLocaleString();
		const zeroDurationDate = new Date(1).toLocaleString();
		expect(console.log).toHaveBeenCalledWith(
			[
				"# Director's Notes - History",
				'',
				'**Period:** All time',
				'**Stats:** 1 agents, 2 entries (1 auto, 1 user, 0 cue)',
				'**Showing:** 2 of 2 entries',
				'',
				'| Date | Type | Agent | Summary | Cost | Duration |',
				'|------|------|-------|---------|------|----------|',
				`| ${zeroDurationDate} | USER | Agent One | No duration | - | - |`,
				`| ${date} | AUTO | Agent One | Completed work | - | 24.0h |`,
			].join('\n')
		);
	});
});
