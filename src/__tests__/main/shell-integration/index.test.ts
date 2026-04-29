/**
 * Tests for src/main/shell-integration/index.ts
 *
 * `getShellIntegrationEnv` / `getShellIntegrationArgs` form the contract
 * between PtySpawner and the static loader files written by `setup.ts`.
 * These tests pin:
 *   - Which shells are recognized and how their names are normalized.
 *   - That the env vars the loaders depend on (`ZDOTDIR`,
 *     `MAESTRO_REAL_ZDOTDIR`, `MAESTRO_SHELL_INTEGRATION_SCRIPT`) are
 *     populated correctly per shell.
 *   - That `--rcfile` is the only extra arg surfaced (bash only).
 *   - That unsupported shells yield empty values so PtySpawner can spread
 *     them unconditionally.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
	app: {
		// `setup.ts` resolves loader paths via `app.getPath('userData')`. The
		// path itself doesn't have to exist on disk — these tests only assert
		// that the values come through to the env / args.
		getPath: vi.fn((name: string) => {
			if (name === 'userData') return path.join(os.tmpdir(), 'maestro-si-index-test');
			return os.tmpdir();
		}),
	},
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import {
	getShellIntegrationArgs,
	getShellIntegrationEnv,
} from '../../../main/shell-integration/index';
import { getBashLoaderPath, getZshLoaderDir } from '../../../main/shell-integration/setup';

describe('getShellIntegrationEnv', () => {
	const originalZdotdir = process.env.ZDOTDIR;

	beforeEach(() => {
		delete process.env.ZDOTDIR;
	});

	afterEach(() => {
		if (originalZdotdir === undefined) {
			delete process.env.ZDOTDIR;
		} else {
			process.env.ZDOTDIR = originalZdotdir;
		}
	});

	it('zsh: marks integration active and embeds the zsh script body', () => {
		const env = getShellIntegrationEnv('/bin/zsh');
		expect(env.MAESTRO_SHELL_INTEGRATION).toBe('1');
		// The body must be the actual zsh integration (not the bash one) — the
		// loader will eval whatever string is here.
		expect(env.MAESTRO_SHELL_INTEGRATION_SCRIPT).toMatch(/add-zsh-hook/);
		expect(env.MAESTRO_SHELL_INTEGRATION_SCRIPT).not.toMatch(/PROMPT_COMMAND/);
	});

	it('zsh: points ZDOTDIR at the loader dir from setup.ts', () => {
		// PtySpawner relies on this matching exactly, otherwise zsh reads the
		// user's real .zshrc directly and our hooks never load.
		const env = getShellIntegrationEnv('/bin/zsh');
		expect(env.ZDOTDIR).toBe(getZshLoaderDir());
	});

	it('zsh: stashes the user ZDOTDIR in MAESTRO_REAL_ZDOTDIR when set', () => {
		process.env.ZDOTDIR = '/home/alice/.config/zsh';
		const env = getShellIntegrationEnv('/bin/zsh');
		expect(env.MAESTRO_REAL_ZDOTDIR).toBe('/home/alice/.config/zsh');
	});

	it('zsh: omits MAESTRO_REAL_ZDOTDIR when the parent has none', () => {
		// If we set this to '' the loader's `[ -n ... ]` guard would assign an
		// empty ZDOTDIR and miss the $HOME/.zshrc fallback.
		const env = getShellIntegrationEnv('/bin/zsh');
		expect('MAESTRO_REAL_ZDOTDIR' in env).toBe(false);
	});

	it('zsh: classifies bare command names and absolute paths the same way', () => {
		const fromBare = getShellIntegrationEnv('zsh');
		const fromAbs = getShellIntegrationEnv('/usr/local/bin/zsh');
		expect(fromBare.ZDOTDIR).toBe(fromAbs.ZDOTDIR);
		expect(fromBare.MAESTRO_SHELL_INTEGRATION_SCRIPT).toBe(
			fromAbs.MAESTRO_SHELL_INTEGRATION_SCRIPT
		);
	});

	it('bash: marks integration active and embeds the bash script body', () => {
		const env = getShellIntegrationEnv('/bin/bash');
		expect(env.MAESTRO_SHELL_INTEGRATION).toBe('1');
		expect(env.MAESTRO_SHELL_INTEGRATION_SCRIPT).toMatch(/PROMPT_COMMAND/);
		expect(env.MAESTRO_SHELL_INTEGRATION_SCRIPT).not.toMatch(/add-zsh-hook/);
	});

	it('bash: leaves ZDOTDIR / MAESTRO_REAL_ZDOTDIR alone (zsh-only knobs)', () => {
		process.env.ZDOTDIR = '/home/alice/.config/zsh';
		const env = getShellIntegrationEnv('/bin/bash');
		expect('ZDOTDIR' in env).toBe(false);
		expect('MAESTRO_REAL_ZDOTDIR' in env).toBe(false);
	});

	it('handles bash.exe (Windows / Git Bash) the same as bash', () => {
		const env = getShellIntegrationEnv('C:\\msys64\\usr\\bin\\bash.exe');
		expect(env.MAESTRO_SHELL_INTEGRATION).toBe('1');
		expect(env.MAESTRO_SHELL_INTEGRATION_SCRIPT).toMatch(/PROMPT_COMMAND/);
	});

	it.each([
		['sh', '/bin/sh'],
		['fish', '/usr/local/bin/fish'],
		['powershell', 'powershell.exe'],
		['cmd', 'cmd.exe'],
		['undefined', undefined],
		['empty string', ''],
	])('returns {} for unsupported shell %s', (_label, shell) => {
		expect(getShellIntegrationEnv(shell)).toEqual({});
	});
});

describe('getShellIntegrationArgs', () => {
	it('bash: passes --rcfile pointing at the loader from setup.ts', () => {
		// The ordering and exact path matter — bash silently ignores --rcfile
		// under -l, and PtySpawner reads this loader path verbatim.
		const args = getShellIntegrationArgs('/bin/bash');
		expect(args).toEqual(['--rcfile', getBashLoaderPath()]);
	});

	it('bash.exe: same args as bash', () => {
		expect(getShellIntegrationArgs('bash.exe')).toEqual(['--rcfile', getBashLoaderPath()]);
	});

	it('zsh: returns no extra args (ZDOTDIR drives the loader)', () => {
		// zsh discovers the loader through ZDOTDIR, so adding e.g. `--rcs`
		// here would only confuse the spawn.
		expect(getShellIntegrationArgs('/bin/zsh')).toEqual([]);
		expect(getShellIntegrationArgs('zsh')).toEqual([]);
	});

	it.each([
		['sh', '/bin/sh'],
		['fish', '/usr/local/bin/fish'],
		['powershell', 'powershell.exe'],
		['cmd', 'cmd.exe'],
		['undefined', undefined],
		['empty string', ''],
	])('returns [] for unsupported shell %s', (_label, shell) => {
		expect(getShellIntegrationArgs(shell)).toEqual([]);
	});
});
