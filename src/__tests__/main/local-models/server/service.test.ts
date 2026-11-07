/**
 * @file service.test.ts
 *
 * The model server as the card and the CLI see it, with the supervisor, the
 * engine store and the installer mocked. What is pinned: the report joins the
 * status, the installed engine and the loaded models without starting anything;
 * the build list follows the platform; an engine install joins a second request
 * for the same build, refuses a different one and an unknown one, broadcasts
 * its progress, and stops a running server only right before the swap, starting
 * it again after; a settings change is validated before it reaches the store.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ModelServerStatus } from '../../../../shared/local-models/model-server';
import { QWEN3_1_7B_ID } from '../../../../shared/local-models/model-catalog';

const STOPPED: ModelServerStatus = {
	state: 'stopped',
	port: 47811,
	bind: 'local',
	host: '127.0.0.1',
	baseUrl: 'http://127.0.0.1:47811',
	maxModels: 1,
	pid: null,
	startedAt: null,
	restarts: 0,
	lastError: null,
	models: [],
	loadedModels: [],
	keyStorage: 'os',
	logPath: '/data/logs/model-server.log',
};

const supervisor = vi.hoisted(() => ({
	getModelServerStatus: vi.fn(),
	startModelServer: vi.fn(),
	stopModelServer: vi.fn(),
	updateModelServerConfig: vi.fn(),
}));
vi.mock('../../../../main/local-models/server/supervisor', () => supervisor);

const store = vi.hoisted(() => ({
	readServerEngineManifest: vi.fn(),
	isServerEngineInstalled: vi.fn(),
	isServerEngineStale: vi.fn(),
}));
vi.mock('../../../../main/local-models/server/engine-store', () => store);

const installer = vi.hoisted(() => ({ installServerEngine: vi.fn() }));
vi.mock('../../../../main/local-models/server/engine-installer', () => installer);

import {
	getModelServerReport,
	installModelServerEngine,
	modelServerBuildOptions,
	modelServerLoadedModels,
	onModelServerEngineProgress,
	resetModelServerServiceForTests,
	updateModelServerConfigRequest,
} from '../../../../main/local-models/server/service';
import { ModelServerError } from '../../../../main/local-models/errors';

const MANIFEST = {
	release: 'b11559',
	platform: 'darwin-arm64',
	choice: 'default',
	kind: 'metal',
	label: 'Metal',
	assets: [],
	binary: 'llama-server',
	installedAt: 1,
	bytes: 40_000_000,
	accelerator: {
		checkedAt: 1,
		status: 'gpu',
		label: 'Metal (Apple M5 Max)',
		devices: [],
		problem: null,
		detail: null,
		offerCpuBuild: false,
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	resetModelServerServiceForTests();
	supervisor.getModelServerStatus.mockResolvedValue(STOPPED);
	supervisor.startModelServer.mockResolvedValue({ ...STOPPED, state: 'running' });
	supervisor.stopModelServer.mockResolvedValue(STOPPED);
	supervisor.updateModelServerConfig.mockResolvedValue(STOPPED);
	store.readServerEngineManifest.mockResolvedValue(MANIFEST);
	store.isServerEngineInstalled.mockResolvedValue(true);
	store.isServerEngineStale.mockResolvedValue(false);
	installer.installServerEngine.mockResolvedValue(MANIFEST);
});

describe('modelServerBuildOptions', () => {
	it('lists the platform builds, default first, with download sizes', () => {
		const linux = modelServerBuildOptions('linux', 'x64');
		expect(linux.map((option) => option.choice)).toEqual(['default', 'cpu', 'cuda', 'rocm']);
		expect(linux[0].kind).toBe('vulkan');
		for (const option of linux) expect(option.downloadBytes).toBeGreaterThan(0);

		expect(modelServerBuildOptions('darwin', 'arm64').map((option) => option.choice)).toEqual([
			'default',
		]);
		expect(modelServerBuildOptions('freebsd', 'x64')).toEqual([]);
	});
});

describe('modelServerLoadedModels', () => {
	it('names each loaded model and approximates its memory by its weights file', () => {
		const [qwen, unknown] = modelServerLoadedModels([QWEN3_1_7B_ID, 'not-a-model']);
		expect(qwen.displayName).not.toBe(QWEN3_1_7B_ID);
		expect(qwen.approxBytes).toBeGreaterThan(1_000_000_000);
		expect(unknown).toEqual({ id: 'not-a-model', displayName: 'not-a-model', approxBytes: 0 });
	});
});

describe('getModelServerReport', () => {
	it('joins the status, the installed engine and the loaded models, starting nothing', async () => {
		supervisor.getModelServerStatus.mockResolvedValue({
			...STOPPED,
			state: 'running',
			loadedModels: [QWEN3_1_7B_ID],
		});

		const report = await getModelServerReport();

		expect(report.status.state).toBe('running');
		expect(report.engine).toMatchObject({
			installed: true,
			stale: false,
			release: 'b11559',
			choice: 'default',
			label: 'Metal',
			bytes: 40_000_000,
		});
		expect(report.engine.accelerator?.label).toBe('Metal (Apple M5 Max)');
		expect(report.loaded.map((model) => model.id)).toEqual([QWEN3_1_7B_ID]);
		expect(report.installing).toBeNull();
		expect(supervisor.startModelServer).not.toHaveBeenCalled();
		expect(installer.installServerEngine).not.toHaveBeenCalled();
	});

	it('reports a missing engine with no stale build', async () => {
		store.readServerEngineManifest.mockResolvedValue(null);
		store.isServerEngineInstalled.mockResolvedValue(false);

		const { engine } = await getModelServerReport();

		expect(engine).toMatchObject({
			installed: false,
			stale: false,
			release: null,
			choice: null,
			accelerator: null,
			bytes: 0,
		});
		expect(store.isServerEngineStale).not.toHaveBeenCalled();
	});
});

describe('installModelServerEngine', () => {
	it('refuses an unknown build by name before downloading', async () => {
		await expect(installModelServerEngine('metal')).rejects.toThrow(/not a model server build/);
		expect(installer.installServerEngine).not.toHaveBeenCalled();
	});

	it('passes the installer error through, naming the platform and choice', async () => {
		installer.installServerEngine.mockRejectedValue(
			new Error('There is no "cuda" model server build for darwin-arm64.')
		);
		await expect(installModelServerEngine('cuda')).rejects.toThrow(/no "cuda" model server build/);
	});

	it('joins a second request for the same build and refuses a different one', async () => {
		let finish!: () => void;
		installer.installServerEngine.mockImplementation(
			() => new Promise((resolve) => (finish = () => resolve(MANIFEST)))
		);

		const first = installModelServerEngine('cpu');
		const second = installModelServerEngine('cpu');
		await expect(installModelServerEngine('default')).rejects.toBeInstanceOf(ModelServerError);
		finish();

		await Promise.all([first, second]);
		expect(installer.installServerEngine).toHaveBeenCalledTimes(1);
		expect(installer.installServerEngine.mock.calls[0][0]).toBe('cpu');
	});

	it('broadcasts progress with the choice and shows it in the report while it runs', async () => {
		const seen: unknown[] = [];
		onModelServerEngineProgress((progress) => seen.push(progress));
		let finish!: () => void;
		installer.installServerEngine.mockImplementation(async (_choice, options) => {
			options.onProgress({ phase: 'downloading', bytes: 5, totalBytes: 10 });
			await new Promise<void>((resolve) => (finish = resolve));
			options.onProgress({ phase: 'done', bytes: 10, totalBytes: 10 });
			return MANIFEST;
		});

		const install = installModelServerEngine('default');
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect((await getModelServerReport()).installing).toEqual({
			choice: 'default',
			phase: 'downloading',
			bytes: 5,
			totalBytes: 10,
		});
		finish();
		const report = await install;

		expect(seen).toEqual([
			{ choice: 'default', phase: 'downloading', bytes: 5, totalBytes: 10 },
			{ choice: 'default', phase: 'done', bytes: 10, totalBytes: 10 },
		]);
		expect(report.installing).toBeNull();
	});

	it('stops a running server only right before the swap, then starts it again', async () => {
		const order: string[] = [];
		supervisor.getModelServerStatus.mockResolvedValue({ ...STOPPED, state: 'running' });
		supervisor.stopModelServer.mockImplementation(async () => {
			order.push('stop');
			return STOPPED;
		});
		supervisor.startModelServer.mockImplementation(async () => {
			order.push('start');
			return { ...STOPPED, state: 'running' };
		});
		installer.installServerEngine.mockImplementation(async (_choice, options) => {
			order.push('download');
			await options.beforePromote();
			order.push('promote');
			return MANIFEST;
		});

		await installModelServerEngine('default');

		expect(order).toEqual(['download', 'stop', 'promote', 'start']);
	});

	it('leaves a stopped server stopped', async () => {
		installer.installServerEngine.mockImplementation(async (_choice, options) => {
			await options.beforePromote();
			return MANIFEST;
		});

		await installModelServerEngine('default');

		expect(supervisor.stopModelServer).not.toHaveBeenCalled();
		expect(supervisor.startModelServer).not.toHaveBeenCalled();
	});

	it('keeps the install when the restart afterwards fails, for the report to show', async () => {
		supervisor.getModelServerStatus.mockResolvedValue({ ...STOPPED, state: 'running' });
		supervisor.startModelServer.mockRejectedValue(new Error('port in use'));
		installer.installServerEngine.mockImplementation(async (_choice, options) => {
			await options.beforePromote();
			return MANIFEST;
		});

		await expect(installModelServerEngine('default')).resolves.toBeDefined();
	});
});

describe('updateModelServerConfigRequest', () => {
	it('passes a valid patch to the supervisor', async () => {
		await updateModelServerConfigRequest({ bind: 'network', maxModels: 2, rotateKey: true });
		expect(supervisor.updateModelServerConfig).toHaveBeenCalledWith({
			bind: 'network',
			maxModels: 2,
			rotateKey: true,
		});
	});

	it.each([[null], ['network'], [[1]], [{ rotateKey: 'yes' }]])(
		'refuses %o without touching the supervisor',
		async (patch) => {
			await expect(updateModelServerConfigRequest(patch)).rejects.toBeInstanceOf(ModelServerError);
			expect(supervisor.updateModelServerConfig).not.toHaveBeenCalled();
		}
	);
});
