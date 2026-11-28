import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	migrateFederationHostingDefaultOff,
	FEDERATION_HOSTING_DEFAULT_OFF_MIGRATION_MARKER,
} from '../../../../main/stores/migrations/federation-hosting-default-off';

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

describe('migrateFederationHostingDefaultOff', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('turns both switches off when the old `true` defaults were persisted', () => {
		const store = makeStore({ federationHostedAgents: true, federationAutoMove: true });

		migrateFederationHostingDefaultOff(store as any);

		expect(store.data.federationHostedAgents).toBe(false);
		expect(store.data.federationAutoMove).toBe(false);
		expect(store.data[FEDERATION_HOSTING_DEFAULT_OFF_MIGRATION_MARKER]).toBe(true);
	});

	it('writes both off and the marker on an install that never stored them', () => {
		const store = makeStore();

		migrateFederationHostingDefaultOff(store as any);

		expect(store.data.federationHostedAgents).toBe(false);
		expect(store.data.federationAutoMove).toBe(false);
		expect(store.data[FEDERATION_HOSTING_DEFAULT_OFF_MIGRATION_MARKER]).toBe(true);
	});

	it('never runs again once the marker is set, so a later opt-in survives', () => {
		const store = makeStore({
			[FEDERATION_HOSTING_DEFAULT_OFF_MIGRATION_MARKER]: true,
			federationHostedAgents: true,
			federationAutoMove: true,
		});

		migrateFederationHostingDefaultOff(store as any);

		expect(store.set).not.toHaveBeenCalled();
		expect(store.data.federationHostedAgents).toBe(true);
		expect(store.data.federationAutoMove).toBe(true);
	});

	it('writes only the two settings and its marker (agent records and the host stay untouched)', () => {
		const sessions = [{ id: 'a', liftedTo: { peer: 'tome', agentId: 'k1', at: 1 } }];
		const store = makeStore({ federationHostedAgents: true, federationAutoMove: true, sessions });

		migrateFederationHostingDefaultOff(store as any);

		expect(store.set.mock.calls.map(([key]) => key).sort()).toEqual(
			[
				'federationAutoMove',
				'federationHostedAgents',
				FEDERATION_HOSTING_DEFAULT_OFF_MIGRATION_MARKER,
			].sort()
		);
		expect(store.data.sessions).toBe(sessions);
	});
});
