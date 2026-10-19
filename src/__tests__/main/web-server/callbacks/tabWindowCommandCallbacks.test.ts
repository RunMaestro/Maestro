/**
 * Tests for the tab_window_command callback (Tab Windows, TW-12): `list` is
 * answered in main from the registry with each agent's name, and `pop-out` /
 * `dock` go to the agent's OWNER window, with the owner resolved from the tab
 * id when the CLI named no agent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), removeListener: vi.fn() } }));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const safeSend = vi.hoisted(() => ({ available: true }));
vi.mock('../../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn(() => safeSend.available),
}));

const { requestFromRenderer } = vi.hoisted(() => ({ requestFromRenderer: vi.fn() }));
vi.mock('../../../../main/web-server/callbacks/remoteRequest', () => ({ requestFromRenderer }));

import { registerTabWindowCommandCallbacks } from '../../../../main/web-server/callbacks/tabWindowCommandCallbacks';
import type {
	TabWindowCommandRequest,
	TabWindowCommandResult,
} from '../../../../shared/tabWindowCommands';

type Callback = (request: TabWindowCommandRequest) => Promise<TabWindowCommandResult>;

const SESSIONS = [
	{
		id: 'agent-1',
		name: 'Backend',
		aiTabs: [{ id: 'ai-111' }],
		terminalTabs: [{ id: 'term-222' }],
	},
	{ id: 'agent-2', name: 'Frontend', browserTabs: [{ id: 'br-333' }] },
];

const mainWindow = { id: 'main' };
const ownerWindow = { id: 'owner' };

function setup(overrides: Record<string, unknown> = {}) {
	let callback: Callback | undefined;
	const server = {
		setTabWindowCommandCallback: (cb: Callback) => {
			callback = cb;
		},
	};
	const getWindowForSession = vi.fn(() => ownerWindow);
	registerTabWindowCommandCallbacks(
		server as never,
		{
			getMainWindow: () => mainWindow,
			getWindowForSession,
			sessionsStore: { get: () => SESSIONS },
			getTabWindows: () => [
				{
					windowId: 'tw-1',
					agentId: 'agent-1',
					tabRefs: [{ type: 'ai', id: 'ai-111' }],
					activeTabRef: { type: 'ai', id: 'ai-111' },
				},
				{ windowId: 'tw-2', agentId: 'gone', tabRefs: [], activeTabRef: null },
			],
			...overrides,
		} as never
	);
	return { callback: callback!, getWindowForSession };
}

beforeEach(() => {
	vi.clearAllMocks();
	safeSend.available = true;
	requestFromRenderer.mockResolvedValue({ success: true, windowId: 'tw-1' });
});

describe('tab_window_command callback', () => {
	it('lists tab windows from the registry with agent names, without asking a renderer', async () => {
		const { callback } = setup();
		const result = await callback({ action: 'list' });
		expect(result).toEqual({
			success: true,
			windows: [
				{
					windowId: 'tw-1',
					agentId: 'agent-1',
					agentName: 'Backend',
					tabRefs: [{ type: 'ai', id: 'ai-111' }],
					activeTabRef: { type: 'ai', id: 'ai-111' },
				},
				{ windowId: 'tw-2', agentId: 'gone', agentName: null, tabRefs: [], activeTabRef: null },
			],
		});
		expect(requestFromRenderer).not.toHaveBeenCalled();
	});

	it('refuses a list when the registry is not wired', async () => {
		const { callback } = setup({ getTabWindows: undefined });
		expect(await callback({ action: 'list' })).toEqual({
			success: false,
			error: 'Tab windows are not configured',
		});
	});

	it('resolves the owner from a tab id prefix of any kind and sends the full id to the owner window', async () => {
		const { callback, getWindowForSession } = setup();
		const result = await callback({ action: 'pop-out', tabId: 'br-3', background: true });

		expect(getWindowForSession).toHaveBeenCalledWith('agent-2');
		expect(requestFromRenderer).toHaveBeenCalledWith(
			ownerWindow,
			'remote:tabWindowCommand',
			expect.objectContaining({
				args: [{ action: 'pop-out', tabId: 'br-333', sessionId: 'agent-2', background: true }],
			})
		);
		expect(result).toEqual({ success: true, windowId: 'tw-1' });
	});

	it('trusts a named agent and leaves the tab id for the owner window to resolve', async () => {
		const { callback, getWindowForSession } = setup();
		await callback({ action: 'dock', sessionId: 'agent-1', tabId: 'brand-new-tab' });
		expect(getWindowForSession).toHaveBeenCalledWith('agent-1');
		expect(requestFromRenderer).toHaveBeenCalledWith(
			ownerWindow,
			'remote:tabWindowCommand',
			expect.objectContaining({
				args: [{ action: 'dock', sessionId: 'agent-1', tabId: 'brand-new-tab' }],
			})
		);
	});

	it('answers an unknown tab id without asking a renderer', async () => {
		const { callback } = setup();
		expect(await callback({ action: 'dock', tabId: 'nope' })).toEqual({
			success: false,
			error: 'Tab not found: nope',
		});
		expect(requestFromRenderer).not.toHaveBeenCalled();
	});

	it('falls back to the main window when no owner is known', async () => {
		const { callback } = setup({ getWindowForSession: undefined });
		await callback({ action: 'pop-out', tabId: 'ai-111' });
		expect(requestFromRenderer).toHaveBeenCalledWith(
			mainWindow,
			'remote:tabWindowCommand',
			expect.anything()
		);
	});

	it('answers when the owner window is gone', async () => {
		safeSend.available = false;
		const { callback } = setup();
		expect(await callback({ action: 'pop-out', tabId: 'ai-111' })).toEqual({
			success: false,
			error: 'Maestro window is not available',
		});
	});
});
