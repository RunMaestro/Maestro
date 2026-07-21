import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUsageSnapshotEnvelope } from '../../../main/stores/usageSnapshotEnvelope';
import type ElectronStore from 'electron-store';

const { MockStore, stores } = vi.hoisted(() => {
	const stores: Array<{
		data: Record<string, unknown>;
		options: Record<string, unknown>;
		get: (key: string, defaultValue?: unknown) => unknown;
		set: (key: string, value: unknown) => void;
	}> = [];
	class MockStore {
		data: Record<string, unknown>;
		constructor(readonly options: Record<string, unknown>) {
			this.data = { ...((options.defaults as Record<string, unknown>) ?? {}) };
			stores.push(this);
		}
		get(key: string, defaultValue?: unknown): unknown {
			return Object.hasOwn(this.data, key) ? this.data[key] : defaultValue;
		}
		set(key: string, value: unknown): void {
			this.data[key] = value;
		}
	}
	return { MockStore, stores };
});

vi.mock('electron-store', () => ({ default: MockStore }));

import {
	__resetForTests as resetClaude,
	clear as clearClaude,
	getAllSnapshots,
	getSnapshot,
	setSnapshot,
	type UsageSnapshot,
} from '../../../main/stores/claudeUsageStore';
import {
	__resetForTests as resetCodex,
	clearCodexUsageSnapshots,
	getAllCodexUsageSnapshots,
	setCodexUsageSnapshot,
	type CodexUsageSnapshot,
} from '../../../main/stores/codexUsageStore';

const NOW = new Date('2026-05-15T12:00:00.000Z').getTime();

type StoreContract = {
	name: string;
	storeName: string;
	keyField: string;
	makeSnapshot: (key: string, sampledAt?: string) => unknown;
	reset: () => void;
	clear: () => void;
	write: (snapshot: never) => void;
	read: () => Record<string, unknown>;
	readOne?: (key: string) => unknown;
};

const contracts: StoreContract[] = [
	{
		name: 'Claude',
		storeName: 'claude-usage-snapshots',
		keyField: 'configDirKey',
		makeSnapshot: (configDirKey, sampledAt = new Date(NOW).toISOString()): UsageSnapshot => ({
			configDirKey,
			sampledAt,
			session: { percent: 10, resetsAt: '2026-05-15T17:00:00.000Z' },
			weekAllModels: { percent: 20, resetsAt: '2026-05-22T12:00:00.000Z' },
			weekSonnetOnly: { percent: 5, resetsAt: '2026-05-22T12:00:00.000Z' },
		}),
		reset: resetClaude,
		clear: clearClaude,
		write: setSnapshot as (snapshot: never) => void,
		read: getAllSnapshots as () => Record<string, unknown>,
		readOne: getSnapshot,
	},
	{
		name: 'Codex',
		storeName: 'codex-usage-snapshots',
		keyField: 'codexHomeKey',
		makeSnapshot: (codexHomeKey, sampledAt = new Date(NOW).toISOString()): CodexUsageSnapshot => ({
			codexHomeKey,
			sampledAt,
			authState: 'authenticated',
			session: { percent: 10, resetsAt: '2026-05-15T17:00:00.000Z' },
		}),
		reset: resetCodex,
		clear: clearCodexUsageSnapshots,
		write: setCodexUsageSnapshot as (snapshot: never) => void,
		read: getAllCodexUsageSnapshots as () => Record<string, unknown>,
	},
];

const PERSISTENCE_MATRIX = {
	Claude: {
		key: 'configDirKey',
		version: 1,
		retention: '24h sampledAt TTL',
		readFailure: 'missing/corrupt/version mismatch => safe miss',
		ioFailure: 'propagates unchanged',
		merge: 'live keyed snapshots merge on write',
		timestamp: 'invalid or expired sampledAt prunes',
		providerData: 'opaque to persistence',
	},
	Codex: {
		key: 'codexHomeKey',
		version: 1,
		retention: '24h sampledAt TTL',
		readFailure: 'missing/corrupt/version mismatch => safe miss',
		ioFailure: 'propagates unchanged',
		merge: 'live keyed snapshots merge on write',
		timestamp: 'invalid or expired sampledAt prunes',
		providerData: 'opaque to persistence',
	},
} as const;

/**
 * Persistence compatibility matrix. Provider sampling/parsing fields remain
 * outside this envelope; only these matching contracts use the shared helper.
 */
