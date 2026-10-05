/**
 * Tests for the desktop's library-runtime host (Phase 9, behind the `libraryRuntime` setting).
 *
 * The runtime itself is replaced by a fake `create`: these cover the mapping from "setting, guard
 * claim, runtime answer" to "hosting or not", and what each branch does to the lock the guard holds.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataDirClaim } from '../../../main/app-lifecycle/data-dir-guard';
import { startLibraryRuntimeHost } from '../../../main/library-runtime/host';
import type { createMaestroRuntime } from '../../../shared/maestro-lib/runtime';
import type { DataDirLock } from '../../../shared/maestro-lib/runtime/data-dir-lock';
import type { MaestroRuntime, RuntimeStart } from '../../../shared/maestro-lib/runtime';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function claimed() {
	const lock = { file: '/data/maestro-runtime.lock', mode: 'desktop' } as unknown as DataDirLock;
	const claim = {
		outcome: 'claimed' as const,
		release: vi.fn(),
		lock,
		pauseHeartbeat: vi.fn(),
		resumeHeartbeat: vi.fn(),
	};
	return { claim: claim satisfies DataDirClaim, lock };
}

function fakeRuntime() {
	const close = vi.fn(async () => undefined);
	const runtime = {
		lock: { pid: 4242, mode: 'desktop', startedAt: new Date(0).toISOString() },
		connection: { close },
	} as unknown as MaestroRuntime;
	return { runtime, close };
}

describe('startLibraryRuntimeHost', () => {
	let create: ReturnType<typeof vi.fn<typeof createMaestroRuntime>>;

	beforeEach(() => {
		create = vi.fn<typeof createMaestroRuntime>();
	});

	describe('setting OFF', () => {
		it('hosts nothing, says why, and never touches the lock or creates a runtime', async () => {
			const { claim } = claimed();
			const host = await startLibraryRuntimeHost({
				enabled: false,
				claim,
				dataDir: '/data',
				create,
			});

			expect(create).not.toHaveBeenCalled();
			expect(claim.pauseHeartbeat).not.toHaveBeenCalled();
			expect(host.runtime()).toBeUndefined();
			expect(host.status()).toEqual({
				hosting: false,
				reason: 'The libraryRuntime setting is off.',
			});
			await expect(host.close()).resolves.toBeUndefined();
		});
	});

	describe('setting ON', () => {
		it('adopts the guard lock in mode desktop with the desktop options (one lock, DM1)', async () => {
			const { claim, lock } = claimed();
			const { runtime } = fakeRuntime();
			create.mockResolvedValue({ ok: true, runtime } satisfies RuntimeStart);
			const deps = { checkCwd: () => null };

			const host = await startLibraryRuntimeHost({
				enabled: true,
				claim,
				dataDir: '/data',
				productionDataDir: '/prod',
				deps,
				create,
			});

			expect(create).toHaveBeenCalledTimes(1);
			expect(create).toHaveBeenCalledWith({
				dataDir: '/data',
				productionDataDir: '/prod',
				mode: 'desktop',
				lock,
				allowSyncedDataDir: true,
				quarantineCorruptStores: true,
				deps,
			});
			expect(host.status()).toEqual({ hosting: true });
			expect(host.runtime()).toBe(runtime);
		});

		it('stops the guard heartbeat before the runtime starts beating (one heartbeat)', async () => {
			const { claim } = claimed();
			const order: string[] = [];
			claim.pauseHeartbeat.mockImplementation(() => order.push('pause'));
			create.mockImplementation(async () => {
				order.push('create');
				return { ok: true, runtime: fakeRuntime().runtime } satisfies RuntimeStart;
			});

			await startLibraryRuntimeHost({ enabled: true, claim, dataDir: '/data', create });

			expect(order).toEqual(['pause', 'create']);
			expect(claim.resumeHeartbeat).not.toHaveBeenCalled();
		});

		it('omits productionDataDir and deps when none are given', async () => {
			const { claim } = claimed();
			create.mockResolvedValue({ ok: true, runtime: fakeRuntime().runtime });
			await startLibraryRuntimeHost({ enabled: true, claim, dataDir: '/data', create });
			const options = create.mock.calls[0][0];
			expect(options).not.toHaveProperty('productionDataDir');
			expect(options).not.toHaveProperty('deps');
		});

		it('close drains the runtime once, however often it is called', async () => {
			const { claim } = claimed();
			const { runtime, close } = fakeRuntime();
			create.mockResolvedValue({ ok: true, runtime });
			const host = await startLibraryRuntimeHost({
				enabled: true,
				claim,
				dataDir: '/data',
				create,
			});

			await host.close();
			await host.close();
			expect(close).toHaveBeenCalledTimes(1);
		});

		it('falls back to the OFF path when the runtime refuses, hands the beat back, and reports it (DM4)', async () => {
			const { claim } = claimed();
			create.mockResolvedValue({
				ok: false,
				refusal: {
					reason: 'store-corrupt',
					file: '/data/s.json',
					detail: 'x',
					message: 'Corrupt store',
				},
			} satisfies RuntimeStart);
			const onRefused = vi.fn();

			const host = await startLibraryRuntimeHost({
				enabled: true,
				claim,
				dataDir: '/data',
				onRefused,
				create,
			});

			expect(host.status()).toEqual({ hosting: false, reason: 'Corrupt store' });
			expect(host.runtime()).toBeUndefined();
			expect(claim.resumeHeartbeat).toHaveBeenCalledTimes(1);
			expect(claim.release).not.toHaveBeenCalled();
			expect(onRefused).toHaveBeenCalledWith('Corrupt store');
		});

		it('never throws: a runtime that throws on start is an OFF run', async () => {
			const { claim } = claimed();
			create.mockRejectedValue(new Error('disk gone'));
			const onRefused = vi.fn();

			const host = await startLibraryRuntimeHost({
				enabled: true,
				claim,
				dataDir: '/data',
				onRefused,
				create,
			});

			expect(host.status()).toEqual({ hosting: false, reason: 'disk gone' });
			expect(claim.resumeHeartbeat).toHaveBeenCalledTimes(1);
			expect(onRefused).toHaveBeenCalledWith('disk gone');
		});

		it('starts no runtime without the lock: a runtime beside another desktop would be a second writer', async () => {
			const onRefused = vi.fn();
			const host = await startLibraryRuntimeHost({
				enabled: true,
				claim: { outcome: 'proceed', reason: 'Another desktop owns it.' },
				dataDir: '/data',
				onRefused,
				create,
			});

			expect(create).not.toHaveBeenCalled();
			expect(host.status().hosting).toBe(false);
			expect(host.status().reason).toContain('Another desktop owns it.');
			expect(onRefused).toHaveBeenCalledTimes(1);
		});
	});
});
