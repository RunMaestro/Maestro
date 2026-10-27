vi.mock('../../../main/plugins/plugin-scan', async () => await import('../../helpers/pluginScan'));
/**
 * @file plugin-manager-hot-reload.test.ts
 * @description Refresh-driven plugin hot reload. Editing a runnable plugin's
 * manifest or code must rebuild the registry and restart only that plugin's
 * sandbox; removing the plugin must stop the stale sandbox and remove the
 * record. Real temp dir + real fs; MAESTRO_USER_DATA redirects plugin storage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));

vi.mock('electron', () => ({
	app: { getPath: () => os.tmpdir() },
	utilityProcess: { fork: forkMock },
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn().mockResolvedValue(undefined),
}));

import { PluginManager, type PluginSandboxLifecycle } from '../../../main/plugins/plugin-manager';
import { PluginSandboxHost } from '../../../main/plugins/plugin-sandbox-host';
import type { PermissionBroker } from '../../../main/plugins/permission-broker';
import { logger } from '../../../main/utils/logger';
import { captureException } from '../../../main/utils/sentry';
import { pluginsDir } from '../../../main/plugins/plugin-store-main';
import type { PluginManifest } from '../../../shared/plugins/plugin-manifest';
import { TRANSCRIPTION_CONTRACT } from '../../../shared/plugins/services';
import { makeSigningKeys, signPluginDir } from './plugin-signing-helper';

// FC1 Option-B gate: code only RUNS with a trusted signature, so every fixture
// write is followed by a re-sign with this test key (stale signature = invalid
// = never runs) and the manager registers the key as trusted.
const keys = makeSigningKeys();
const mandatoryRequirement = {
	id: 'voice',
	provider: 'example.media',
	service: 'transcription',
	contract: TRANSCRIPTION_CONTRACT,
	version: '^1.0.0',
};

/** Write and sign a code-plugin fixture, optionally declaring its service dependencies. */
function writeCodePlugin(
	id: string,
	options: {
		version?: string;
		entry?: string;
		code?: string;
		requires?: PluginManifest['requires'];
	} = {}
): void {
	const entry = options.entry ?? 'main.js';
	const dir = path.join(pluginsDir(), id);
	fs.mkdirSync(path.dirname(path.join(dir, entry)), { recursive: true });
	const manifest = {
		id,
		name: id,
		version: options.version ?? '1.0.0',
		tier: 1,
		entry,
		maestro: { minHostApi: '1.0.0' },
		requires: options.requires,
	};
	fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
	fs.writeFileSync(path.join(dir, entry), options.code ?? 'module.exports = "v1";');
	signPluginDir(dir, keys);
}

function makeSandbox(): PluginSandboxLifecycle {
	const running = new Set<string>();
	return {
		start: vi.fn((pluginId: string) => {
			running.add(pluginId);
		}),
		stop: vi.fn((pluginId: string) => {
			running.delete(pluginId);
		}),
		stopAll: vi.fn(() => {
			running.clear();
		}),
		isRunning: vi.fn((pluginId: string) => running.has(pluginId)),
		runningIds: vi.fn(() => Array.from(running)),
		invokeCommand: vi.fn(() => false),
		invokeTool: vi.fn(async () => undefined),
	};
}

async function enableRunnablePlugin(manager: PluginManager, sandbox: PluginSandboxLifecycle): void {
	await manager.refresh();
	await manager.setEnabled('demo', true);
	expect(sandbox.start).toHaveBeenCalledTimes(1);
	expect(sandbox.isRunning('demo')).toBe(true);
	vi.mocked(sandbox.start).mockClear();
	vi.mocked(sandbox.stop).mockClear();
}

let workDir: string;
let prevUserData: string | undefined;

beforeEach(() => {
	prevUserData = process.env.MAESTRO_USER_DATA;
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-hot-reload-'));
	process.env.MAESTRO_USER_DATA = path.join(workDir, 'userData');
});

