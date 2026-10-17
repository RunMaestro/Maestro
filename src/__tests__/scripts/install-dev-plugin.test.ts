/**
 * scripts/install-dev-plugin.mjs copies examples/plugins/<id>/ into a real
 * plugins directory for manual testing and Phase 01 automation. These tests
 * pin its two install modes, that it refuses to write anywhere by default,
 * that a second run replaces (never merges with) the previous copy, and that
 * it never follows a symlink in the source tree.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	devUserDataDir,
	installPlugin,
	main,
	parseArgs,
	USAGE,
} from '../../../scripts/install-dev-plugin.mjs';

const PLUGIN_ID = 'maestro-kanban';

describe('install-dev-plugin', () => {
	let sandbox: string;

	beforeEach(() => {
		sandbox = mkdtempSync(path.join(tmpdir(), 'install-dev-plugin-'));
	});

	afterEach(() => {
		rmSync(sandbox, { recursive: true, force: true });
	});

	describe('parseArgs', () => {
		it('accepts --dest with an id', () => {
			expect(parseArgs([PLUGIN_ID, '--dest', '/tmp/x'])).toEqual({
				id: PLUGIN_ID,
				dest: '/tmp/x',
				devData: false,
			});
		});

		it('accepts --dev-data with an id', () => {
			expect(parseArgs([PLUGIN_ID, '--dev-data'])).toEqual({
				id: PLUGIN_ID,
				dest: undefined,
				devData: true,
			});
		});

		it('reports neither flag as valid parse (the caller decides it needs usage)', () => {
			expect(parseArgs([PLUGIN_ID])).toEqual({
				id: PLUGIN_ID,
				dest: undefined,
				devData: false,
			});
		});

		it('errors on an id that could escape the destination directory', () => {
			expect(parseArgs(['../escape', '--dest', '/tmp/x']).error).toMatch(/not a safe plugin id/);
			expect(parseArgs(['a/b', '--dev-data']).error).toMatch(/not a safe plugin id/);
		});

		it('errors when both --dest and --dev-data are given', () => {
			expect(parseArgs([PLUGIN_ID, '--dest', '/tmp/x', '--dev-data']).error).toMatch(
				/cannot both be given/
			);
		});

		it('errors on a missing or extra positional', () => {
			expect(parseArgs([]).error).toMatch(/Expected exactly one plugin id/);
			expect(parseArgs([PLUGIN_ID, 'extra']).error).toMatch(/Expected exactly one plugin id/);
		});

		it('errors when --dest has no value', () => {
			expect(parseArgs([PLUGIN_ID, '--dest']).error).toMatch(/--dest needs a directory/);
		});
	});

	describe('devUserDataDir', () => {
		it('redirects to the maestro-dev sibling on each platform', () => {
			expect(devUserDataDir({}, 'darwin', '/Users/test')).toBe(
				path.join('/Users/test', 'Library', 'Application Support', 'maestro-dev')
			);
			expect(devUserDataDir({}, 'linux', '/home/test')).toBe(
				path.join('/home/test', '.config', 'maestro-dev')
			);
			expect(
				devUserDataDir(
					{ APPDATA: path.join('C:', 'Users', 'test', 'AppData', 'Roaming') },
					'win32',
					'C:\\Users\\test'
				)
			).toBe(path.join('C:', 'Users', 'test', 'AppData', 'Roaming', 'maestro-dev'));
		});

		it('honors XDG_CONFIG_HOME on linux', () => {
			expect(devUserDataDir({ XDG_CONFIG_HOME: '/custom/config' }, 'linux', '/home/test')).toBe(
				path.join('/custom/config', 'maestro-dev')
			);
		});
	});

	describe('installPlugin', () => {
		it('copies the real maestro-kanban source into <destRoot>/<id>/', () => {
			const destRoot = path.join(sandbox, 'dest');
			const dest = installPlugin({ id: PLUGIN_ID, destRoot });

			expect(dest).toBe(path.join(destRoot, PLUGIN_ID));
			expect(existsSync(path.join(dest, 'plugin.json'))).toBe(true);
			expect(existsSync(path.join(dest, 'main.js'))).toBe(true);
			expect(existsSync(path.join(dest, 'panel.html'))).toBe(true);

			const source = readFileSync(
				path.join(process.cwd(), 'examples', 'plugins', PLUGIN_ID, 'plugin.json'),
				'utf-8'
			);
			expect(readFileSync(path.join(dest, 'plugin.json'), 'utf-8')).toBe(source);
		});

		it('deletes a previous copy before writing the new one', () => {
			const destRoot = path.join(sandbox, 'dest');
			const dest = installPlugin({ id: PLUGIN_ID, destRoot });
			writeFileSync(path.join(dest, 'stale-marker.txt'), 'stale');

			installPlugin({ id: PLUGIN_ID, destRoot });

			expect(existsSync(path.join(dest, 'stale-marker.txt'))).toBe(false);
			expect(existsSync(path.join(dest, 'plugin.json'))).toBe(true);
		});

		it('never copies a symlink from the source tree', () => {
			const srcRoot = path.join(sandbox, 'src');
			const fakeSrc = path.join(srcRoot, 'fake-plugin');
			mkdirSync(fakeSrc, { recursive: true });
			writeFileSync(path.join(fakeSrc, 'plugin.json'), '{}');
			const outsideTarget = path.join(sandbox, 'outside.txt');
			writeFileSync(outsideTarget, 'secret');
			symlinkSync(outsideTarget, path.join(fakeSrc, 'linked.txt'));

			const destRoot = path.join(sandbox, 'dest');
			const dest = installPlugin({ id: 'fake-plugin', destRoot, srcRoot });

			expect(existsSync(path.join(dest, 'plugin.json'))).toBe(true);
			expect(existsSync(path.join(dest, 'linked.txt'))).toBe(false);
		});

		it('throws for an id with no matching examples/plugins/<id> source', () => {
			expect(() =>
				installPlugin({ id: 'no-such-plugin', destRoot: path.join(sandbox, 'dest') })
			).toThrow(/no plugin source at/);
		});
	});

	describe('main', () => {
		it('--dest installs and prints the destination path', () => {
			const destRoot = path.join(sandbox, 'dest');
			const writes: string[] = [];
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = ((chunk: string) => {
				writes.push(chunk);
				return true;
			}) as typeof process.stdout.write;

			let status: number;
			try {
				status = main([PLUGIN_ID, '--dest', destRoot]);
			} finally {
				process.stdout.write = originalWrite;
			}

			const expectedDest = path.join(destRoot, PLUGIN_ID);
			expect(status).toBe(0);
			expect(writes.join('')).toBe(`${expectedDest}\n`);
			expect(existsSync(path.join(expectedDest, 'plugin.json'))).toBe(true);
			expect(lstatSync(expectedDest).isSymbolicLink()).toBe(false);
		});

		it('exits non-zero and writes nothing with neither flag', () => {
			const destRoot = path.join(sandbox, 'dest');
			const status = main([PLUGIN_ID]);

			expect(status).toBe(1);
			expect(existsSync(destRoot)).toBe(false);
		});

		it('prints usage text on the no-flags path', () => {
			const writes: string[] = [];
			const originalWrite = process.stderr.write.bind(process.stderr);
			process.stderr.write = ((chunk: string) => {
				writes.push(chunk);
				return true;
			}) as typeof process.stderr.write;

			let status: number;
			try {
				status = main([PLUGIN_ID]);
			} finally {
				process.stderr.write = originalWrite;
			}

			expect(status).toBe(1);
			expect(writes.join('')).toContain(USAGE);
		});

		it('exits non-zero on a parse error without touching the filesystem', () => {
			const destRoot = path.join(sandbox, 'dest');
			const status = main(['../escape', '--dest', destRoot]);

			expect(status).toBe(1);
			expect(existsSync(destRoot)).toBe(false);
		});
	});
});
