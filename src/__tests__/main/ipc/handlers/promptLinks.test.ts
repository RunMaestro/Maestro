/**
 * Prompt Links IPC.
 *
 * The channels are thin pass-throughs to the Prompt Links service, so what
 * these tests defend is the wiring: every channel is registered, each hands its
 * arguments through, and a service rejection REACHES the renderer (swallowing
 * it would leave the window showing a link that was never created).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const registeredHandlers = new Map<string, (...args: any[]) => any>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
			registeredHandlers.set(channel, handler);
		}),
	},
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const service = vi.hoisted(() => ({
	createPromptLink: vi.fn(),
	listPromptLinks: vi.fn(),
	revokePromptLink: vi.fn(),
	markPromptLinksRendererReady: vi.fn(),
}));

vi.mock('../../../../main/prompt-links', () => service);

import { registerPromptLinkHandlers } from '../../../../main/ipc/handlers/promptLinks';

function invoke(channel: string, ...args: unknown[]): Promise<any> {
	const handler = registeredHandlers.get(channel);
	if (!handler) throw new Error(`channel not registered: ${channel}`);
	return handler({}, ...args);
}

describe('prompt link handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();
		registerPromptLinkHandlers();
	});

	it('registers exactly the four promptLinks channels', () => {
		expect([...registeredHandlers.keys()].sort()).toEqual([
			'promptLinks:create',
			'promptLinks:list',
			'promptLinks:rendererReady',
			'promptLinks:revoke',
		]);
	});

	it('lists links', async () => {
		service.listPromptLinks.mockReturnValue([{ id: 'l1' }]);
		await expect(invoke('promptLinks:list')).resolves.toEqual([{ id: 'l1' }]);
	});

	it('passes the create input through and returns the URL', async () => {
		const input = { agentId: 'a', prompt: 'p' };
		service.createPromptLink.mockResolvedValue({ link: { id: 'l1' }, url: 'maestro://run/t' });
		await expect(invoke('promptLinks:create', input)).resolves.toEqual({
			link: { id: 'l1' },
			url: 'maestro://run/t',
		});
		expect(service.createPromptLink).toHaveBeenCalledWith(input);
	});

	it('lets a refusal reach the renderer', async () => {
		service.createPromptLink.mockRejectedValue(new Error('Prompt Links is turned off.'));
		await expect(invoke('promptLinks:create', { agentId: 'a', prompt: 'p' })).rejects.toThrow(
			/turned off/
		);
	});

	it('revokes by id', async () => {
		service.revokePromptLink.mockResolvedValue({ id: 'l1', revokedAt: 1 });
		await invoke('promptLinks:revoke', 'l1');
		expect(service.revokePromptLink).toHaveBeenCalledWith('l1');
	});

	it('marks the renderer ready', async () => {
		await invoke('promptLinks:rendererReady');
		expect(service.markPromptLinksRendererReady).toHaveBeenCalled();
	});
});
