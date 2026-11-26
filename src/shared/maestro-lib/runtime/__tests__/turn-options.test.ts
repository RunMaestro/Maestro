/**
 * What `maestro-cli host` hands its runtime to run turns: the files found beside the bundle, and
 * the maestro-p a Claude TUI turn runs through (M4: a TUI turn is the one a host can steer).
 */
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../store/native-sqlite', () => ({ loadBetterSqlite3: vi.fn() }));

import { installedMaestroPCandidates, resolveRuntimeTurnOptions } from '../turn-options';

const bundleDir = path.join('/opt', 'maestro', 'cli');
const posixInstalled = '/usr/local/lib/maestro-p/bin/maestro-p.js';

describe('resolveRuntimeTurnOptions', () => {
	it("runs Claude's TUI through the maestro-p beside the bundle when there is one", () => {
		const beside = path.join(bundleDir, 'maestro-p.js');
		const exists = (file: string) => file === beside || file === posixInstalled;
		expect(resolveRuntimeTurnOptions(bundleDir, exists, {}, 'linux').maestroPBinPath).toBe(beside);
	});

	it('finds the maestro-p the installer put on the remote, for a host Move to Host installed', () => {
		const exists = (file: string) => file === posixInstalled;
		expect(resolveRuntimeTurnOptions(bundleDir, exists, {}, 'linux').maestroPBinPath).toBe(
			posixInstalled
		);
	});

	it('has no maestro-p when none is installed: Claude runs over --print', () => {
		expect(resolveRuntimeTurnOptions(bundleDir, () => false, {}, 'linux').maestroPBinPath).toBe(
			null
		);
	});
});

describe('installedMaestroPCandidates', () => {
	it('looks in MAESTRO_P_HOME first, then the default install folder', () => {
		expect(installedMaestroPCandidates({ MAESTRO_P_HOME: '/home/me/mp' }, 'linux')).toEqual([
			'/home/me/mp/bin/maestro-p.js',
			posixInstalled,
		]);
		expect(installedMaestroPCandidates({ ProgramFiles: 'C:\\Program Files' }, 'win32')).toEqual([
			'C:\\Program Files\\maestro-p\\bin\\maestro-p.js',
		]);
		expect(installedMaestroPCandidates({}, 'win32')).toEqual([]);
	});
});
