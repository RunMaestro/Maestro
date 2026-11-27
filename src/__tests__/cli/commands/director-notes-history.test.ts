/**
 * `maestro-cli director-notes history --search` runs the same matcher as the
 * Director's Notes search box, over the whole lookback window, before --limit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HistoryEntry } from '../../../shared/types';

const mockReadHistory = vi.fn<() => HistoryEntry[]>();

vi.mock('../../../cli/services/storage', () => ({
	readSessions: () => [{ id: 'agent-1', name: 'Proxmox' }],
	readHistory: () => mockReadHistory(),
	readSettings: () => ({
		encoreFeatures: { directorNotes: true },
		directorNotesSettings: { defaultLookbackDays: 7 },
	}),
}));

import { directorNotesHistory } from '../../../cli/commands/director-notes-history';

const entry = (overrides: Partial<HistoryEntry>): HistoryEntry => ({
	id: 'e',
	type: 'USER',
	sessionId: 'agent-1',
	projectPath: '/p',
	timestamp: Date.now() - 1000,
	summary: 'Heartbeat',
	...overrides,
});

describe('director-notes history --search', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		mockReadHistory.mockReset();
	});

	const runJson = (search?: string, limit?: string) => {
		directorNotesHistory({ json: true, search, limit });
		return JSON.parse(String(logSpy.mock.calls[0][0]));
	};

	it('keeps only matches, including a hit on the tab name, before applying --limit', () => {
		mockReadHistory.mockReturnValue([
			...Array.from({ length: 5 }, (_, i) => entry({ id: `noise-${i}` })),
			entry({ id: 'tab-hit', sessionName: 'Banaco Persona Desktop Setup Check' }),
			entry({ id: 'response-hit', fullResponse: 'The PERSONAS seat desktop' }),
		]);

		const out = runJson('persona', '1');

		expect(out.total).toBe(2);
		expect(out.entries.map((e: { id: string }) => e.id)).toHaveLength(1);
		// Stats describe the window, not the search.
		expect(out.stats.totalCount).toBe(7);
	});

	it('returns everything when no search is given', () => {
		mockReadHistory.mockReturnValue([entry({ id: 'a' }), entry({ id: 'b' })]);

		expect(runJson().total).toBe(2);
	});
});
