/**
 * Every Playwright spec that starts Maestro must point it at a throwaway data
 * directory, or it runs against, and writes to, the real agents, groups and
 * settings. Redirecting HOME is not isolation: on macOS Electron derives
 * `userData` from the account's home directory and ignores `$HOME`, which is how
 * e2e/bionify-reading-mode.spec.ts came to overwrite the real stores.
 *
 * The specs need a built app and a display, so the unit run cannot execute
 * them. These checks read their source instead, and pin the shared isolation
 * (e2e/fixtures/isolation.ts) to what the app reads.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { FIRST_RUN_SEEN_SETTINGS, isolatedLaunchEnv } from '../../../e2e/fixtures/isolation';
import { ONBOARDING_STEP_FLAGS } from '../../shared/onboardingSeries';

const e2eDir = path.resolve(__dirname, '../../../e2e');

/** Every TypeScript file under `dir`. */
function e2eSources(dir: string = e2eDir): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return e2eSources(full);
		return entry.name.endsWith('.ts') ? [full] : [];
	});
}

/** Source without comments, so a comment that names the isolation cannot satisfy the check. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const STARTS_THE_APP = /\b(?:_electron|electron)\s*\.\s*launch\s*\(/;
const NAMES_THE_ISOLATION = /\bMAESTRO_DEMO_DIR\b|\bisolatedLaunchEnv\s*\(/;

/** Whether the source starts the app without pointing it at a throwaway data directory. */
function launchesWithoutIsolation(source: string): boolean {
	const code = stripComments(source);
	return STARTS_THE_APP.test(code) && !NAMES_THE_ISOLATION.test(code);
}

describe('launchesWithoutIsolation', () => {
	it('flags a spec that only redirects HOME, the old Bionify launch', () => {
		const source = `
			const launchEnv = { ...process.env, HOME: homeDir, NODE_ENV: 'test' };
			const app = await electron.launch({ args: [mainPath], env: launchEnv });
		`;
		expect(launchesWithoutIsolation(source)).toBe(true);
	});

	it('does not count a comment that names the isolation', () => {
		const source = `
			// This spec uses isolatedLaunchEnv() and MAESTRO_DEMO_DIR.
			/* MAESTRO_DEMO_DIR */
			const app = await _electron.launch({ args: [mainPath] });
		`;
		expect(launchesWithoutIsolation(source)).toBe(true);
	});

	it('accepts a launch that spreads the shared isolation', () => {
		const source = `
			const app = await electron.launch({
				args: [appPath],
				env: { ...process.env, ...isolatedLaunchEnv(testDataDir) },
			});
		`;
		expect(launchesWithoutIsolation(source)).toBe(false);
	});

	it('accepts a launch that sets the demo redirect itself', () => {
		const source = `
			const app = await electron.launch({
				args: [appPath],
				env: { ...process.env, MAESTRO_DEMO_DIR: dir },
			});
		`;
		expect(launchesWithoutIsolation(source)).toBe(false);
	});

	it('ignores a file that never starts the app', () => {
		expect(launchesWithoutIsolation(`export const x = process.env.HOME;`)).toBe(false);
	});
});

describe('e2e files that start Maestro', () => {
	const files = e2eSources().map((file) => ({
		name: path.relative(e2eDir, file).split(path.sep).join('/'),
		source: fs.readFileSync(file, 'utf8'),
	}));
	const launching = files.filter(({ source }) => STARTS_THE_APP.test(stripComments(source)));

	it('are found (a scan that matches nothing would pass for the wrong reason)', () => {
		const names = launching.map(({ name }) => name);
		expect(names).toContain('fixtures/electron-app.ts');
		expect(names).toContain('bionify-reading-mode.spec.ts');
	});

	it('all point the app at a throwaway data directory', () => {
		const offenders = launching
			.filter(({ source }) => launchesWithoutIsolation(source))
			.map(({ name }) => name);
		expect(
			offenders,
			'start Maestro without MAESTRO_DEMO_DIR or isolatedLaunchEnv() from e2e/fixtures/electron-app.ts'
		).toEqual([]);
	});
});

describe('shared e2e isolation', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it('sets exactly the variables the fixture always set', () => {
		expect(isolatedLaunchEnv('/isolated/data')).toEqual({
			MAESTRO_DEMO_DIR: '/isolated/data',
			MAESTRO_DATA_DIR: '/isolated/data',
			ELECTRON_DISABLE_GPU: '1',
			NODE_ENV: 'test',
			MAESTRO_E2E_TEST: 'true',
		});
	});

	it('names the redirect the app reads', async () => {
		vi.resetModules();
		vi.stubEnv('MAESTRO_DEMO_DIR', isolatedLaunchEnv('/isolated/data').MAESTRO_DEMO_DIR);
		const { DEMO_MODE, DEMO_DATA_PATH } = await import('../../main/constants');
		expect(DEMO_MODE).toBe(true);
		expect(DEMO_DATA_PATH).toBe('/isolated/data');
	});

	it('marks every first-run step as seen, and nothing else', () => {
		expect(Object.keys(FIRST_RUN_SEEN_SETTINGS).sort()).toEqual(
			[...Object.values(ONBOARDING_STEP_FLAGS), 'suppressWindowsWarning'].sort()
		);
		expect(Object.values(FIRST_RUN_SEEN_SETTINGS).every((seen) => seen === true)).toBe(true);
	});
});
