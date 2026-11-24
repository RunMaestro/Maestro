/**
 * Tests for scripts/lib/rebuild-command.mjs (used by scripts/ensure-native-runtime.mjs).
 *
 * On Windows, cmd.exe resolves %~dp0 to cwd when a bare batch name on PATH
 * is quoted ("npm.cmd"), causing npm-cli.js lookup to fail under the repo
 * root. Only commands with a path separator may be quoted.
 */
import { describe, expect, it } from 'vitest';
import { buildRebuildSpawn } from '../../../scripts/lib/rebuild-command.mjs';

describe('buildRebuildSpawn', () => {
	it('leaves bare npm.cmd unquoted on Windows so cmd.exe resolves %~dp0 from PATH', () => {
		expect(
			buildRebuildSpawn('node', {
				moduleName: 'better-sqlite3',
				win32: true,
				rootDir: 'D:\\a\\Maestro\\Maestro',
			})
		).toEqual({
			command: 'npm.cmd rebuild better-sqlite3',
			args: [],
			shell: true,
		});
	});

	it('quotes electron-rebuild.cmd on Windows so paths with spaces work', () => {
		expect(
			buildRebuildSpawn('electron', {
				moduleName: 'better-sqlite3',
				win32: true,
				rootDir: 'C:\\Users\\Dev User\\Maestro',
			})
		).toEqual({
			command:
				'"C:\\Users\\Dev User\\Maestro\\node_modules\\.bin\\electron-rebuild.cmd" -f -w better-sqlite3',
			args: [],
			shell: true,
		});
	});

	it('builds direct argv invocations without shell on POSIX', () => {
		expect(
			buildRebuildSpawn('node', {
				moduleName: 'better-sqlite3',
				win32: false,
				rootDir: '/repo',
			})
		).toEqual({
			command: 'npm',
			args: ['rebuild', 'better-sqlite3'],
			shell: false,
		});

		expect(
			buildRebuildSpawn('electron', {
				moduleName: 'better-sqlite3',
				win32: false,
				rootDir: '/repo',
			})
		).toEqual({
			command: '/repo/node_modules/.bin/electron-rebuild',
			args: ['-f', '-w', 'better-sqlite3'],
			shell: false,
		});
	});
});
