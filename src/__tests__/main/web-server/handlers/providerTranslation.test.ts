import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleProviderTranslation } from '../../../../main/web-server/handlers/messageHandlers/sessions';
import type {
	MessageHandlerContext,
	WebClient,
	WebClientMessage,
} from '../../../../main/web-server/handlers/messageHandlers/types';

describe('dedicated provider translation transport', () => {
	let ctx: MessageHandlerContext;
	let updateSessionConfig: ReturnType<typeof vi.fn>;
	const client = {} as WebClient;
	beforeEach(() => {
		updateSessionConfig = vi
			.fn()
			.mockResolvedValue({ success: true, plan: { id: 'reviewed-plan' } });
		ctx = {
			send: vi.fn(),
			sendError: vi.fn(),
			callbacks: { updateSessionConfig },
		} as unknown as MessageHandlerContext;
	});

	it('uses the existing migration callback and returns a correlated dedicated result', async () => {
		const configPatch = {
			toolType: 'codex',
			migrationAction: 'apply',
			migrationPlanId: 'reviewed-plan',
			acceptTranslationLimitations: true,
		};
		handleProviderTranslation(ctx, client, {
			type: 'provider_translation',
			sessionId: 'source-agent',
			requestId: 'request',
			configPatch,
		} as WebClientMessage);
		expect(updateSessionConfig).toHaveBeenCalledWith('source-agent', configPatch);
		await vi.waitFor(() =>
			expect(ctx.send).toHaveBeenCalledWith(
				client,
				expect.objectContaining({
					type: 'provider_translation_result',
					requestId: 'request',
					plan: { id: 'reviewed-plan' },
				})
			)
		);
	});

	it.each([
		{ migrationAction: 'sync' },
		{ migrationAction: 'apply', toolType: 'unknown' },
		{ migrationAction: 'plan', toolType: 'codex', customPath: '/unrelated' },
		{ migrationAction: 'apply', acceptTranslationLimitations: 'true' },
		{ migrationAction: 'status', migrationPlanId: ' ' },
		{ migrationAction: 'plan', selectedUserResources: [false] },
	])('rejects unsupported action/options before forwarding (%j)', (configPatch) => {
		handleProviderTranslation(ctx, client, {
			type: 'provider_translation',
			sessionId: 'source-agent',
			configPatch,
		} as WebClientMessage);
		expect(ctx.sendError).toHaveBeenCalled();
		expect(updateSessionConfig).not.toHaveBeenCalled();
	});

	it('inspects an existing operation without a destination or provider change', async () => {
		const configPatch = { migrationAction: 'status', migrationPlanId: 'reviewed-plan' };
		handleProviderTranslation(ctx, client, {
			type: 'provider_translation',
			sessionId: 'source-agent',
			configPatch,
		} as WebClientMessage);
		expect(updateSessionConfig).toHaveBeenCalledWith('source-agent', configPatch);
	});
});
