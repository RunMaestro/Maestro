/**
 * @file plugins-handlers.test.ts
 * @description Locks the invariant that the plugin READ channels
 * (plugins:contributions, plugins:list) never call manager.refresh(). refresh()
 * reconciles sandboxes and fires onChange -> 'plugins:changed' -> renderer
 * re-fetch -> read again, an infinite IPC loop that froze the whole app. Reads
 * must be pure; discovery happens at startup and on mutations. electron's
 * ipcMain is mocked to capture handlers; the store is mocked so no fs runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AggregatedContributions } from '../../../shared/plugins/contributions';
import type { PluginRegistry } from '../../../shared/plugins/plugin-registry';
import type { PluginManager } from '../../../main/plugins/plugin-manager';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
	},
}));

vi.mock('../../../main/plugins/plugin-store-main', () => ({
	readGrants: vi.fn(() => []),
	setGrants: vi.fn(),
	forgetGrants: vi.fn(),
}));

import { registerPluginsHandlers } from '../../../main/ipc/handlers/plugins';

const EMPTY: AggregatedContributions = {
	themes: [],
	prompts: [],
	settings: [],
	commandMacros: [],
	cueTriggers: [],
	commands: [],
	panels: [],
	agents: [],
	errorsByPlugin: {},
};

const emptyRegistry = { records: [] } as unknown as PluginRegistry;

function fakeManager() {
	return {
		refresh: vi.fn(() => emptyRegistry),
		getRegistry: vi.fn(() => emptyRegistry),
		getContributions: vi.fn(() => EMPTY),
		setEnabled: vi.fn(() => emptyRegistry),
	};
}

function settingsStore(plugins: boolean): { get: (key: string) => unknown } {
	return { get: (key: string) => (key === 'encoreFeatures' ? { plugins } : undefined) };
}

function register(plugins: boolean) {
	const manager = fakeManager();
	registerPluginsHandlers({
		settingsStore: settingsStore(plugins),
		manager: manager as unknown as PluginManager,
	});
	return manager;
}

const event = {} as unknown;

beforeEach(() => {
	handlers.clear();
	vi.clearAllMocks();
});

describe('plugins IPC read channels are pure (no refresh -> no feedback loop)', () => {
	it('plugins:contributions returns getContributions() and never calls refresh()', async () => {
		const manager = register(true);
		const handler = handlers.get('plugins:contributions');
		expect(handler).toBeDefined();

		// Call it repeatedly — the old bug looped because each read refreshed.
		await handler!(event);
		await handler!(event);
		await handler!(event);

		expect(manager.getContributions).toHaveBeenCalledTimes(3);
		expect(manager.refresh).not.toHaveBeenCalled();
	});

	it('plugins:list returns getRegistry() and never calls refresh()', async () => {
		const manager = register(true);
		const handler = handlers.get('plugins:list');
		expect(handler).toBeDefined();

		await handler!(event);
		await handler!(event);

		expect(manager.getRegistry).toHaveBeenCalledTimes(2);
		expect(manager.refresh).not.toHaveBeenCalled();
	});

	it('plugins:set-enabled (a mutation) still drives manager.setEnabled', async () => {
		const manager = register(true);
		const handler = handlers.get('plugins:set-enabled');
		expect(handler).toBeDefined();

		await handler!(event, 'some-plugin', true);

		expect(manager.setEnabled).toHaveBeenCalledWith('some-plugin', true);
	});

	it('mutation channels reject a path-traversal plugin id (InvalidPluginId) and never reach the manager', async () => {
		const manager = register(true);
		const handler = handlers.get('plugins:set-enabled');
		expect(handler).toBeDefined();

		await expect(handler!(event, '../../etc', true)).rejects.toThrow('InvalidPluginId');
		expect(manager.setEnabled).not.toHaveBeenCalled();
	});

	it('reads reject with PluginsDisabled when the Encore flag is off, without touching the manager', async () => {
		const manager = register(false);
		const handler = handlers.get('plugins:contributions');
		expect(handler).toBeDefined();

		await expect(handler!(event)).rejects.toThrow('PluginsDisabled');
		expect(manager.getContributions).not.toHaveBeenCalled();
		expect(manager.refresh).not.toHaveBeenCalled();
	});
});
