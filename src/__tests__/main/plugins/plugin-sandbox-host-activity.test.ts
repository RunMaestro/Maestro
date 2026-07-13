/**
 * @file plugin-sandbox-host-activity.test.ts
 * @description Read-only per-plugin observability on the sandbox host:
 *   - a started plugin shows up in getActivity() with zeroed counters,
 *   - dispatching a host call increments totalCalls and peak in-flight, and
 *     in-flight returns to zero once the call settles (overlapping calls drive
 *     peak above one),
 *   - a non-zero child exit bumps crashCount and clears in-flight, while a clean
 *     exit does not,
 *   - the recent-log ring buffer is bounded to 50 (oldest dropped),
 *   - getActivity() returns serializable snapshots that are copies (mutating a
 *     snapshot never leaks into host state).
 * Time is driven by awaiting the dispatch promise the host already exposes (no
 * wall-clock timers). electron's utilityProcess and the file logger are mocked
 * so nothing is forked and no log file is written.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { forkMock, listeners, proc } = vi.hoisted(() => {
	const listeners = new Map<string, (...a: unknown[]) => void>();
	const proc = {
		postMessage: vi.fn(),
		on: (event: string, cb: (...a: unknown[]) => void) => {
			listeners.set(event, cb);
		},
		kill: vi.fn(),
	};
	const forkMock = vi.fn(() => proc);
	return { forkMock, listeners, proc };
});

vi.mock('electron', () => ({
	utilityProcess: { fork: forkMock },
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PluginSandboxHost } from '../../../main/plugins/plugin-sandbox-host';
import type { ActivitySnapshot } from '../../../main/plugins/plugin-sandbox-host';
import type { PermissionBroker } from '../../../main/plugins/permission-broker';

/** Reach the private dispatch entry point so a host call can be awaited to
 *  completion deterministically (no wall-clock timers). */
interface HostInternals {
	handleChildMessage(pluginId: string, child: unknown, data: unknown): Promise<void>;
}

const allowAll = {
	authorize: () => ({ allowed: true }),
	authorizeInvocation: () => ({ allowed: true }),
} as unknown as PermissionBroker;

function emit(event: string, ...args: unknown[]): void {
	const cb = listeners.get(event);
	if (!cb) throw new Error(`no listener captured for "${event}"`);
	cb(...args);
}

