/**
 * `coworking:*` IPC install gate. Installing writes the coworking MCP server
 * into an agent's config, so it refuses while the coworking Encore flag is off;
 * uninstalling stays open so a user can clean up after turning the feature off.
 */

import { ipcMain, type BrowserWindow } from 'electron';
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

import { coworkingRegistry } from '../../../../main/coworking/coworking-registry';
import { setBrowserResolver } from '../../../../main/coworking/coworking-tools';
import type { BrowserOp } from '../../../../shared/coworkingBrowser';
import { registerCoworkingHandlers } from '../../../../main/ipc/handlers/coworking';
import {
	installFor,
	installForAll,
	uninstallFor,
} from '../../../../main/coworking/coworking-installer';

beforeEach(() => {
	vi.clearAllMocks();
	h.handlers.clear();
	coworkingRegistry.reset();
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

describe('coworking browser approval from persisted settings', () => {
	it('requires explicit typing permission for the requesting provider and always confirms eval', async () => {
		let typingProviders: unknown;
		const sender = { id: 1 };
		const send = vi.fn(
			(
				_channel: string,
				_tabUuid: string,
				_sessionId: string,
				_op: BrowserOp,
				response: string
			) => {
				const listener = vi
					.mocked(ipcMain.on)
					.mock.calls.find(([channel]) => channel === response)?.[1];
				listener?.({ sender }, { ok: true });
			}
		);
		const win = {
			isDestroyed: () => false,
			webContents: { ...sender, send },
		} as unknown as BrowserWindow;
		registerCoworkingHandlers({
			getMainWindow: () => win,
			settingsStore: {
				get: (key) =>
					key === 'coworkingBrowserTypingWithoutConfirmation' ? typingProviders : undefined,
			},
		});
		const resolve = vi.mocked(setBrowserResolver).mock.lastCall![0]!;
		coworkingRegistry.syncSessionBrowsers('s1', [], true, 'codex', 'off');
		coworkingRegistry.syncSessionBrowsers('s2', [], true, 'claude-code', 'dangerous');
		const type: BrowserOp = { kind: 'type', selector: 'textarea', text: 'fixture' };
		const evalOp: BrowserOp = { kind: 'eval', code: '1 + 1' };

		async function expectApproval(sessionId: string, op: BrowserOp, required: boolean) {
			await expect(resolve(sessionId, 'tab', op)).resolves.toEqual({ ok: true });
			expect(send).toHaveBeenLastCalledWith(
				'coworking:requestBrowserOp',
				'tab',
				sessionId,
				op,
				expect.any(String),
				required,
				// No MCP caller identity in this fixture.
				undefined
			);
		}

		await expectApproval('s1', type, true);
		typingProviders = 'codex';
		await expectApproval('s1', type, true);
		typingProviders = ['codex'];
		await expectApproval('s1', type, false);
		await expectApproval('s2', type, true);
		await expectApproval('s1', evalOp, true);
		typingProviders = [];
		await expectApproval('s1', type, true);
	});
});
