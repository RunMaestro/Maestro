/**
 * The packaged-app smoke test gates releases on the app actually starting.
 * These tests pin its pure parts: where it looks for each platform's
 * executable, how it reads flags, what counts as a healthy renderer, and
 * the stats-database line it requires from the app's output.
 * Release CI runs the launch itself against the real package.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
	DEFAULTS,
	assessAppOutput,
	assessProbe,
	defaultAppPath,
	parseArgs,
} from '../../../scripts/smoke-launch-packaged.mjs';

const root = path.resolve(__dirname, '../../..');
const healthy = { rootChildren: 1, hasBridge: true, errorBoundary: false };

describe('smoke-launch-packaged: defaultAppPath', () => {
	it.each([
		['darwin', 'arm64', 'release/mac-arm64/Maestro.app/Contents/MacOS/Maestro'],
		['darwin', 'x64', 'release/mac/Maestro.app/Contents/MacOS/Maestro'],
		['win32', 'x64', 'release/win-unpacked/Maestro.exe'],
		['linux', 'x64', 'release/linux-unpacked/maestro'],
	])('points %s/%s at electron-builder --dir output', (platform, arch, expected) => {
		expect(defaultAppPath(platform, arch)).toBe(path.join(root, expected));
	});
});

describe('smoke-launch-packaged: parseArgs', () => {
	it('uses the defaults with no flags', () => {
		expect(parseArgs([])).toEqual({ ...DEFAULTS, app: null });
	});

	it('reads seconds for the timeouts and keeps the app path as given', () => {
		expect(
			parseArgs([
				'--app',
				'x/Maestro.exe',
				'--port',
				'9444',
				'--ready-timeout',
				'30',
				'--settle',
				'5',
			])
		).toEqual({ app: 'x/Maestro.exe', port: 9444, readyTimeoutMs: 30_000, settleMs: 5_000 });
	});

	it('rejects unknown flags and non-numeric values', () => {
		expect(() => parseArgs(['--verbose'])).toThrow('Unknown argument: --verbose');
		expect(() => parseArgs(['--port', 'abc'])).toThrow('Invalid value for port');
	});
});

describe('smoke-launch-packaged: assessProbe', () => {
	it('passes a mounted, bridged renderer', () => {
		expect(assessProbe(healthy)).toEqual([]);
	});

	it('fails when no renderer page exists', () => {
		expect(assessProbe(null)).toEqual(['no app://app renderer page is open']);
	});

	it('names every way a renderer can be unhealthy', () => {
		expect(assessProbe({ rootChildren: 0, hasBridge: false, errorBoundary: true })).toEqual([
			'React did not mount into #root',
			'window.maestro (the preload bridge) is missing',
			'the renderer is showing the error boundary',
		]);
	});
});

describe('smoke-launch-packaged: assessAppOutput', () => {
	it('passes when the main process logged that the stats database opened', () => {
		expect(
			assessAppOutput(
				'[2026-11-17T12:00:00.000Z] [INFO] [Startup] Initializing stats database\n' +
					'[2026-11-17T12:00:00.050Z] [INFO] [Startup] Stats database initialized\n'
			)
		).toEqual([]);
	});

	it('fails when the stats database never opened, whatever the error text says', () => {
		const failure = [
			'the stats database (better-sqlite3) did not initialize: the app never logged "Stats database initialized"',
		];
		// A wrong-ABI addon: startup catches the error and keeps going.
		expect(
			assessAppOutput(
				'[ERROR] [Startup] Failed to initialize stats database: Error: The module ' +
					"'better_sqlite3.node' was compiled against a different Node.js version using " +
					'NODE_MODULE_VERSION 147. This version of Node.js requires NODE_MODULE_VERSION 145.\n' +
					'[WARN] [Startup] Continuing without stats - usage tracking will be unavailable\n'
			)
		).toEqual(failure);
		// No output at all (stdout lost, or the line was never reached).
		expect(assessAppOutput('')).toEqual(failure);
	});
});

describe('release workflow: packaged-app smoke test', () => {
	interface Step {
		name?: string;
		if?: string;
		run?: string;
	}
	const steps = (
		yaml.load(readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')) as {
			jobs: { build: { steps: Step[] } };
		}
	).jobs.build.steps;
	const index = (name: string) => steps.findIndex((s) => s.name === name);

	it.each([
		['Smoke test packaged app (Windows)', 'Package for Windows', 'Upload Windows artifacts'],
		['Smoke test packaged app (macOS arm64)', 'Package for macOS arm64', 'Upload macOS artifacts'],
		['Smoke test packaged app (macOS x64)', 'Package for macOS arm64', 'Upload macOS artifacts'],
		['Smoke test packaged app (Linux x64)', 'Package for Linux x64', 'Upload Linux x64 artifacts'],
		[
			'Smoke test packaged app (Linux ARM64)',
			'Package for Linux ARM64',
			'Upload Linux ARM64 artifacts',
		],
	])('runs %s after packaging and before the upload', (smoke, packageStep, upload) => {
		const at = index(smoke);
		expect(at, smoke).toBeGreaterThan(index(packageStep));
		expect(at).toBeLessThan(index(upload));
		expect(steps[at].run).toContain('npm run smoke:packaged');
	});

	it('gives the Linux smoke tests a virtual display', () => {
		for (const name of [
			'Smoke test packaged app (Linux x64)',
			'Smoke test packaged app (Linux ARM64)',
		]) {
			expect(steps[index(name)].run, name).toMatch(/^xvfb-run -a npm run smoke:packaged/);
		}
	});
});
