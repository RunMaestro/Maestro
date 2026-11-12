/**
 * scripts/clean-tsc-output.mjs runs at the head of every `build:main`, so a
 * stale `foo.js` from before a `foo.ts` -> `foo/index.ts` move cannot shadow
 * the directory (#1724). These tests pin what it deletes, what it must leave
 * for the other build steps, and that its folder list tracks tsconfig.main.json.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { cleanTscOutput, TSC_OUTPUT_DIRS } from '../../../scripts/clean-tsc-output.mjs';

const REPO_ROOT = path.join(__dirname, '../../..');

function plant(root: string, relative: string, content = 'x'): string {
	const file = path.join(root, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
	return file;
}

describe('clean-tsc-output', () => {
	let sandbox: string;
	let dist: string;

	beforeEach(() => {
		sandbox = mkdtempSync(path.join(tmpdir(), 'clean-tsc-output-'));
		dist = path.join(sandbox, 'dist');
	});

	afterEach(() => {
		rmSync(sandbox, { recursive: true, force: true });
	});

	it('removes a stale foo.js that would shadow foo/index.js', () => {
		const stale = plant(dist, 'main/web-server/handlers/messageHandlers.js');
		plant(dist, 'main/web-server/handlers/messageHandlers/index.js');
		plant(dist, 'shared/old.js');
		plant(dist, 'types/old.js');

		cleanTscOutput(dist);

		expect(existsSync(stale)).toBe(false);
		for (const dir of ['main', 'shared', 'types']) {
			expect(existsSync(path.join(dist, dir))).toBe(false);
		}
	});

	it('leaves the output of every other build step alone', () => {
		const kept = [
			'cli/maestro-cli.js',
			'cli/maestro-p.js',
			'cli/permission-relay-bridge.js',
			'renderer/index.html',
			'web-desktop/index.html',
			'build-provenance.json',
		].map((relative) => plant(dist, relative));
		const source = plant(sandbox, 'src/main/index.ts');
		plant(dist, 'main/index.js');

		cleanTscOutput(dist);

		for (const file of kept) {
			expect(existsSync(file)).toBe(true);
		}
		expect(readFileSync(source, 'utf-8')).toBe('x');
	});

	it('is a no-op when dist does not exist yet', () => {
		expect(() => cleanTscOutput(dist)).not.toThrow();
		expect(existsSync(dist)).toBe(false);
	});

	it('refuses a path that is not an absolute dist folder', () => {
		const source = plant(sandbox, 'src/main/index.ts');
		const main = plant(sandbox, 'main/keep.js');

		expect(() => cleanTscOutput('dist')).toThrow(/absolute/);
		expect(() => cleanTscOutput('')).toThrow(/absolute/);
		expect(() => cleanTscOutput(undefined as unknown as string)).toThrow(/absolute/);
		expect(() => cleanTscOutput(sandbox)).toThrow(/not a dist folder/);
		expect(() => cleanTscOutput(path.join(sandbox, 'src'))).toThrow(/not a dist folder/);
		expect(() => cleanTscOutput(path.parse(sandbox).root)).toThrow(/not a dist folder/);

		expect(existsSync(source)).toBe(true);
		expect(existsSync(main)).toBe(true);
	});

	it('cleans exactly the folders tsconfig.main.json emits into', () => {
		const configPath = path.join(REPO_ROOT, 'tsconfig.main.json');
		const { config, error } = ts.parseConfigFileTextToJson(
			configPath,
			readFileSync(configPath, 'utf-8')
		);
		expect(error).toBeUndefined();
		expect(config.compilerOptions.rootDir).toBe('src');
		expect(config.compilerOptions.outDir).toBe('dist');

		const roots = (config.include as string[]).map((glob) => {
			const match = /^src\/([^/*]+)\/\*\*\/\*$/.exec(glob);
			expect(match, `unexpected include glob ${glob}`).not.toBeNull();
			return match![1];
		});
		expect([...TSC_OUTPUT_DIRS].sort()).toEqual([...roots].sort());
	});
});
