/**
 * Tests for src/main/shell-integration/setup.ts
 *
 * `ensureShellIntegrationFiles()` writes two static loader files into the
 * userData directory. PtySpawner depends on the exact filesystem layout
 * (`<userData>/shell-integration/zsh/.zshrc` and `bash-init.sh`) and on the
 * loader scripts deferring to `$MAESTRO_SHELL_INTEGRATION_SCRIPT`. These
 * tests pin the layout, the deferral mechanism, and the user-rc sourcing
 * order so a regression in any of those breaks loudly.
 *
 * We exercise the real fs against a per-test temp directory rather than
 * mocking writeFileSync so we can assert the actual on-disk content the
 * shell will eventually source.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let mockUserDataPath = '';

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) => {
			if (name === 'userData') return mockUserDataPath;
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
	ensureShellIntegrationFiles,
	getShellIntegrationDir,
	getZshLoaderDir,
	getBashLoaderPath,
} from '../../../main/shell-integration/setup';
import { logger } from '../../../main/utils/logger';

describe('ensureShellIntegrationFiles', () => {
	beforeEach(() => {
		mockUserDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-si-setup-'));
		vi.clearAllMocks();
	});

	afterEach(() => {
		fs.rmSync(mockUserDataPath, { recursive: true, force: true });
	});

	it('writes the zsh loader at <userData>/shell-integration/zsh/.zshrc', () => {
		ensureShellIntegrationFiles();
		const zshrcPath = path.join(mockUserDataPath, 'shell-integration', 'zsh', '.zshrc');
		expect(fs.existsSync(zshrcPath)).toBe(true);
	});

	it('writes the bash loader at <userData>/shell-integration/bash-init.sh', () => {
		ensureShellIntegrationFiles();
		const bashPath = path.join(mockUserDataPath, 'shell-integration', 'bash-init.sh');
		expect(fs.existsSync(bashPath)).toBe(true);
	});

	it('exposes the loader paths via getter helpers (PtySpawner contract)', () => {
		// PtySpawner will set ZDOTDIR to getZshLoaderDir() and pass --rcfile
		// getBashLoaderPath() — those getters must agree with where the
		// loaders are actually written.
		ensureShellIntegrationFiles();
		expect(fs.existsSync(path.join(getZshLoaderDir(), '.zshrc'))).toBe(true);
		expect(fs.existsSync(getBashLoaderPath())).toBe(true);
		expect(getShellIntegrationDir()).toBe(path.join(mockUserDataPath, 'shell-integration'));
	});

	it('zsh loader sources the user .zshrc and evals the integration script', () => {
		ensureShellIntegrationFiles();
		const zshrc = fs.readFileSync(
			path.join(mockUserDataPath, 'shell-integration', 'zsh', '.zshrc'),
			'utf-8'
		);
		// Sources the user's real .zshrc (via restored ZDOTDIR or HOME fallback).
		expect(zshrc).toMatch(/source\s+"\$\{ZDOTDIR\}\/\.zshrc"/);
		expect(zshrc).toMatch(/source\s+"\$\{HOME\}\/\.zshrc"/);
		// Evals the integration script from the env var (deferred so the
		// loader file itself stays static across builds).
		expect(zshrc).toMatch(/eval\s+"\$\{MAESTRO_SHELL_INTEGRATION_SCRIPT\}"/);
	});

	it('zsh loader restores MAESTRO_REAL_ZDOTDIR before sourcing user rc', () => {
		// User rc must see their original ZDOTDIR, not our integration dir,
		// or any of their config that consults $ZDOTDIR will look in the
		// wrong place.
		ensureShellIntegrationFiles();
		const zshrc = fs.readFileSync(
			path.join(mockUserDataPath, 'shell-integration', 'zsh', '.zshrc'),
			'utf-8'
		);
		expect(zshrc).toMatch(/ZDOTDIR="\$\{MAESTRO_REAL_ZDOTDIR\}"/);
		// And the assignment must come BEFORE the source line.
		const assignIdx = zshrc.indexOf('ZDOTDIR="${MAESTRO_REAL_ZDOTDIR}"');
		const sourceIdx = zshrc.indexOf('source "${ZDOTDIR}/.zshrc"');
		expect(assignIdx).toBeGreaterThanOrEqual(0);
		expect(sourceIdx).toBeGreaterThan(assignIdx);
	});

	it('zsh loader sources user rc BEFORE evaling the integration script', () => {
		// Order matters: the integration script registers preexec/precmd
		// hooks via add-zsh-hook and must run last so any user customization
		// that re-runs add-zsh-hook (or replaces the array wholesale) does
		// not strip our hooks.
		ensureShellIntegrationFiles();
		const zshrc = fs.readFileSync(
			path.join(mockUserDataPath, 'shell-integration', 'zsh', '.zshrc'),
			'utf-8'
		);
		const sourceIdx = Math.max(
			zshrc.indexOf('source "${ZDOTDIR}/.zshrc"'),
			zshrc.indexOf('source "${HOME}/.zshrc"')
		);
		const evalIdx = zshrc.indexOf('eval "${MAESTRO_SHELL_INTEGRATION_SCRIPT}"');
		expect(sourceIdx).toBeGreaterThanOrEqual(0);
		expect(evalIdx).toBeGreaterThan(sourceIdx);
	});

	it('bash loader sources ~/.bashrc and evals the integration script', () => {
		ensureShellIntegrationFiles();
		const bashrc = fs.readFileSync(
			path.join(mockUserDataPath, 'shell-integration', 'bash-init.sh'),
			'utf-8'
		);
		expect(bashrc).toMatch(/source\s+"\$\{HOME\}\/\.bashrc"/);
		expect(bashrc).toMatch(/eval\s+"\$\{MAESTRO_SHELL_INTEGRATION_SCRIPT\}"/);
	});

	it('bash loader sources ~/.bashrc BEFORE evaling the integration script', () => {
		// Same ordering rationale as the zsh loader: the DEBUG trap and
		// PROMPT_COMMAND sandwich need to install last so the user rc cannot
		// stomp on them.
		ensureShellIntegrationFiles();
		const bashrc = fs.readFileSync(
			path.join(mockUserDataPath, 'shell-integration', 'bash-init.sh'),
			'utf-8'
		);
		const sourceIdx = bashrc.indexOf('source "${HOME}/.bashrc"');
		const evalIdx = bashrc.indexOf('eval "${MAESTRO_SHELL_INTEGRATION_SCRIPT}"');
		expect(sourceIdx).toBeGreaterThanOrEqual(0);
		expect(evalIdx).toBeGreaterThan(sourceIdx);
	});

	it('is idempotent — repeated calls leave the loader content unchanged', () => {
		ensureShellIntegrationFiles();
		const zshrcPath = path.join(mockUserDataPath, 'shell-integration', 'zsh', '.zshrc');
		const bashPath = path.join(mockUserDataPath, 'shell-integration', 'bash-init.sh');
		const zshFirst = fs.readFileSync(zshrcPath, 'utf-8');
		const bashFirst = fs.readFileSync(bashPath, 'utf-8');

		ensureShellIntegrationFiles();
		expect(fs.readFileSync(zshrcPath, 'utf-8')).toBe(zshFirst);
		expect(fs.readFileSync(bashPath, 'utf-8')).toBe(bashFirst);
	});

	it('overwrites stale loader content from a previous build', () => {
		// On upgrade we want the new loader, not whatever an older Maestro
		// build wrote — even if the old content "happens to work".
		const zshrcPath = path.join(mockUserDataPath, 'shell-integration', 'zsh', '.zshrc');
		fs.mkdirSync(path.dirname(zshrcPath), { recursive: true });
		fs.writeFileSync(zshrcPath, '# stale content from old build\n', 'utf-8');

		ensureShellIntegrationFiles();
		const refreshed = fs.readFileSync(zshrcPath, 'utf-8');
		expect(refreshed).not.toBe('# stale content from old build\n');
		expect(refreshed).toMatch(/MAESTRO_SHELL_INTEGRATION_SCRIPT/);
	});

	it('creates the parent directory tree if it does not exist', () => {
		// userData/shell-integration/zsh is two levels deep; plain
		// writeFileSync would fail without recursive mkdir.
		const siDir = path.join(mockUserDataPath, 'shell-integration');
		expect(fs.existsSync(siDir)).toBe(false);
		ensureShellIntegrationFiles();
		expect(fs.existsSync(path.join(siDir, 'zsh'))).toBe(true);
	});

	it('logs and swallows fs errors instead of throwing (startup must not block)', () => {
		// Point userData at a path that cannot be created (a regular file's
		// child path) so mkdirSync fails. App startup should still proceed —
		// the ps fallback covers the no-shell-integration case.
		const blockingFile = path.join(mockUserDataPath, 'blocker');
		fs.writeFileSync(blockingFile, 'i am a file, not a directory', 'utf-8');
		mockUserDataPath = blockingFile;

		expect(() => ensureShellIntegrationFiles()).not.toThrow();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to write shell integration loader files'),
			expect.any(String)
		);
	});
});
