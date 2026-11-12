/**
 * The packaged-app smoke test gates releases on the app actually starting.
 * These tests pin its pure parts: where it looks for each platform's
 * executable, how it reads flags, and what counts as a healthy renderer.
 * Release CI runs the launch itself against the real package.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
	DEFAULTS,
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
	])('runs %s after packaging and before the upload', (smoke, packageStep, upload) => {
		const at = index(smoke);
		expect(at, smoke).toBeGreaterThan(index(packageStep));
		expect(at).toBeLessThan(index(upload));
		expect(steps[at].run).toContain('npm run smoke:packaged');
	});
});
