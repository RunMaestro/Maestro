vi.mock('../../../main/plugins/plugin-scan', async () => await import('../../helpers/pluginScan'));
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

import {
	getActivePluginManager,
	setActivePluginManager,
} from '../../../main/plugins/plugin-manager-singleton';
import { PluginToolRunIdentity } from '../../../main/plugins/plugin-tool-run-identity';
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
		expect(invokeTool).toHaveBeenCalledWith('demo', 'lookup', { q: 'x' }, { callerAgentId: null });
	});

	it('preserves a local id that itself contains a slash', async () => {
		const invokeTool = vi.fn(async () => 'ok');
		const sandbox = makeSandbox(invokeTool);
		const manager = new PluginManager({ isEnabled: () => true, sandbox });

		await manager.invokeTool('demo/group/run', undefined);
		expect(invokeTool).toHaveBeenCalledWith('demo', 'group/run', undefined, {
			callerAgentId: null,
		});
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

	it('rejects provider service handlers on the generic tool path before touching the sandbox', async () => {
		const invokeTool = vi.fn(async () => 'forged');
		const manager = new PluginManager({ isEnabled: () => true, sandbox: makeSandbox(invokeTool) });
		await expect(
			manager.invokeTool('demo/service:transcription', { callId: 'live-call' })
		).rejects.toThrow('ServiceDenied');
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

describe('PluginManager authority ownership on replacement', () => {
	it('rejects a shared registry before retiring either manager or existing proofs', () => {
		const registry = new PluginToolRunIdentity();
		const deps = { isEnabled: () => true, toolIdentity: registry };
		const previous = new PluginManager(deps),
			next = new PluginManager(deps);
		setActivePluginManager(previous, deps.isEnabled);
		const token = registry.issue('fixture-agent');
		try {
			expect(() => setActivePluginManager(next, deps.isEnabled)).toThrow(
				expect.objectContaining({ code: 'PLUGIN_CONFLICT' })
			);
			expect(getActivePluginManager()).toBe(previous);
			expect(registry.resolveVerified(token).callerAgentId).toBe('fixture-agent');
		} finally {
			setActivePluginManager(null);
			registry.stop();
		}
	});
	it('retires old proofs while a replacement with independent resources can mint new ones', () => {
		const oldRegistry = new PluginToolRunIdentity(),
			nextRegistry = new PluginToolRunIdentity();
		const previous = new PluginManager({ isEnabled: () => true, toolIdentity: oldRegistry });
		const next = new PluginManager({ isEnabled: () => true, toolIdentity: nextRegistry });
		setActivePluginManager(previous, () => true);
		const token = oldRegistry.issue('fixture-agent');
		try {
			setActivePluginManager(next, () => true);
			expect(getActivePluginManager()).toBe(next);
			expect(() => oldRegistry.resolveVerified(token)).toThrow();
			const fresh = nextRegistry.issue('fixture-agent');
			expect(nextRegistry.resolveVerified(fresh).callerAgentId).toBe('fixture-agent');
			nextRegistry.revoke(fresh);
		} finally {
			setActivePluginManager(null);
			oldRegistry.stop();
			nextRegistry.stop();
		}
	});
});
