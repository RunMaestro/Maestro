/**
 * Where the CLI looks for Lite's control discovery file. The desktop writes it
 * under `app.getPath('userData')/Lite`; a process without Electron has to reach
 * the same directory through `resolveUserDataDir()`, the one shared resolver.
 * The lowercase `~/.config/maestro` fallback this replaced never matched a
 * packaged Linux install, which writes `~/.config/Maestro`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { resolveLiteDataDirectory } from '../../shared/lite-control';
import { resolveUserDataDir } from '../../shared/userDataDir';

const ENV_KEYS = ['MAESTRO_USER_DATA', 'XDG_CONFIG_HOME', 'NODE_ENV', 'USE_PROD_DATA'] as const;

describe('resolveLiteDataDirectory', () => {
	const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) saved[key] = process.env[key];
		delete process.env.MAESTRO_USER_DATA;
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	it('resolves through resolveUserDataDir when no base is given', () => {
		expect(resolveLiteDataDirectory()).toBe(path.join(resolveUserDataDir(), 'Lite'));
	});

	it('honors MAESTRO_USER_DATA over the platform default and over a base directory', () => {
		const dataDir = path.join(os.tmpdir(), 'maestro-host-data');
		process.env.MAESTRO_USER_DATA = dataDir;
		expect(resolveLiteDataDirectory()).toBe(path.join(dataDir, 'Lite'));
		expect(resolveLiteDataDirectory(undefined, '/elsewhere')).toBe(path.join(dataDir, 'Lite'));
	});

	it('keeps the desktop base directory when MAESTRO_USER_DATA is unset', () => {
		const base = path.join(os.tmpdir(), 'electron-user-data');
		expect(resolveLiteDataDirectory(undefined, base)).toBe(path.join(base, 'Lite'));
	});

	it.runIf(os.platform() === 'linux')(
		'lands on the installed `Maestro` spelling on Linux, not lowercase `maestro`',
		() => {
			const xdg = path.join(os.tmpdir(), 'xdg-config');
			process.env.XDG_CONFIG_HOME = xdg;
			process.env.NODE_ENV = 'test';
			expect(resolveLiteDataDirectory()).toBe(path.join(xdg, 'Maestro', 'Lite'));
		}
	);
});
