import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleTabProvider } from '../../../../main/web-server/handlers/messageHandlers/tabs';
import { setBridgeGuardContextProvider } from '../../../../main/web-server/handlers/bridgePathGuard';
import type { MessageHandlerContext } from '../../../../main/web-server/handlers/messageHandlers/types';

afterEach(() => setBridgeGuardContextProvider(null));

function setup(enabled = true) {
	setBridgeGuardContextProvider(() => ({
		userDataDir: null,
		platform: 'darwin',
		encoreFeatures: { ensemble: enabled },
	}));
	const send = vi.fn();
	const updateSessionConfig = vi
		.fn()
		.mockResolvedValue({ success: true, tab: { provider: 'codex', agentProvider: 'claude-code' } });
	const ctx = { send, callbacks: { updateSessionConfig } } as unknown as MessageHandlerContext;
	return { send, updateSessionConfig, ctx };
}

describe('tab provider bridge', () => {
	it.each([true, false])('rejects retired reads and writes with saved flag %s', async (enabled) => {
		const { ctx, send, updateSessionConfig } = setup(enabled);
		for (const extra of [{}, { provider: 'codex', model: 'auto' }]) {
			await handleTabProvider(ctx, {} as never, {
				type: 'tab_provider',
				sessionId: 'agent',
				tabId: 'tab',
				requestId: 'request',
				...extra,
			});
		}
		expect(updateSessionConfig).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				type: 'tab_provider_result',
				success: false,
				requestId: 'request',
				error: expect.stringContaining('has been removed'),
			})
		);
	});
});
