/**
 * `resolveMaestroUserDataDir` is the one thing that has to agree between the
 * desktop app (via Electron's `app.getPath('userData')`, mirrored here),
 * `maestro-cli`, and the standalone Cue engine runner - see the module's own
 * doc comment. These tests pin the env-var override and the per-platform
 * fallback so a future edit can't silently point one of those three
 * somewhere the others don't look.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';

describe('resolveMaestroUserDataDir', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it('honors MAESTRO_USER_DATA when set, resolved to an absolute path', async () => {
		process.env.MAESTRO_USER_DATA = 'relative/override';
		const { resolveMaestroUserDataDir } = await import('../../shared/maestroUserDataDir');
		expect(resolveMaestroUserDataDir()).toBe(path.resolve('relative/override'));
	});

	it('falls back to the per-platform default when unset', async () => {
		delete process.env.MAESTRO_USER_DATA;
		const { resolveMaestroUserDataDir } = await import('../../shared/maestroUserDataDir');
		const result = resolveMaestroUserDataDir();

		// Exercise whichever branch the CI/dev host actually runs, rather than
		// mocking os.platform() - the fallback must be right on the platform
		// this test suite actually executes on.
		const platform = os.platform();
		if (platform === 'darwin') {
			expect(result).toBe(path.join(os.homedir(), 'Library', 'Application Support', 'Maestro'));
		} else if (platform === 'win32') {
			expect(result).toBe(
				path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Maestro')
			);
		} else {
			expect(result).toBe(
				path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Maestro')
			);
		}
	});

	it('never imports electron - safe to load in a plain Node process', async () => {
		// A require of 'electron' from outside the Electron binary resolves to
		// a path string, not an object - if this module touched `app` at
		// import or call time, this call would throw. It must not.
		delete process.env.MAESTRO_USER_DATA;
		const { resolveMaestroUserDataDir } = await import('../../shared/maestroUserDataDir');
		expect(() => resolveMaestroUserDataDir()).not.toThrow();
	});
});
