import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	migrateClaudeSessionNamesFromHistory,
	CLAUDE_SESSION_NAMES_BACKFILL_MARKER,
} from '../../../../main/stores/migrations/claude-session-names-backfill';

/** Minimal in-memory electron-store double backed by a plain record. */
function makeStore(initial: Record<string, any> = {}) {
	const data: Record<string, any> = { ...initial };
	return {
		data,
		get: vi.fn((key: string, fallback?: any) => (key in data ? data[key] : fallback)),
		set: vi.fn((key: string, value: any) => {
			data[key] = value;
		}),
	};
}

function makeHistory(bySession: Record<string, Array<Record<string, unknown>>>) {
	return {
		listSessionsWithHistory: vi.fn(async () => Object.keys(bySession)),
		getEntries: vi.fn(async (sessionId: string) => bySession[sessionId] ?? []),
	};
}

describe('migrateClaudeSessionNamesFromHistory', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('restores lost names from every agent history file and sets the marker', async () => {
		const settings = makeStore();
		const origins = makeStore({ origins: { '/vault': { 'sess-1': 'user' } } });
		const history = makeHistory({
			agentA: [{ agentSessionId: 'sess-1', sessionName: 'TypeSafe.ai JEV Skill', timestamp: 5 }],
			agentB: [],
		});

		await migrateClaudeSessionNamesFromHistory(settings as any, origins as any, history as any);

		expect(origins.data.origins).toEqual({
			'/vault': { 'sess-1': { origin: 'user', sessionName: 'TypeSafe.ai JEV Skill' } },
		});
		expect(settings.data[CLAUDE_SESSION_NAMES_BACKFILL_MARKER]).toBe(true);
	});

	it('does nothing once the marker is set', async () => {
		const settings = makeStore({ [CLAUDE_SESSION_NAMES_BACKFILL_MARKER]: true });
		const origins = makeStore({ origins: { '/vault': { 'sess-1': 'user' } } });
		const history = makeHistory({
			agentA: [{ agentSessionId: 'sess-1', sessionName: 'Named', timestamp: 5 }],
		});

		await migrateClaudeSessionNamesFromHistory(settings as any, origins as any, history as any);

		expect(history.listSessionsWithHistory).not.toHaveBeenCalled();
		expect(origins.set).not.toHaveBeenCalled();
	});
});
