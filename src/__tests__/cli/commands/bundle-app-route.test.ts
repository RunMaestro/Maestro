/**
 * @file bundle-app-route.test.ts
 * @description With the desktop app running and no --data-dir,
 * `maestro-cli bundle export|import` go through the app (the same service as
 * the Cue modal's Bundles tab) instead of the disk. The bridge is mocked; the
 * service itself is covered in cue-bundle-service.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const sendCommand = vi.fn();
let appRunning = true;

vi.mock('../../../shared/cli-server-discovery', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../shared/cli-server-discovery')>()),
	isCliServerRunning: () => appRunning,
}));

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: async (fn: (client: { sendCommand: typeof sendCommand }) => unknown) =>
		fn({ sendCommand }),
}));

import { bundleExport, bundleImport } from '../../../cli/commands/bundle';

const AGENT_ID = 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f607';

let tmp: string;
let savedUserData: string | undefined;
let logSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;

const stdout = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const stderr = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

function plan(overrides: Record<string, unknown> = {}) {
	return {
		bundle: { name: 'Nightly', kind: 'maestro-pipeline', producerVersion: '0.18.6' },
		dataDir: '/app/data',
		createDataDir: false,
		agents: [
			{
				id: AGENT_ID,
				name: 'Reviewer',
				toolType: 'claude-code',
				workspace: 'web',
				cwd: '/w',
				action: 'create',
			},
		],
		files: [],
		cueConfigs: [],
		agentPaths: [],
		shellCommands: [],
		env: [],
		secrets: [],
		conflicts: [],
		warnings: [],
		...overrides,
	};
}

beforeEach(() => {
	appRunning = true;
	sendCommand.mockReset();
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bundle-app-')));
	savedUserData = process.env.MAESTRO_USER_DATA;
	process.env.MAESTRO_USER_DATA = tmp;
	fs.writeFileSync(
		path.join(tmp, 'maestro-sessions.json'),
		JSON.stringify({
			sessions: [{ id: AGENT_ID, name: 'Reviewer', toolType: 'claude-code', cwd: tmp }],
		})
	);
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	if (savedUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = savedUserData;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('bundle export through the running app', () => {
	it('sends the resolved agent, an absolute output path and the asset choice', async () => {
		const output = path.join(tmp, 'out.zip');
		sendCommand.mockResolvedValue({
			type: 'cue_bundle_export_result',
			outcome: {
				ok: true,
				outputPath: output,
				size: 10,
				sha256: 'abc',
				manifest: {
					kind: 'maestro-agent',
					name: 'Reviewer',
					agents: [{}],
					workspaces: [{}],
					files: [],
					requirements: { events: [], tools: [], secrets: ['GITHUB_TOKEN'] },
				},
			},
		});

		await bundleExport('0.18.6', { agent: 'Reviewer', output, claudeMemory: false });

		expect(sendCommand).toHaveBeenCalledWith(
			{
				type: 'cue_bundle_export',
				request: expect.objectContaining({
					agent: 'Reviewer',
					outputPath: output,
					claudeAssets: { skills: true, mcp: true, memory: false },
				}),
			},
			'cue_bundle_export_result',
			expect.any(Number)
		);
		expect(stdout()).toContain(`Exported agent "Reviewer" to ${output}`);
		expect(stdout()).toContain('Secrets to set on import: GITHUB_TOKEN');
	});

	it('lets the app resolve an agent this data directory does not have', async () => {
		// A desktop with a custom sync folder keeps its agents elsewhere.
		fs.writeFileSync(path.join(tmp, 'maestro-sessions.json'), JSON.stringify({ sessions: [] }));
		sendCommand.mockResolvedValue({
			type: 'cue_bundle_export_result',
			outcome: { ok: false, code: 'AGENT_NOT_FOUND', message: 'Agent not found: Synced' },
		});
		await expect(bundleExport('0.18.6', { agent: 'Synced', json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(sendCommand).toHaveBeenCalledWith(
			{
				type: 'cue_bundle_export',
				request: expect.objectContaining({
					agent: 'Synced',
					outputPath: path.resolve('synced.maestro-bundle.zip'),
				}),
			},
			'cue_bundle_export_result',
			expect.any(Number)
		);
	});

	it('exits 1 with the code the app returned', async () => {
		sendCommand.mockResolvedValue({
			type: 'cue_bundle_export_result',
			outcome: { ok: false, code: 'EXPORT_FAILED', message: 'Pipeline not found: Nope' },
		});
		await expect(bundleExport('0.18.6', { pipeline: 'Nope', json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(exitSpy).toHaveBeenCalledWith(1);
		// The first line is what a script reads; the real process exits there.
		expect(JSON.parse(stdout().split('\n')[0])).toMatchObject({
			success: false,
			code: 'EXPORT_FAILED',
		});
	});

	it('reads the disk when --data-dir is given, even with the app running', async () => {
		await expect(
			bundleExport('0.18.6', { pipeline: 'Nope', dataDir: tmp, json: true })
		).rejects.toThrow('__exit__');
		expect(sendCommand).not.toHaveBeenCalled();
		expect(JSON.parse(stdout()).error).toContain('Pipeline not found');
	});
});

describe('bundle import through the running app', () => {
	const bundlePath = () => path.join(tmp, 'b.zip');

	it('sends absolute paths and reports the plan as imported into the app', async () => {
		sendCommand.mockResolvedValue({
			type: 'cue_bundle_import_result',
			outcome: { ok: true, applied: true, plan: plan() },
		});

		await bundleImport('0.18.6', bundlePath(), { workspace: ['web=./web'] });

		expect(sendCommand).toHaveBeenCalledWith(
			{
				type: 'cue_bundle_import',
				request: {
					bundlePath: bundlePath(),
					workspaces: { web: path.resolve('./web') },
					force: undefined,
					refuseShellCommands: undefined,
					dryRun: undefined,
				},
			},
			'cue_bundle_import_result',
			expect.any(Number)
		);
		expect(stdout()).toContain('Imported pipeline "Nightly" into the running Maestro app');
		expect(stdout()).toContain('Reviewer (claude-code) new');
	});

	it('previews the plan with a dry run and prints its shell commands before the app writes', async () => {
		const shellCommands = [{ workspace: 'web', subscription: 'cleanup', command: 'rm -rf build' }];
		const printedBeforeWrite: string[] = [];
		sendCommand.mockImplementation(async (message: { request: { dryRun?: boolean } }) => {
			if (!message.request.dryRun) printedBeforeWrite.push(stdout());
			return {
				type: 'cue_bundle_import_result',
				outcome: { ok: true, applied: !message.request.dryRun, plan: plan({ shellCommands }) },
			};
		});

		await bundleImport('0.18.6', bundlePath(), { workspace: ['web=/w'] });

		expect(sendCommand.mock.calls.map((c) => c[0].request.dryRun)).toEqual([true, undefined]);
		expect(printedBeforeWrite).toHaveLength(1);
		expect(printedBeforeWrite[0]).toContain(
			'Importing pipeline "Nightly" into the running Maestro app'
		);
		expect(printedBeforeWrite[0]).toContain('web / cleanup: rm -rf build');
		expect(stdout()).toContain('Imported pipeline "Nightly" into the running Maestro app');
		expect(stdout()).not.toContain('The bundle changed after the preview');
	});

	it('marks JSON output as going through the app', async () => {
		sendCommand.mockResolvedValue({
			type: 'cue_bundle_import_result',
			outcome: { ok: true, applied: false, plan: plan() },
		});
		await bundleImport('0.18.6', bundlePath(), { workspace: ['web=/w'], dryRun: true, json: true });
		expect(JSON.parse(stdout())).toMatchObject({
			success: true,
			applied: false,
			dryRun: true,
			via: 'app',
		});
	});

	it('prints the conflicts the app refused on, and exits 1', async () => {
		sendCommand.mockResolvedValue({
			type: 'cue_bundle_import_result',
			outcome: {
				ok: false,
				code: 'CONFLICTS',
				message: 'The import conflicts with existing data in 1 place. Pass force to overwrite.',
				details: { conflicts: [{ kind: 'agent', target: AGENT_ID, message: 'Agent exists' }] },
			},
		});
		await expect(bundleImport('0.18.6', bundlePath(), { workspace: ['web=/w'] })).rejects.toThrow(
			'__exit__'
		);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(stderr()).toContain('[agent] Agent exists');
		expect(stderr()).toContain('--force');
	});

	it('refuses --agent-path, which the app keeps in Settings, with exit 2', async () => {
		await expect(
			bundleImport('0.18.6', bundlePath(), {
				workspace: ['web=/w'],
				agentPath: ['claude-code=/usr/local/bin/claude'],
				json: true,
			})
		).rejects.toThrow('__exit__');
		expect(exitSpy).toHaveBeenCalledWith(2);
		expect(sendCommand).not.toHaveBeenCalled();
		expect(JSON.parse(stdout())).toMatchObject({ code: 'INVALID_OPTIONS' });
	});

	it('imports from disk when the app is not running', async () => {
		appRunning = false;
		await expect(
			bundleImport('0.18.6', bundlePath(), { workspace: ['web=/w'], json: true })
		).rejects.toThrow('__exit__');
		expect(sendCommand).not.toHaveBeenCalled();
		expect(JSON.parse(stdout())).toMatchObject({ code: 'BUNDLE_UNREADABLE' });
	});
});
