import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/stores/getters', () => ({
	getSessionsStore: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	migratePrimaryAgentSeed,
	PRIMARY_AGENT_SEED_MIGRATION_MARKER,
} from '../../../../main/stores/migrations/primary-agent-seed';
import { getSessionsStore } from '../../../../main/stores/getters';

const mockedGetSessionsStore = vi.mocked(getSessionsStore);

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

function withAgents(ids: string[]) {
	mockedGetSessionsStore.mockReturnValue(
		makeStore({ sessions: ids.map((id) => ({ id, name: id, toolType: 'claude-code' })) }) as any
	);
}

describe('migratePrimaryAgentSeed', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('seeds the Primary Agent from the Quick Chat agent and leaves Quick Chat alone', () => {
		withAgents(['a', 'b']);
		const quickChatSettings = { agentId: 'b', hotkey: [] };
		const store = makeStore({ quickChatSettings });

		migratePrimaryAgentSeed(store as any);

		expect(store.data.primaryAgentId).toBe('b');
		expect(store.data.quickChatSettings).toBe(quickChatSettings);
		expect(store.data[PRIMARY_AGENT_SEED_MIGRATION_MARKER]).toBe(true);
	});

	it('never replaces a Primary Agent that is already set', () => {
		withAgents(['a', 'b']);
		const store = makeStore({ primaryAgentId: 'a', quickChatSettings: { agentId: 'b' } });

		migratePrimaryAgentSeed(store as any);

		expect(store.data.primaryAgentId).toBe('a');
		expect(store.data[PRIMARY_AGENT_SEED_MIGRATION_MARKER]).toBe(true);
	});

	it('seeds nothing when the Quick Chat agent is unset or names a removed agent', () => {
		withAgents(['a']);
		const unset = makeStore({ quickChatSettings: { agentId: '' } });
		const removed = makeStore({ quickChatSettings: { agentId: 'gone' } });

		migratePrimaryAgentSeed(unset as any);
		migratePrimaryAgentSeed(removed as any);

		expect(unset.data.primaryAgentId).toBeUndefined();
		expect(removed.data.primaryAgentId).toBeUndefined();
		expect(removed.data[PRIMARY_AGENT_SEED_MIGRATION_MARKER]).toBe(true);
	});

	it('runs once: a Primary Agent the user cleared is not seeded again', () => {
		withAgents(['a']);
		const store = makeStore({
			primaryAgentId: null,
			quickChatSettings: { agentId: 'a' },
			[PRIMARY_AGENT_SEED_MIGRATION_MARKER]: true,
		});

		migratePrimaryAgentSeed(store as any);

		expect(store.data.primaryAgentId).toBeNull();
		expect(mockedGetSessionsStore).not.toHaveBeenCalled();
	});
});