describe('PluginSandboxHost per-plugin observability', () => {
	let dir: string;
	let host: PluginSandboxHost;
	let internal: HostInternals;

	beforeEach(() => {
		vi.clearAllMocks();
		listeners.clear();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-act-'));
		fs.writeFileSync(path.join(dir, 'entry.js'), '// entry', 'utf-8');
		host = new PluginSandboxHost({
			broker: allowAll,
			handlers: { 'storage.get': async () => 'ok' },
		});
		internal = host as unknown as HostInternals;
		host.start('p', '// entry', {
			ownerPluginId: 'p',
			generation: 1,
			artifactDigest: 'a'.repeat(64),
			signerKeyId: 'test-signer',
		});
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('lists a started plugin with zeroed counters', () => {
		const map = host.getActivity();
		expect(Object.keys(map)).toEqual(['p']);
		expect(map.p).toMatchObject({
			totalCalls: 0,
			inFlight: 0,
			peakInFlight: 0,
			crashCount: 0,
			recentLogs: [],
		});
		expect(typeof map.p.lastActivity).toBe('number');
	});

	it('counts a dispatched host call and clears in-flight once it settles', async () => {
		await internal.handleChildMessage('p', proc, {
			id: 1,
			method: 'storage.get',
			params: { key: 'k' },
		});
		const snap = host.getActivity('p');
		expect(snap?.totalCalls).toBe(1);
		expect(snap?.peakInFlight).toBe(1);
		expect(snap?.inFlight).toBe(0);
	});

	it('ignores forged guest snapshot identity fields and uses only the running host identity', async () => {
		const authorizeInvocation = vi.fn(() => ({ allowed: true }));
		host = new PluginSandboxHost({
			broker: {
				authorize: () => ({ allowed: true }),
				authorizeInvocation,
			} as unknown as PermissionBroker,
			handlers: { 'storage.get': async () => 'ok' },
		});
		internal = host as unknown as HostInternals;
		host.start('p', '// entry', {
			ownerPluginId: 'p',
			generation: 1,
			artifactDigest: 'a'.repeat(64),
			signerKeyId: 'trusted-signer',
		});

		await internal.handleChildMessage('p', proc, {
			id: 2,
			method: 'storage.get',
			params: {
				key: 'k',
				artifactDigest: 'b'.repeat(64),
				signerKeyId: 'forged-signer',
				generation: 999,
			},
		});

		expect(authorizeInvocation).toHaveBeenCalledWith(
			expect.objectContaining({
				artifactDigest: 'a'.repeat(64),
				signerKeyId: 'trusted-signer',
				generation: 1,
			}),
			'storage.get',
			expect.anything()
		);
	});

	it('tracks peak in-flight across overlapping calls', async () => {
		const gate = Promise.withResolvers<void>();
		host = new PluginSandboxHost({
			broker: allowAll,
			handlers: {
				'storage.get': async () => {
					await gate.promise;
					return 'ok';
				},
			},
		});
		internal = host as unknown as HostInternals;
		host.start('p', '// entry', {
			ownerPluginId: 'p',
			generation: 1,
			artifactDigest: 'a'.repeat(64),
			signerKeyId: 'test-signer',
		});

		const c1 = internal.handleChildMessage('p', proc, { id: 1, method: 'storage.get', params: {} });
		const c2 = internal.handleChildMessage('p', proc, { id: 2, method: 'storage.get', params: {} });

		let snap = host.getActivity('p');
		expect(snap?.inFlight).toBe(2);
		expect(snap?.peakInFlight).toBe(2);
		expect(snap?.totalCalls).toBe(2);

		gate.resolve();
		await Promise.all([c1, c2]);

		snap = host.getActivity('p');
		expect(snap?.inFlight).toBe(0);
		expect(snap?.peakInFlight).toBe(2);
		expect(snap?.totalCalls).toBe(2);
	});

	it('bumps crashCount and clears in-flight on a non-zero child exit', () => {
		emit('exit', 1);
		const snap = host.getActivity('p');
		expect(snap?.crashCount).toBe(1);
		expect(snap?.inFlight).toBe(0);
		expect(host.isRunning('p')).toBe(false);
	});

	it('does not bump crashCount on a clean exit', () => {
		emit('exit', 0);
		expect(host.getActivity('p')?.crashCount).toBe(0);
	});

	it('bounds the recent-log ring buffer to 50, dropping the oldest', async () => {
		for (let i = 0; i < 60; i++) {
			await internal.handleChildMessage('p', proc, {
				kind: 'log',
				level: 'info',
				message: `m${i}`,
			});
		}
		const snap = host.getActivity('p');
		expect(snap?.recentLogs).toHaveLength(50);
		expect(snap?.recentLogs[0]?.message).toBe('m10');
		expect(snap?.recentLogs[49]?.message).toBe('m59');
		expect(snap?.recentLogs[0]).toMatchObject({ level: 'info' });
		expect(typeof snap?.recentLogs[0]?.at).toBe('number');
	});

	it('returns copies: mutating a snapshot does not affect host state', async () => {
		await internal.handleChildMessage('p', proc, {
			kind: 'log',
			level: 'warn',
			message: 'hello',
		});
		const snap = host.getActivity('p') as ActivitySnapshot;
		expect(snap.recentLogs).toHaveLength(1);
		snap.recentLogs.push({ level: 'error', message: 'injected', at: Date.now() });
		snap.totalCalls = 999;
		expect(host.getActivity('p')?.recentLogs).toHaveLength(1);
		expect(host.getActivity('p')?.totalCalls).toBe(0);
	});

	it('getActivity(unknownId) is undefined', () => {
		expect(host.getActivity('missing')).toBeUndefined();
	});
});
