/**
 * @file promptLinksHandler.test.ts
 * @description Tests for the `prompt_link_command` WebSocket handler behind
 * `maestro-cli prompt-link`. CLI sockets only: a LAN or tunnel browser must
 * never mint, read, or revoke a link.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const service = vi.hoisted(() => ({
	createPromptLink: vi.fn(),
	listPromptLinks: vi.fn(),
	revokePromptLink: vi.fn(),
}));
vi.mock('../../../../main/prompt-links', () => service);

import { handlePromptLinkCommand } from '../../../../main/web-server/handlers/messageHandlers/promptLinks';

function makeCtx() {
	return { send: vi.fn(), sendError: vi.fn(), reportHandlerError: vi.fn(), callbacks: {} };
}

function makeClient(cli: boolean) {
	return { id: 'c1', socket: {}, connectedAt: 0, ...(cli ? { cli: true } : {}) } as never;
}

function lastResult(ctx: ReturnType<typeof makeCtx>) {
	return ctx.send.mock.calls.at(-1)?.[1] as Record<string, unknown>;
}

describe('handlePromptLinkCommand', () => {
	beforeEach(() => vi.clearAllMocks());

	it('refuses a browser socket without touching the service', async () => {
		const ctx = makeCtx();
		await handlePromptLinkCommand(ctx as never, makeClient(false), {
			type: 'prompt_link_command',
			action: 'list',
			requestId: 'r1',
		});
		expect(lastResult(ctx)).toMatchObject({
			type: 'prompt_link_command_result',
			success: false,
			requestId: 'r1',
		});
		expect(service.listPromptLinks).not.toHaveBeenCalled();
	});

	it('lists for the CLI', async () => {
		service.listPromptLinks.mockReturnValue([{ id: 'l1' }]);
		const ctx = makeCtx();
		await handlePromptLinkCommand(ctx as never, makeClient(true), {
			type: 'prompt_link_command',
			action: 'list',
		});
		expect(lastResult(ctx)).toMatchObject({ success: true, links: [{ id: 'l1' }] });
	});

	it('creates and returns the URL', async () => {
		service.createPromptLink.mockResolvedValue({ link: { id: 'l1' }, url: 'maestro://run/t' });
		const ctx = makeCtx();
		await handlePromptLinkCommand(ctx as never, makeClient(true), {
			type: 'prompt_link_command',
			action: 'create',
			input: { agentId: 'a', prompt: 'p', maxUses: null },
		});
		expect(service.createPromptLink).toHaveBeenCalledWith({
			agentId: 'a',
			prompt: 'p',
			maxUses: null,
		});
		expect(lastResult(ctx)).toMatchObject({
			success: true,
			url: 'maestro://run/t',
			link: { id: 'l1' },
		});
	});

	it("reports the service's own refusal", async () => {
		service.revokePromptLink.mockRejectedValue(new Error('No prompt link matches "x".'));
		const ctx = makeCtx();
		await handlePromptLinkCommand(ctx as never, makeClient(true), {
			type: 'prompt_link_command',
			action: 'revoke',
			id: 'x',
		});
		expect(lastResult(ctx)).toMatchObject({
			success: false,
			error: 'No prompt link matches "x".',
		});
	});

	it('rejects a malformed request', async () => {
		const ctx = makeCtx();
		await handlePromptLinkCommand(ctx as never, makeClient(true), {
			type: 'prompt_link_command',
			action: 'explode',
		});
		expect(lastResult(ctx)).toMatchObject({ success: false });
	});
});
