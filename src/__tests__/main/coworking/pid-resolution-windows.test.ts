/**
 * Windows parent-pid backend fallback tests.
 *
 * Contract: `getParentPid` on Windows tries `wmic` first; when the wmic spawn
 * fails (deprecated binary, removed on newer Win11 builds) it falls back to
 * PowerShell CIM, remembers the working backend in a module-level cache, and
 * never throws (fail-closed null).
 *
 * The backend cache lives at module scope, so each test re-imports a fresh
 * module via vi.resetModules().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { getParentPid } from '../../../main/coworking/pid-resolution';

vi.mock('child_process', () => {
	const execFileSync = vi.fn();
	return { execFileSync, default: { execFileSync } };
});

vi.mock('../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => true),
	isMacOS: vi.fn(() => false),
	isLinux: vi.fn(() => false),
}));

import { execFileSync } from 'child_process';

type GetParentPid = typeof getParentPid;

/** Fresh module instance so the module-level `windowsPidBackend` cache resets.
 *  Static import cannot work here: it would share one cached backend across
 *  every test, making the probe-order assertions meaningless. */
async function importFreshGetParentPid(): Promise<GetParentPid> {
	vi.resetModules();
	const mod = await import('../../../main/coworking/pid-resolution');
	return mod.getParentPid;
}

/** Binaries execFileSync was invoked with, in call order. */
function invokedBinaries(): string[] {
	return vi.mocked(execFileSync).mock.calls.map((call) => String(call[0]));
}

describe('getParentPid Windows backend fallback', () => {
	beforeEach(() => {
		vi.mocked(execFileSync).mockReset();
	});

	it('uses wmic when it works and caches that backend for later calls', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		vi.mocked(execFileSync).mockReturnValue('ParentProcessId=321\r\n');

		expect(getParentPidFresh(500)).toBe(321);
		expect(getParentPidFresh(600)).toBe(321);
		// Both lookups went to wmic; PowerShell was never probed.
		expect(invokedBinaries()).toEqual(['wmic', 'wmic']);
	});

	it('falls back to PowerShell CIM when wmic is missing and caches the fallback', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		vi.mocked(execFileSync).mockImplementation((file) => {
			if (file === 'wmic') throw Object.assign(new Error('spawn wmic ENOENT'), { code: 'ENOENT' });
			return '777\r\n';
		});

		expect(getParentPidFresh(500)).toBe(777);
		// First call probes wmic, fails, lands on PowerShell.
		expect(invokedBinaries()).toEqual(['wmic', 'powershell']);

		// Second call skips the dead wmic probe entirely (backend cached).
		expect(getParentPidFresh(600)).toBe(777);
		expect(invokedBinaries()).toEqual(['wmic', 'powershell', 'powershell']);
	});

	it('returns null (fail-closed) when both backends fail', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		vi.mocked(execFileSync).mockImplementation(() => {
			throw new Error('spawn failure');
		});

		expect(getParentPidFresh(500)).toBeNull();
		expect(invokedBinaries()).toEqual(['wmic', 'powershell']);
	});

	it('returns null when a cached backend later fails, without throwing', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		// Cache the wmic backend with one good lookup...
		vi.mocked(execFileSync).mockReturnValueOnce('ParentProcessId=42\r\n');
		expect(getParentPidFresh(500)).toBe(42);
		// ...then have it blow up: fail-closed null, no cross-backend retry storm.
		vi.mocked(execFileSync).mockImplementation(() => {
			throw new Error('wmic broke mid-flight');
		});
		expect(getParentPidFresh(600)).toBeNull();
	});

	it('rejects non-positive and non-integer pids before spawning anything', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		expect(getParentPidFresh(0)).toBeNull();
		expect(getParentPidFresh(-5)).toBeNull();
		expect(getParentPidFresh(1)).toBeNull();
		expect(getParentPidFresh(2.5)).toBeNull();
		expect(execFileSync).not.toHaveBeenCalled();
	});

	it('parses unparseable backend output as null instead of a bogus pid', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		vi.mocked(execFileSync).mockReturnValue('No Instance(s) Available.\r\n');
		expect(getParentPidFresh(500)).toBeNull();
	});
});
