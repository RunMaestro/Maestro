/**
 * @file plugin-manager-invoke-tool.test.ts
 * @description PluginManager.invokeTool splits the namespaced contribution id
 * (`<pluginId>/<localId>`) and delegates to the injected sandbox, returning its
 * resolved value. A malformed id rejects without touching the sandbox, and a
 * missing sandbox rejects too. electron is mocked so importing the module never
 * touches the (absent) Electron runtime.
 */

import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';

vi.mock('electron', () => ({
	app: { getPath: () => os.tmpdir() },
}));

import { PluginManager } from '../../../main/plugins/plugin-manager';
import type { PluginSandboxLifecycle } from '../../../main/plugins/plugin-manager';

function makeSandbox(invokeTool: PluginSandboxLifecycle['invokeTool']): PluginSandboxLifecycle {
	return {
		start: vi.fn(),
		stop: vi.fn(),
		stopAll: vi.fn(),
		isRunning: vi.fn(() => true),
		runningIds: vi.fn(() => []),
		invokeCommand: vi.fn(() => true),
		invokeTool,
	};
}

describe('PluginManager.invokeTool', () => {
	it('splits the id and delegates to the sandbox, returning its result', async () => {
		const invokeTool = vi.fn(async () => ({ ok: true, value: 7 }));
		const sandbox = makeSandbox(invokeTool);
		const manager = new PluginManager({ isEnabled: () => true, sandbox });

		await expect(manager.invokeTool('demo/lookup', { q: 'x' })).resolves.toEqual({
			ok: true,
			value: 7,
		});
		expect(invokeTool).toHaveBeenCalledWith('demo', 'lookup', { q: 'x' });
	});

	it('preserves a local id that itself contains a slash', async () => {
		const invokeTool = vi.fn(async () => 'ok');
		const sandbox = makeSandbox(invokeTool);
		const manager = new PluginManager({ isEnabled: () => true, sandbox });

		await manager.invokeTool('demo/group/run', undefined);
		expect(invokeTool).toHaveBeenCalledWith('demo', 'group/run', undefined);
	});

	it('rejects a malformed id without touching the sandbox', async () => {
		const invokeTool = vi.fn(async () => 'never');
		const sandbox = makeSandbox(invokeTool);
		const manager = new PluginManager({ isEnabled: () => true, sandbox });

		await expect(manager.invokeTool('no-separator')).rejects.toThrow('InvalidToolId');
		await expect(manager.invokeTool('/leading')).rejects.toThrow('InvalidToolId');
		await expect(manager.invokeTool('trailing/')).rejects.toThrow('InvalidToolId');
		expect(invokeTool).not.toHaveBeenCalled();
	});

	it('rejects when no sandbox is wired', async () => {
		const manager = new PluginManager({ isEnabled: () => true });
		await expect(manager.invokeTool('demo/lookup')).rejects.toThrow('sandbox not available');
	});

	it('propagates a sandbox rejection (plugin not running / timeout)', async () => {
		const invokeTool = vi.fn(async () => {
			throw new Error('plugin "demo" is not running');
		});
		const sandbox = makeSandbox(invokeTool);
		const manager = new PluginManager({ isEnabled: () => true, sandbox });

		await expect(manager.invokeTool('demo/lookup')).rejects.toThrow(/not running/);
	});
});
