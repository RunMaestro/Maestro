/**
 * @file bundle-export.test.ts
 * @description `maestro-cli bundle export` from disk (--data-dir): a Cue
 * config that `bundle validate` would reject is refused with exit 1, and no
 * bundle is written. The refusal itself is covered in cue-bundle-exporter.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { bundleExport } from '../../../cli/commands/bundle';

let tmp: string;
let dataDir: string;
let outputPath: string;
let logSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;

const stdout = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const stderr = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

/** One agent whose cue.yaml holds the given subscriptions of pipeline "Nightly". */
function seed(subscriptions: Array<Record<string, unknown>>): void {
	const root = path.join(tmp, 'work');
	fs.mkdirSync(path.join(root, '.maestro'), { recursive: true });
	fs.writeFileSync(
		path.join(root, '.maestro/cue.yaml'),
		yaml.dump({
			subscriptions: subscriptions.map((sub) => ({ pipeline_name: 'Nightly', ...sub })),
		})
	);
	fs.writeFileSync(
		path.join(dataDir, 'maestro-sessions.json'),
		JSON.stringify({
			sessions: [{ id: 'agent-1', name: 'Planner', toolType: 'codex', cwd: root }],
		})
	);
}

const commandFanIn = {
	name: 'gather',
	event: 'agent.completed',
	agent_id: 'agent-1',
	source_session: ['Planner', 'Other'],
	action: 'command',
	command: { mode: 'shell', shell: 'echo done' },
};

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bundle-export-')));
	dataDir = path.join(tmp, 'data');
	fs.mkdirSync(dataDir);
	outputPath = path.join(tmp, 'out', 'nightly.zip');
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('bundle export of a config bundle validate would reject', () => {
	it('exits 1, names the subscription, and writes no file', async () => {
		seed([commandFanIn]);
		await expect(
			bundleExport('0.18.6', { pipeline: 'Nightly', dataDir, output: outputPath })
		).rejects.toThrow('__exit__');
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(stderr()).toContain('Refusing to export');
		expect(stderr()).toContain(
			'[cue-config-invalid] workspace "work": Subscription "gather": "source_sub" is required'
		);
		expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
	});

	it('reports BUNDLE_INVALID and every issue in JSON', async () => {
		seed([commandFanIn]);
		await expect(
			bundleExport('0.18.6', { pipeline: 'Nightly', dataDir, output: outputPath, json: true })
		).rejects.toThrow('__exit__');
		expect(exitSpy).toHaveBeenCalledWith(1);
		const payload = JSON.parse(stdout().split('\n')[0]);
		expect(payload).toMatchObject({
			success: false,
			code: 'BUNDLE_INVALID',
			details: {
				errors: [
					{
						code: 'cue-config-invalid',
						file: 'workspaces/work/.maestro/cue.yaml',
						message: expect.stringContaining('Subscription "gather"'),
					},
				],
			},
		});
		expect(fs.existsSync(outputPath)).toBe(false);
	});

	it('exports the same pipeline once the subscription names its source_sub', async () => {
		seed([
			{
				name: 'upstream',
				event: 'time.heartbeat',
				agent_id: 'agent-1',
				interval_minutes: 60,
				prompt: 'plan',
			},
			{ ...commandFanIn, source_session: 'Planner', source_sub: 'upstream' },
		]);
		await bundleExport('0.18.6', { pipeline: 'Nightly', dataDir, output: outputPath });
		expect(exitSpy).not.toHaveBeenCalled();
		expect(fs.existsSync(outputPath)).toBe(true);
	});
});
