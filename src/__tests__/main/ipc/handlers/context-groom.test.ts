/**
 * Tests for `context:groomContext`, the app's one generic "prompt in, text out"
 * IPC, and the options that turn it into an answer-only call (Quick Chat's tab
 * routing): no tools, nothing written, a short deadline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
	BrowserWindow: class {},
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

const groomContext = vi.fn();
vi.mock('../../../../main/utils/context-groomer', () => ({
	groomContext: (...args: unknown[]) => groomContext(...args),
	cancelAllGroomingSessions: vi.fn(),
}));

vi.mock('../../../../main/stores', () => ({ getSettingsStore: vi.fn() }));
vi.mock('../../../../main/agents', () => ({ getSessionStorage: vi.fn() }));

import { registerContextHandlers } from '../../../../main/ipc/handlers/context';
import { getSessionStorage } from '../../../../main/agents';

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
		settingsStore: { get: (key: string, fallback: unknown) => settings[key] ?? fallback } as never,
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
		await expect(handler({}, provider, '/fixture/project', 'native-shared')).resolves.toBe(result);
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
