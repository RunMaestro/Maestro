import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	readSettings: () => ({ encoreFeatures: { directorNotes: true } }),
	readSessions: () => [{ id: 'agent-a', name: 'Test Agent' }],
	readHistory: () =>
		(['USER', 'RELAY', 'RELAY'] as const).map((type, index) => ({
			id: `entry-${index}`,
			type,
			timestamp: index + 1,
			summary: 'Recorded turn',
			sessionId: 'agent-a',
		})),
}));

import { directorNotesHistory } from '../../../cli/commands/director-notes-history';

afterEach(() => vi.restoreAllMocks());

describe('Director Notes Relay history totals', () => {
	it.each(['json', 'text', 'markdown'] as const)(
		'counts Relay in unfiltered totals and the %s summary when rows are filtered',
		(format) => {
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			directorNotesHistory({ days: '0', filter: 'relay', format });
			const output = String(log.mock.calls[0]?.[0]);
			if (format === 'json') {
				expect(JSON.parse(output)).toMatchObject({
					stats: { agentCount: 1, userCount: 1, relayCount: 2, totalCount: 3 },
					total: 2,
					showing: 2,
				});
			} else {
				expect(output).toContain('2 relay');
				expect(output).toMatch(/Entries:\s+3|3 entries/);
			}
		}
	);
});
