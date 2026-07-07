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
 *
 * The source now uses promisify(execFile) so the lookup does not block the main
 * event loop, so we mock execFile with a custom promisified form
 * (util.promisify.custom) that delegates to `execFileImpl`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { getParentPid } from '../../../main/coworking/pid-resolution';

// Hoisted so the vi.mock factory (evaluated above these declarations) can close
// over it. The factory returns { stdout } or throws, standing in for the
// promisified execFile body.
const { execFileImpl } = vi.hoisted(() => ({ execFileImpl: vi.fn() }));

vi.mock('child_process', () => {
	const execFile = () => {
		throw new Error('coworking pid-resolution must use the promisified execFile');
	};
	// promisify(execFile) returns this custom form; util.promisify.custom is the
	// globally-registered Symbol.for('nodejs.util.promisify.custom').
	(execFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
		async (file: string, args: string[], options: unknown) => execFileImpl(file, args, options);
	return { execFile, default: { execFile } };
});

vi.mock('../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => true),
	isMacOS: vi.fn(() => false),
	isLinux: vi.fn(() => false),
}));

type GetParentPid = typeof getParentPid;

/** Fresh module instance so the module-level `windowsPidBackend` cache resets.
 *  Static import cannot work here: it would share one cached backend across
 *  every test, making the probe-order assertions meaningless. */
async function importFreshGetParentPid(): Promise<GetParentPid> {
	vi.resetModules();
	const mod = await import('../../../main/coworking/pid-resolution');
	return mod.getParentPid;
}

/** Binaries execFile was invoked with, in call order. */
function invokedBinaries(): string[] {
	return execFileImpl.mock.calls.map((call) => String(call[0]));
}

describe('getParentPid Windows backend fallback', () => {
	beforeEach(() => {
		execFileImpl.mockReset();
	});

	it('uses wmic when it works and caches that backend for later calls', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		execFileImpl.mockResolvedValue({ stdout: 'ParentProcessId=321\r\n' });

		expect(await getParentPidFresh(500)).toBe(321);
		expect(await getParentPidFresh(600)).toBe(321);
		// Both lookups went to wmic; PowerShell was never probed.
		expect(invokedBinaries()).toEqual(['wmic', 'wmic']);
	});

	it('falls back to PowerShell CIM when wmic is missing and caches the fallback', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		execFileImpl.mockImplementation((file: string) => {
			if (file === 'wmic') throw Object.assign(new Error('spawn wmic ENOENT'), { code: 'ENOENT' });
			return { stdout: '777\r\n' };
		});

		expect(await getParentPidFresh(500)).toBe(777);
		// First call probes wmic, fails, lands on PowerShell.
		expect(invokedBinaries()).toEqual(['wmic', 'powershell']);

		// Second call skips the dead wmic probe entirely (backend cached).
		expect(await getParentPidFresh(600)).toBe(777);
		expect(invokedBinaries()).toEqual(['wmic', 'powershell', 'powershell']);
	});

	it('returns null (fail-closed) when both backends fail', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		execFileImpl.mockImplementation(() => {
			throw new Error('spawn failure');
		});

		expect(await getParentPidFresh(500)).toBeNull();
		expect(invokedBinaries()).toEqual(['wmic', 'powershell']);
	});

	it('returns null when a cached backend later fails, without throwing', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		// Cache the wmic backend with one good lookup...
		execFileImpl.mockResolvedValueOnce({ stdout: 'ParentProcessId=42\r\n' });
		expect(await getParentPidFresh(500)).toBe(42);
		// ...then have it blow up: fail-closed null, no cross-backend retry storm.
		execFileImpl.mockImplementation(() => {
			throw new Error('wmic broke mid-flight');
		});
		expect(await getParentPidFresh(600)).toBeNull();
	});

	it('rejects non-positive and non-integer pids before spawning anything', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		expect(await getParentPidFresh(0)).toBeNull();
		expect(await getParentPidFresh(-5)).toBeNull();
		expect(await getParentPidFresh(1)).toBeNull();
		expect(await getParentPidFresh(2.5)).toBeNull();
		expect(execFileImpl).not.toHaveBeenCalled();
	});

	it('parses unparseable backend output as null instead of a bogus pid', async () => {
		const getParentPidFresh = await importFreshGetParentPid();
		execFileImpl.mockResolvedValue({ stdout: 'No Instance(s) Available.\r\n' });
		expect(await getParentPidFresh(500)).toBeNull();
	});
});
