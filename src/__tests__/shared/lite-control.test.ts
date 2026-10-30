/**
 * Where the CLI looks for Lite's control discovery file. The desktop writes it
 * under `app.getPath('userData')/Lite`; a process without Electron has to reach
 * the same directory through `resolveUserDataDir()`, the one shared resolver.
 * Linux defaults to lowercase, while an existing capitalized directory that
 * holds desktop state remains discoverable through the canonical resolver.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
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

	describe.runIf(os.platform() === 'linux')('Linux data directory spelling', () => {
		let xdg: string;

		beforeEach(() => {
			xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-lite-xdg-'));
			process.env.XDG_CONFIG_HOME = xdg;
			process.env.NODE_ENV = 'test';
		});

		afterEach(() => {
			fs.rmSync(xdg, { recursive: true, force: true });
		});

		it('uses the lowercase Linux default when no existing installation is present', () => {
			expect(resolveLiteDataDirectory()).toBe(path.join(xdg, 'maestro', 'Lite'));
		});

		it('finds capitalized desktop state beside an empty lowercase directory', () => {
			fs.mkdirSync(path.join(xdg, 'maestro'));
			fs.mkdirSync(path.join(xdg, 'Maestro'), { recursive: true });
			fs.writeFileSync(path.join(xdg, 'Maestro', 'maestro-window-state.json'), '{}');
			const resolved = resolveLiteDataDirectory();
			expect(path.basename(resolved)).toBe('Lite');
			expect(fs.realpathSync.native(path.dirname(resolved))).toBe(
				fs.realpathSync.native(path.join(xdg, 'Maestro'))
			);
		});
	});
});
