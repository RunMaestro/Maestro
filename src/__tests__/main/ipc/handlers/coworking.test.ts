/**
 * `coworking:*` IPC install gate. Installing writes the coworking MCP server
 * into an agent's config, so it refuses while the coworking Encore flag is off;
 * uninstalling stays open so a user can clean up after turning the feature off.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	encoreFeatures: undefined as Record<string, boolean> | undefined,
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn),
		on: vi.fn(),
		removeListener: vi.fn(),
	},
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/coworking/coworking-installer', () => ({
	getInstallStatus: vi.fn(async () => []),
	installFor: vi.fn(async () => undefined),
	installForAll: vi.fn(async () => []),
	uninstallFor: vi.fn(async () => undefined),
}));
vi.mock('../../../../main/coworking/coworking-audit', () => ({
	createDefaultBrowserAuditSink: vi.fn(() => vi.fn()),
	setBrowserAuditSink: vi.fn(),
}));
vi.mock('../../../../main/coworking/coworking-tools', () => ({
	setBrowserResolver: vi.fn(),
	setTerminalBufferResolver: vi.fn(),
}));
vi.mock('../../../../main/coworking/coworking-registry', () => ({
	coworkingRegistry: {},
}));

import { registerCoworkingHandlers } from '../../../../main/ipc/handlers/coworking';
import {
	installFor,
	installForAll,
	uninstallFor,
} from '../../../../main/coworking/coworking-installer';

beforeEach(() => {
	vi.clearAllMocks();
	h.handlers.clear();
	h.encoreFeatures = { coworking: true };
	registerCoworkingHandlers({
		getMainWindow: () => null,
		settingsStore: {
			get: (key: string) => (key === 'encoreFeatures' ? h.encoreFeatures : undefined),
		},
	});
});

describe('coworking IPC install gate', () => {
	it('installs while the feature is on', async () => {
		await h.handlers.get('coworking:install')!({}, 'claude-code');
		expect(installFor).toHaveBeenCalledWith('claude-code');
		await h.handlers.get('coworking:installAll')!({});
		expect(installForAll).toHaveBeenCalledOnce();
	});

	it('refuses installs while the feature is off, but still lets an agent be uninstalled', async () => {
		h.encoreFeatures = { coworking: false };
		await expect(h.handlers.get('coworking:install')!({}, 'claude-code')).rejects.toThrow(
			'CoworkingDisabled'
		);
		await expect(h.handlers.get('coworking:installAll')!({})).rejects.toThrow('CoworkingDisabled');
		expect(installFor).not.toHaveBeenCalled();
		expect(installForAll).not.toHaveBeenCalled();

		await h.handlers.get('coworking:uninstall')!({}, 'claude-code');
		expect(uninstallFor).toHaveBeenCalledWith('claude-code');
	});
});
