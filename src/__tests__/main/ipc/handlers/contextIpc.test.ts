// Source: src/__tests__/main/ipc/handlers/context-groom.test.ts
// Source: src/__tests__/main/ipc/handlers/context-timeline.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerContextHandlers } from '../../../../main/ipc/handlers/context';
import { getSessionStorage } from '../../../../main/agents';
import { registerContextTimelineHandlers } from '../../../../main/ipc/handlers/context-timeline';
import { appendUsageCapture } from '../../../../main/process-listeners/context-timeline-log';
import { getUsageCaptures } from '../../../../main/process-listeners/context-timeline-log';
import { __resetUsageCaptureLogForTests } from '../../../../main/process-listeners/context-timeline-log';
import type { UsageStats } from '../../../../shared/types';
const groomContext = vi.fn();
vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
	BrowserWindow: class {},
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../../main/utils/context-groomer', () => ({
	groomContext: (...args: unknown[]) => groomContext(...args),
	cancelAllGroomingSessions: vi.fn(),
}));
vi.mock('../../../../main/stores', () => ({ getSettingsStore: vi.fn() }));
vi.mock('../../../../main/agents', () => ({ getSessionStorage: vi.fn() }));
describe('context-groom', () => {
	type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

	function register(
		settings: Record<string, unknown> = {},
		channel = 'context:groomContext'
	): Handler {
		registerContextHandlers({
			getMainWindow: () => null,
			getProcessManager: () => ({}) as never,
			getAgentDetector: () => ({}) as never,
			agentConfigsStore: { get: () => ({}) } as never,
			settingsStore: {
				get: (key: string, fallback: unknown) => settings[key] ?? fallback,
			} as never,
		});
		const call = vi
			.mocked(ipcMain.handle)
			.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
		return call![1] as Handler;
	}

	beforeEach(() => {
		vi.mocked(ipcMain.handle).mockClear();
		vi.mocked(getSessionStorage).mockReset();
		groomContext
			.mockReset()
			.mockResolvedValue({ response: '2', durationMs: 1, completionReason: '' });
	});

	describe('context:getStoredSession', () => {
		it('refuses unscoped Grok export before any storage or grooming call', async () => {
			const handler = register({}, 'context:getStoredSession');
			await expect(handler({}, 'grok', '/fixture/project', 'native-shared')).rejects.toThrow(
				'Grok context export requires a selected owner. Use agentSessions.read with ownerAgentId and includeNativeRecords.'
			);
			expect(getSessionStorage).not.toHaveBeenCalled();
			expect(groomContext).not.toHaveBeenCalled();
		});

		it.each(['claude-code', 'codex'])('retains legacy %s storage retrieval', async (provider) => {
			const result = {
				messages: [{ type: 'user', content: 'Existing context', timestamp: '', uuid: 'message-1' }],
				total: 1,
				hasMore: false,
			};
			const readSessionMessages = vi.fn().mockResolvedValue(result);
			// Only this storage method is reachable through the existing context handler.
			vi.mocked(getSessionStorage).mockReturnValue({ readSessionMessages } as never);
			const handler = register({}, 'context:getStoredSession');
			await expect(handler({}, provider, '/fixture/project', 'native-shared')).resolves.toBe(
				result
			);
			expect(getSessionStorage).toHaveBeenCalledExactlyOnceWith(provider);
			expect(readSessionMessages).toHaveBeenCalledExactlyOnceWith(
				'/fixture/project',
				'native-shared'
			);
			expect(groomContext).not.toHaveBeenCalled();
		});
	});

	describe('context:groomContext', () => {
		it('runs an answer-only turn: cheap, no tools, read-only, with the caller deadline', async () => {
			const handler = register();
			const response = await handler({}, '/project', 'claude-code', 'pick one', {
				cheapTurn: true,
				readOnly: true,
				disableTools: true,
				timeoutMs: 20_000,
			});

			expect(response).toBe('2');
			expect(groomContext.mock.calls[0][0]).toMatchObject({
				projectRoot: '/project',
				agentType: 'claude-code',
				prompt: 'pick one',
				readOnlyMode: true,
				disableTools: true,
				timeoutMs: 20_000,
				sessionCustomModel: 'haiku',
			});
		});

		it('leaves grooming as it was when the options are not given', async () => {
			const handler = register();
			await handler({}, '/project', 'claude-code', 'compact this');

			const options = groomContext.mock.calls[0][0];
			// Undefined falls through to groomContext's own defaults: tools on, the
			// agent's model, the long grooming timeout.
			expect(options.readOnlyMode).toBeUndefined();
			expect(options.disableTools).toBeUndefined();
			expect(options.timeoutMs).toBeUndefined();
			expect(options.sessionCustomModel).toBeUndefined();
		});
	});
});
describe('context-timeline', () => {
	type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

	const usage = (overrides: Partial<UsageStats> = {}): UsageStats => ({
		inputTokens: 100,
		outputTokens: 50,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0,
		contextWindow: 200000,
		...overrides,
	});

	describe('Context Timeline IPC Handlers', () => {
		let handlers: Map<string, Handler>;

		beforeEach(() => {
			vi.clearAllMocks();
			__resetUsageCaptureLogForTests();
			handlers = new Map();
			(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
				(channel: string, handler: Handler) => {
					handlers.set(channel, handler);
				}
			);
			registerContextTimelineHandlers();
		});

		it('registers both channels', () => {
			expect(handlers.has('contextTimeline:getCaptures')).toBe(true);
			expect(handlers.has('contextTimeline:clearCaptures')).toBe(true);
		});

		it('returns the captures and the trimmed flag for an agent', async () => {
			appendUsageCapture('agent-1', usage({ inputTokens: 1 }));
			appendUsageCapture('agent-1-ai-tab1', usage({ inputTokens: 2 }));

			const result = (await handlers.get('contextTimeline:getCaptures')!(null, 'agent-1')) as {
				success: boolean;
				captures: Array<{ usageStats: UsageStats }>;
				trimmed: boolean;
			};

			expect(result.success).toBe(true);
			expect(result.trimmed).toBe(false);
			expect(result.captures.map((c) => c.usageStats.inputTokens)).toEqual([1, 2]);
		});

		it('returns an empty result for a null session id', async () => {
			const result = (await handlers.get('contextTimeline:getCaptures')!(null, null)) as {
				success: boolean;
				captures: unknown[];
			};
			expect(result.success).toBe(true);
			expect(result.captures).toEqual([]);
		});

		it('does not read anything off the IPC event (web-desktop bridge has no sender)', async () => {
			appendUsageCapture('agent-1', usage());
			const hostileEvent = new Proxy(
				{},
				{
					get() {
						throw new Error('handler must not touch the IPC event');
					},
				}
			);
			await expect(
				handlers.get('contextTimeline:getCaptures')!(hostileEvent, 'agent-1')
			).resolves.toMatchObject({ success: true });
		});

		it('clears the captures for an agent', async () => {
			appendUsageCapture('agent-1', usage());
			appendUsageCapture('agent-2', usage());

			const result = (await handlers.get('contextTimeline:clearCaptures')!(null, 'agent-1')) as {
				success: boolean;
			};

			expect(result.success).toBe(true);
			expect(getUsageCaptures('agent-1').captures).toHaveLength(0);
			expect(getUsageCaptures('agent-2').captures).toHaveLength(1);
		});
	});
});