afterEach(() => {
	if (prevUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = prevUserData;
	fs.rmSync(workDir, { recursive: true, force: true });
});

describe('PluginManager hot reload reconciliation', () => {
	it('refreshes a manifest edit and restarts the still-runnable sandbox', async () => {
		const sandbox = makeSandbox();
		const onChange = vi.fn();
		const manager = new PluginManager({
			isEnabled: () => true,
			sandbox,
			onChange,
			trustedKeys: () => [keys.publicKeyB64],
		});
		writeCodePlugin('demo');
		await enableRunnablePlugin(manager, sandbox);

		writeCodePlugin('demo', { version: '1.0.1', code: 'module.exports = "v1";' });
		await manager.refresh();
		await vi.waitFor(() => expect(sandbox.start).toHaveBeenCalledTimes(1));

		expect(
			manager.getRegistry().records.find((record) => record.id === 'demo')?.manifest?.version
		).toBe('1.0.1');
		expect(sandbox.stop).toHaveBeenCalledTimes(1);
		expect(sandbox.stop).toHaveBeenCalledWith('demo');
		expect(sandbox.start).toHaveBeenCalledTimes(1);
		expect(sandbox.start).toHaveBeenCalledWith('demo', path.join(pluginsDir(), 'demo'), 'main.js');
		expect(onChange).toHaveBeenCalled();
		expect(sandbox.isRunning('demo')).toBe(true);
	});

	it('refreshes a code edit and restarts the affected sandbox', async () => {
		const sandbox = makeSandbox();
		const manager = new PluginManager({
			isEnabled: () => true,
			sandbox,
			trustedKeys: () => [keys.publicKeyB64],
		});
		writeCodePlugin('demo');
		await enableRunnablePlugin(manager, sandbox);

		fs.writeFileSync(path.join(pluginsDir(), 'demo', 'main.js'), 'module.exports = "v2";');
		signPluginDir(path.join(pluginsDir(), 'demo'), keys);
		await manager.refresh();
		await vi.waitFor(() => expect(sandbox.start).toHaveBeenCalledTimes(1));

		expect(sandbox.stop).toHaveBeenCalledTimes(1);
		expect(sandbox.stop).toHaveBeenCalledWith('demo');
		expect(sandbox.start).toHaveBeenCalledTimes(1);
		expect(sandbox.start).toHaveBeenCalledWith('demo', path.join(pluginsDir(), 'demo'), 'main.js');
		expect(sandbox.isRunning('demo')).toBe(true);
	});

	it('refreshes removal by stopping the sandbox and dropping the stale registry record', async () => {
		const sandbox = makeSandbox();
		const manager = new PluginManager({
			isEnabled: () => true,
			sandbox,
			trustedKeys: () => [keys.publicKeyB64],
		});
		writeCodePlugin('demo');
		await enableRunnablePlugin(manager, sandbox);

		fs.rmSync(path.join(pluginsDir(), 'demo'), { recursive: true, force: true });
		await manager.refresh();

		expect(sandbox.stop).toHaveBeenCalledTimes(1);
		expect(sandbox.stop).toHaveBeenCalledWith('demo');
		expect(sandbox.start).not.toHaveBeenCalled();
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(manager.getRegistry().records.some((record) => record.id === 'demo')).toBe(false);
	});
});

describe('PluginManager hot reload with asynchronous sandbox shutdown', () => {
	let sandbox: PluginSandboxHost;
	let manager: PluginManager;
	let finishCleanup: () => void;
	let rejectCleanup: (error: Error) => void;
	let cleanup: Promise<void>;
	let pluginsEnabled: boolean;
	let servicesReady: boolean;

	beforeEach(async () => {
		pluginsEnabled = true;
		servicesReady = true;
		vi.mocked(logger.warn).mockClear();
		vi.mocked(captureException).mockClear();
		forkMock.mockReset();
		forkMock.mockImplementation(() =>
			Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() })
		);
		cleanup = new Promise<void>((resolve, reject) => {
			finishCleanup = resolve;
			rejectCleanup = reject;
		});
		sandbox = new PluginSandboxHost({
			broker: {} as PermissionBroker,
			handlers: {},
			onStop: vi
				.fn()
				.mockImplementationOnce(() => cleanup)
				.mockResolvedValue(undefined),
		});
		manager = new PluginManager({
			isEnabled: () => pluginsEnabled,
			sandbox,
			trustedKeys: () => [keys.publicKeyB64],
			serviceAvailable: () => servicesReady,
			// Production publishes registry changes through this dependency pass.
			onChange: () => manager.reconcileServiceDependencies(),
		});
		writeCodePlugin('demo');
		await manager.refresh();
		await manager.setEnabled('demo', true);
		expect(sandbox.isRunning('demo')).toBe(true);
	});

	afterEach(async () => {
		manager.stopAllSandboxes();
		const drain = sandbox.stopAll();
		for (const result of forkMock.mock.results) {
			if (result.type === 'return') result.value.emit('exit', 0);
		}
		finishCleanup();
		await drain;
	});

	it('resumes panel commands only after child exit and resource cleanup', async () => {
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		await manager.refresh();
		expect(manager.getRegistry().records[0].enabled).toBe(true);
		expect(manager.invokeCommand('demo/save-token', { token: 'test-token' })).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);

		forkMock.mock.results[0].value.emit('exit', 0);
		await Promise.resolve();
		expect(forkMock).toHaveBeenCalledTimes(1);
		finishCleanup();
		await vi.waitFor(() => expect(sandbox.isRunning('demo')).toBe(true));
		expect(forkMock).toHaveBeenCalledTimes(2);
		expect(manager.invokeCommand('demo/save-token', { token: 'test-token' })).toBe(true);
	});

	it('does not refresh or restart an unrelated plugin that crashes during the drain', async () => {
		writeCodePlugin('other');
		await manager.refresh();
		await manager.setEnabled('other', true);
		expect(sandbox.isRunning('other')).toBe(true);

		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		forkMock.mock.results[1].value.emit('exit', 1);
		writeCodePlugin('other', { version: '1.0.1' });
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();

		await vi.waitFor(() => expect(sandbox.isRunning('demo')).toBe(true));
		expect(sandbox.isRunning('other')).toBe(false);
		expect(
			manager.getRegistry().records.find((record) => record.id === 'other')?.manifest?.version
		).toBe('1.0.0');
		expect(forkMock).toHaveBeenCalledTimes(3);
	});

	it('preserves supervisor ownership of a crashed consumer through production change callbacks', async () => {
		writeCodePlugin('consumer', { requires: [mandatoryRequirement] });
		await manager.refresh();
		await manager.setEnabled('consumer', true);
		expect(sandbox.isRunning('consumer')).toBe(true);

		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		forkMock.mock.results[1].value.emit('exit', 1);
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();

		await vi.waitFor(() => expect(sandbox.isRunning('demo')).toBe(true));
		expect(sandbox.isRunning('consumer')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(3);

		servicesReady = false;
		manager.reconcileServiceDependencies();
		servicesReady = true;
		manager.reconcileServiceDependencies();
		expect(sandbox.isRunning('consumer')).toBe(false);

		// Explicit discovery retains the host's deliberate restart behavior.
		await manager.refresh();
		expect(sandbox.isRunning('consumer')).toBe(true);
		expect(forkMock).toHaveBeenCalledTimes(4);
	});

	it('resumes a dependency-stopped consumer after its own resource drain', async () => {
		writeCodePlugin('consumer', { requires: [mandatoryRequirement] });
		await manager.refresh();
		await manager.setEnabled('consumer', true);

		servicesReady = false;
		manager.reconcileServiceDependencies();
		forkMock.mock.results[1].value.emit('exit', 0);
		servicesReady = true;
		manager.reconcileServiceDependencies();
		expect(sandbox.isRunning('consumer')).toBe(false);
		expect(captureException).not.toHaveBeenCalled();

		finishCleanup();
		await vi.waitFor(() => expect(sandbox.isRunning('consumer')).toBe(true));
		expect(forkMock).toHaveBeenCalledTimes(3);
		expect(captureException).not.toHaveBeenCalled();
	});

	it('does not resume a waiting consumer after all sandboxes are stopped', async () => {
		servicesReady = false;
		writeCodePlugin('consumer', { requires: [mandatoryRequirement] });
		await manager.refresh();
		await manager.setEnabled('consumer', true);
		expect(sandbox.isRunning('consumer')).toBe(false);

		manager.stopAllSandboxes();
		servicesReady = true;
		manager.reconcileServiceDependencies();

		expect(sandbox.isRunning('consumer')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);
	});

	it('does not replace an unrelated record when the reloaded manifest changes identity', async () => {
		writeCodePlugin('other');
		await manager.refresh();
		await manager.setEnabled('other', true);

		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		const pluginDir = path.join(pluginsDir(), 'demo');
		const manifestPath = path.join(pluginDir, 'plugin.json');
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
		manifest.id = 'other';
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));
		signPluginDir(pluginDir, keys);
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();

		await vi.waitFor(() => expect(manager.getRegistry().records).toHaveLength(1));
		expect(manager.getRegistry().records[0]).toMatchObject({
			id: 'other',
			source: path.join(pluginsDir(), 'other'),
			manifest: { version: '1.0.0' },
		});
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(sandbox.isRunning('other')).toBe(true);
		expect(forkMock).toHaveBeenCalledTimes(2);
	});

	it('does not restart a plugin disabled during the drain', async () => {
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		await manager.setEnabled('demo', false);
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();
		await manager.stopAndDrain('demo');
		await Promise.resolve();
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);
	});

	it('does not restart a plugin whose bytes were tampered with during the drain', async () => {
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		fs.writeFileSync(path.join(pluginsDir(), 'demo', 'main.js'), 'unsigned edit');
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();
		await vi.waitFor(() =>
			expect(manager.getRegistry().records[0].signature?.status).toBe('invalid')
		);
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);
	});

	it('does not restart a plugin being uninstalled during the drain', async () => {
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		const removal = manager.uninstall('demo');
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();
		await removal;
		expect(manager.getRegistry().records).toEqual([]);
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);
	});

	it('does not restart while the plugins feature is disabled during the drain', async () => {
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		pluginsEnabled = false;
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();
		await vi.waitFor(() => expect(manager.getRegistry().records).toEqual([]));
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);
	});

	it('cancels a pending reload when all sandboxes are stopped', async () => {
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		manager.stopAllSandboxes();
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();
		await manager.stopAndDrain('demo');
		await Promise.resolve();
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);
	});

	it('keeps a failed resource drain stopped and reports the reload failure', async () => {
		const error = new Error('cleanup failed');
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		forkMock.mock.results[0].value.emit('exit', 0);
		rejectCleanup(error);
		await vi.waitFor(() =>
			expect(logger.warn).toHaveBeenCalledWith(
				'Could not reload plugin "demo": Error: cleanup failed',
				'Plugins'
			)
		);
		expect(captureException).toHaveBeenCalledWith(error, {
			operation: 'plugins:reload',
			pluginId: 'demo',
		});
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(forkMock).toHaveBeenCalledTimes(1);
	});

	it('reports a replacement child that cannot start', async () => {
		const error = new Error('fork failed');
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		forkMock.mockImplementationOnce(() => {
			throw error;
		});
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();
		await vi.waitFor(() =>
			expect(logger.warn).toHaveBeenCalledWith(
				'Could not start plugin "demo": Error: fork failed',
				'Plugins'
			)
		);
		expect(captureException).toHaveBeenCalledWith(error, {
			operation: 'plugins:start',
			pluginId: 'demo',
		});
		expect(sandbox.isRunning('demo')).toBe(false);
	});

	it('reports unexpected registry change callback errors after reload', async () => {
		const error = new Error('change callback failed');
		writeCodePlugin('demo', { version: '1.0.1' });
		await manager.refresh();
		vi.spyOn(manager, 'reconcileServiceDependencies').mockImplementationOnce(() => {
			throw error;
		});
		forkMock.mock.results[0].value.emit('exit', 0);
		finishCleanup();

		await vi.waitFor(() =>
			expect(captureException).toHaveBeenCalledWith(error, {
				operation: 'plugins:reload',
				pluginId: 'demo',
			})
		);
	});
});
