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

vi.mock('electron', () => ({
	app: { getPath: () => os.tmpdir() },
}));

import { PluginManager, type PluginSandboxLifecycle } from '../../../main/plugins/plugin-manager';
import { pluginsDir } from '../../../main/plugins/plugin-store-main';

function writeCodePlugin(
	id: string,
	options: { version?: string; entry?: string; code?: string } = {}
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
	};
	fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
	fs.writeFileSync(path.join(dir, entry), options.code ?? 'module.exports = "v1";');
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

function enableRunnablePlugin(manager: PluginManager, sandbox: PluginSandboxLifecycle): void {
	manager.refresh();
	manager.setEnabled('demo', true);
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
	it('refreshes a manifest edit and restarts the still-runnable sandbox', () => {
		const sandbox = makeSandbox();
		const onChange = vi.fn();
		const manager = new PluginManager({ isEnabled: () => true, sandbox, onChange });
		writeCodePlugin('demo');
		enableRunnablePlugin(manager, sandbox);

		writeCodePlugin('demo', { version: '1.0.1', code: 'module.exports = "v1";' });
		manager.refresh();

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

	it('refreshes a code edit and restarts the affected sandbox', () => {
		const sandbox = makeSandbox();
		const manager = new PluginManager({ isEnabled: () => true, sandbox });
		writeCodePlugin('demo');
		enableRunnablePlugin(manager, sandbox);

		fs.writeFileSync(path.join(pluginsDir(), 'demo', 'main.js'), 'module.exports = "v2";');
		manager.refresh();

		expect(sandbox.stop).toHaveBeenCalledTimes(1);
		expect(sandbox.stop).toHaveBeenCalledWith('demo');
		expect(sandbox.start).toHaveBeenCalledTimes(1);
		expect(sandbox.start).toHaveBeenCalledWith('demo', path.join(pluginsDir(), 'demo'), 'main.js');
		expect(sandbox.isRunning('demo')).toBe(true);
	});

	it('refreshes removal by stopping the sandbox and dropping the stale registry record', () => {
		const sandbox = makeSandbox();
		const manager = new PluginManager({ isEnabled: () => true, sandbox });
		writeCodePlugin('demo');
		enableRunnablePlugin(manager, sandbox);

		fs.rmSync(path.join(pluginsDir(), 'demo'), { recursive: true, force: true });
		manager.refresh();

		expect(sandbox.stop).toHaveBeenCalledTimes(1);
		expect(sandbox.stop).toHaveBeenCalledWith('demo');
		expect(sandbox.start).not.toHaveBeenCalled();
		expect(sandbox.isRunning('demo')).toBe(false);
		expect(manager.getRegistry().records.some((record) => record.id === 'demo')).toBe(false);
	});
});
