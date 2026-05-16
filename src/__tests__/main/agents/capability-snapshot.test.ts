import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CapabilitySnapshotManager } from '../../../main/agents/capability-snapshot';
import type {
	AgentCapabilitiesSnapshotMap,
	SnapshotUpdatedPayload,
} from '../../../shared/agentCapabilities';

/**
 * Minimal in-memory stand-in for the agent-capabilities electron-store.
 * Mirrors the `SnapshotStoreLike` shape so the manager can persist without
 * touching disk during tests.
 */
function makeFakeStore(initial: AgentCapabilitiesSnapshotMap = {}) {
	const data: { snapshots: AgentCapabilitiesSnapshotMap } = { snapshots: { ...initial } };
	return {
		raw: data,
		get: vi.fn(<K extends 'snapshots'>(key: K, defaultValue?: AgentCapabilitiesSnapshotMap) => {
			return data[key] ?? (defaultValue as AgentCapabilitiesSnapshotMap);
		}),
		set: vi.fn(<K extends 'snapshots'>(key: K, value: AgentCapabilitiesSnapshotMap) => {
			data[key] = value;
		}),
	};
}

// Silence Sentry calls — captureMessage is fire-and-forget so the implementation
// just `void`-awaits it. Vitest will still log unhandled promise rejections
// otherwise (the real impl tries to use `electron.app` which is unavailable here).
vi.mock('../../../main/utils/sentry', () => ({
	captureMessage: vi.fn(),
	captureException: vi.fn(),
}));

describe('CapabilitySnapshotManager', () => {
	let manager: CapabilitySnapshotManager;
	let store: ReturnType<typeof makeFakeStore>;
	let broadcast: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		manager = new CapabilitySnapshotManager();
		store = makeFakeStore();
		broadcast = vi.fn();
	});

	it('starts empty before init()', () => {
		expect(manager.getAll()).toEqual({});
		expect(manager.get('claude-code')).toBeUndefined();
	});

	it('hydrates from the persisted store on init()', () => {
		const seeded = makeFakeStore({
			'claude-code': {
				status: 'ok',
				path: '/usr/local/bin/claude',
				lastProbedAt: 1000,
			},
		});
		manager.init(seeded);
		expect(manager.get('claude-code')?.status).toBe('ok');
		expect(manager.get('claude-code')?.path).toBe('/usr/local/bin/claude');
	});

	it('markOk persists and broadcasts an update', () => {
		manager.init(store, broadcast);
		const result = manager.markOk('claude-code', { path: '/usr/bin/claude' });

		expect(result.status).toBe('ok');
		expect(result.path).toBe('/usr/bin/claude');
		expect(result.lastProbedAt).toBeGreaterThan(0);

		expect(store.set).toHaveBeenCalledWith('snapshots', expect.any(Object));
		expect(store.raw.snapshots['claude-code']?.status).toBe('ok');

		expect(broadcast).toHaveBeenCalledTimes(1);
		const payload = broadcast.mock.calls[0][0] as SnapshotUpdatedPayload;
		expect(payload.key).toBe('claude-code');
		expect(payload.agentId).toBe('claude-code');
		expect(payload.snapshot?.status).toBe('ok');
	});

	it('markNotInstalled wipes stale path/version/models from a previous ok snapshot', () => {
		manager.init(store, broadcast);
		manager.markOk('claude-code', {
			path: '/usr/bin/claude',
			version: '1.4.2',
			models: ['sonnet'],
		});
		const result = manager.markNotInstalled('claude-code');

		expect(result.status).toBe('not_installed');
		expect(result.lastError).toBeUndefined();
		// The previous binary path must NOT survive — otherwise the UI shows a
		// red "Not installed" pill alongside a valid-looking path. Same for
		// version / models, which would all be stale.
		expect(result.path).toBeUndefined();
		expect(result.version).toBeUndefined();
		expect(result.models).toBeUndefined();
		expect(broadcast).toHaveBeenCalledTimes(2);
	});

	it('markAuthRequired keeps the path and records an error message', () => {
		manager.init(store, broadcast);
		manager.markOk('claude-code', { path: '/usr/bin/claude' });
		const result = manager.markAuthRequired('claude-code', 'Token expired');

		expect(result.status).toBe('auth_required');
		expect(result.lastError).toBe('Token expired');
		expect(result.path).toBe('/usr/bin/claude');
	});

	it('SSH snapshots are keyed independently of the local snapshot', () => {
		manager.init(store, broadcast);
		manager.markOk('claude-code', { path: '/usr/local/bin/claude' });
		manager.markOk('claude-code', { path: '/home/dev/.local/bin/claude' }, 'remote-uuid-1');

		expect(manager.get('claude-code')?.path).toBe('/usr/local/bin/claude');
		expect(manager.get('claude-code', 'remote-uuid-1')?.path).toBe('/home/dev/.local/bin/claude');
		expect(manager.get('claude-code', 'remote-uuid-1')?.remoteId).toBe('remote-uuid-1');
	});

	it('clear() removes the snapshot and emits a null payload', () => {
		manager.init(store, broadcast);
		manager.markOk('claude-code', { path: '/usr/bin/claude' });
		manager.clear('claude-code');

		expect(manager.get('claude-code')).toBeUndefined();
		const lastCall = broadcast.mock.calls.at(-1)?.[0] as SnapshotUpdatedPayload;
		expect(lastCall.snapshot).toBeNull();
		expect(lastCall.key).toBe('claude-code');
	});

	it('clear() on a missing key is a no-op (no broadcast, no persist)', () => {
		manager.init(store, broadcast);
		store.set.mockClear();
		manager.clear('not-an-agent');
		expect(broadcast).not.toHaveBeenCalled();
		expect(store.set).not.toHaveBeenCalled();
	});

	it('markProbing is transient: in-memory only, not persisted to disk', () => {
		manager.init(store, broadcast);
		store.set.mockClear();
		const result = manager.markProbing('claude-code');

		expect(result.status).toBe('probing');
		expect(manager.get('claude-code')?.status).toBe('probing');
		// Broadcast still fires so the UI can show a spinner live…
		expect(broadcast).toHaveBeenCalledTimes(1);
		// …but persist must NOT happen: a crash during reprobe would otherwise
		// hydrate a stuck "Probing…" pill on next launch.
		expect(store.set).not.toHaveBeenCalled();
	});

	it('hydrate() drops any persisted `probing` entries left over from a prior crash', () => {
		const seeded = makeFakeStore({
			'claude-code': { status: 'ok', path: '/usr/bin/claude', lastProbedAt: 1000 },
			codex: { status: 'probing', lastProbedAt: 2000 },
		});
		manager.init(seeded);
		expect(manager.get('claude-code')?.status).toBe('ok');
		expect(manager.get('codex')).toBeUndefined();
	});

	it('markFailed records the error and keeps the snapshot', () => {
		manager.init(store, broadcast);
		const result = manager.markFailed('claude-code', 'boom');
		expect(result.status).toBe('failed');
		expect(result.lastError).toBe('boom');
	});
});