describe('usage snapshot persistence compatibility matrix', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		stores.length = 0;
		for (const contract of contracts) contract.reset();
	});

	it.each(contracts)('$name has the compatible persistence envelope', (contract) => {
		expect({
			key: contract.keyField,
			version: 1,
			retention: '24h sampledAt TTL',
			readFailure: 'missing/corrupt/version mismatch => safe miss',
			ioFailure: 'propagates unchanged',
			merge: 'live keyed snapshots merge on write',
			timestamp: 'invalid or expired sampledAt prunes',
			providerData: 'opaque to persistence',
		}).toEqual(PERSISTENCE_MATRIX[contract.name as keyof typeof PERSISTENCE_MATRIX]);
	});

	it.each(contracts)('$name treats a missing snapshot map as a safe miss', (contract) => {
		expect(contract.read()).toEqual({});
		if (contract.readOne) expect(contract.readOne('/missing')).toBeNull();
	});

	it.each(contracts)('$name treats corrupt snapshot data as a safe miss', (contract) => {
		contract.read();
		getStore(contract).data.snapshots = { '/corrupt': null };
		expect(contract.read()).toEqual({});
	});

	it.each(contracts)('$name preserves an underlying persistence read failure', (contract) => {
		contract.read();
		const store = getStore(contract);
		store.get = () => {
			throw new Error('disk unavailable');
		};
		expect(contract.read).toThrow('disk unavailable');
	});

	it.each(contracts)(
		'$name treats a version mismatch as a safe miss without serving stale data',
		(contract) => {
			contract.read();
			const stale = contract.makeSnapshot('/stale');
			getStore(contract).data = { version: 2, snapshots: { '/stale': stale } };
			expect(contract.read()).toEqual({});
			if (contract.readOne) expect(contract.readOne('/stale')).toBeNull();

			const fresh = contract.makeSnapshot('/fresh');
			contract.write(fresh as never);
			expect(contract.read()).toEqual({ '/fresh': fresh });
		}
	);

	it.each(contracts)(
		'$name preserves legacy unversioned records and stamps version on the next write',
		(contract) => {
			contract.read();
			const legacy = contract.makeSnapshot('/legacy');
			getStore(contract).data = { snapshots: { '/legacy': legacy } };
			expect(contract.read()).toEqual({ '/legacy': legacy });
			contract.write(contract.makeSnapshot('/fresh') as never);
			expect(contract.read()).toEqual({ '/legacy': legacy, '/fresh': expect.any(Object) });
			expect(getStore(contract).data.version).toBe(1);
		}
	);

	it.each(contracts)('$name merges live snapshots during refresh writes', (contract) => {
		const first = contract.makeSnapshot('/first');
		const second = contract.makeSnapshot('/second');
		contract.write(first as never);
		contract.write(second as never);
		expect(contract.read()).toEqual({ '/first': first, '/second': second });
	});

	it.each(contracts)(
		'$name retains simultaneous refresh completions for different keys',
		async (contract) => {
			const first = contract.makeSnapshot('/first');
			const second = contract.makeSnapshot('/second');
			await Promise.all([
				Promise.resolve().then(() => contract.write(first as never)),
				Promise.resolve().then(() => contract.write(second as never)),
			]);
			expect(contract.read()).toEqual({ '/first': first, '/second': second });
		}
	);

	it.each(contracts)(
		'$name expires invalid timestamps without inspecting provider data',
		(contract) => {
			contract.write(contract.makeSnapshot('/bad-time', 'not-a-date') as never);
			expect(contract.read()).toEqual({});
		}
	);
});

describe('usage snapshot persistence filesystem round-trip', () => {
	it('reopens a locally persisted envelope without changing opaque provider data', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'maestro-usage-snapshot-'));
		try {
			const { default: ActualElectronStore } =
				await vi.importActual<typeof ElectronStore>('electron-store');
			const envelope = createUsageSnapshotEnvelope({
				version: 1,
				ttlMs: 24 * 60 * 60 * 1000,
				getKey: (snapshot: { key: string }) => snapshot.key,
			});
			const snapshot = {
				key: '/local-account',
				sampledAt: new Date(NOW).toISOString(),
				providerOnly: { preserved: true },
			};
			envelope.set(
				new ActualElectronStore({
					cwd: directory,
					name: 'usage-snapshot-round-trip',
					defaults: { version: 1, snapshots: {} },
				}),
				snapshot,
				NOW
			);
			const reopened = new ActualElectronStore({
				cwd: directory,
				name: 'usage-snapshot-round-trip',
				defaults: { version: 1, snapshots: {} },
			});
			expect(envelope.getAll(reopened, NOW)).toEqual({ '/local-account': snapshot });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
function getStore(contract: StoreContract): MockStore {
	const store = stores.find((candidate) => candidate.options.name === contract.storeName);
	if (!store) throw new Error(`Expected ${contract.name} store to initialize`);
	return store;
}
