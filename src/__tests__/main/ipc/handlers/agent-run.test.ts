import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';

const { registeredHandlers, storeMocks, loggerMock, settingsStore } = vi.hoisted(() => ({
	registeredHandlers: new Map<string, Function>(),
	storeMocks: {
		getAgentRun: vi.fn(),
		getCampaign: vi.fn(),
		listAgentRuns: vi.fn(),
		listCampaigns: vi.fn(),
		readAgentRunEvents: vi.fn(),
		upsertAgentRun: vi.fn(),
		appendAgentRunEvent: vi.fn(),
		upsertCampaign: vi.fn(),
	},
	loggerMock: {
		info: vi.fn(),
		error: vi.fn(),
	},
	settingsStore: {
		get: vi.fn(),
	},
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: Function) => {
			registeredHandlers.set(channel, handler);
		}),
	},
}));

vi.mock('../../../../cli/services/agent-run-store', () => storeMocks);

vi.mock('../../../../main/utils/logger', () => ({
	logger: loggerMock,
}));

import { registerAgentRunHandlers } from '../../../../main/ipc/handlers/agent-run';

describe('AgentRun IPC handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();
		registerAgentRunHandlers({
			getProcessManager: () => null,
			settingsStore,
		});
	});

	it('registers run and campaign read/write handlers', () => {
		expect(ipcMain.handle).toHaveBeenCalledWith('agentRun:list', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('agentRun:record', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('agentRun:show', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('agentRun:events', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('agentRun:event', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('campaign:list', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('campaign:record', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('campaign:show', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('agentRun:cancel', expect.any(Function));
	});

	it('lists agent runs with sanitized default options', async () => {
		storeMocks.listAgentRuns.mockReturnValue([{ id: 'run-1' }]);
		const handler = registeredHandlers.get('agentRun:list');

		const result = await handler?.({}, undefined);

		expect(storeMocks.listAgentRuns).toHaveBeenCalledWith({});
		expect(result).toEqual({ success: true, runs: [{ id: 'run-1' }] });
	});

	it('maps renderer campaign filter to store campaignId option', async () => {
		storeMocks.listAgentRuns.mockReturnValue([{ id: 'run-1' }]);
		const handler = registeredHandlers.get('agentRun:list');

		const result = await handler?.({}, { status: 'running', campaign: 'campaign-1', limit: 5 });

		expect(storeMocks.listAgentRuns).toHaveBeenCalledWith({
			status: 'running',
			campaignId: 'campaign-1',
			limit: 5,
		});
		expect(result).toEqual({ success: true, runs: [{ id: 'run-1' }] });
	});

	it('keeps concurrent agent-run list responses isolated by request options', async () => {
		storeMocks.listAgentRuns.mockImplementation(({ campaignId }: { campaignId?: string }) => [
			{ id: campaignId ?? 'unfiltered' },
		]);
		const handler = registeredHandlers.get('agentRun:list');

		const [first, second] = await Promise.all([
			handler?.({}, { campaign: 'campaign-a' }),
			handler?.({}, { campaign: 'campaign-b' }),
		]);

		expect(first).toEqual({ success: true, runs: [{ id: 'campaign-a' }] });
		expect(second).toEqual({ success: true, runs: [{ id: 'campaign-b' }] });
	});

	it('normalizes malformed list options to the established empty-store request', async () => {
		storeMocks.listAgentRuns.mockReturnValue([]);
		const handler = registeredHandlers.get('agentRun:list');

		const result = await handler?.({}, null);

		expect(storeMocks.listAgentRuns).toHaveBeenCalledWith({});
		expect(result).toEqual({ success: true, runs: [] });
	});

	it('records an agent run through strict store validation', async () => {
		storeMocks.upsertAgentRun.mockReturnValue({ id: 'run-1' });
		const handler = registeredHandlers.get('agentRun:record');

		const result = await handler?.({}, { id: 'run-1' });

		expect(storeMocks.upsertAgentRun).toHaveBeenCalledWith({ id: 'run-1' });
		expect(result).toEqual({ success: true, run: { id: 'run-1' } });
	});

	it('shows a run when it exists', async () => {
		storeMocks.getAgentRun.mockReturnValue({ id: 'run-1' });
		const handler = registeredHandlers.get('agentRun:show');

		const result = await handler?.({}, 'run-1');

		expect(storeMocks.getAgentRun).toHaveBeenCalledWith('run-1');
		expect(result).toEqual({ success: true, run: { id: 'run-1' } });
	});

	it('returns a not-found response for a missing run', async () => {
		storeMocks.getAgentRun.mockReturnValue(undefined);
		const handler = registeredHandlers.get('agentRun:show');

		const result = await handler?.({}, 'missing-run');

		expect(result).toEqual({ success: false, error: 'Run not found: missing-run' });
	});

	it('reads run events through the store', async () => {
		storeMocks.readAgentRunEvents.mockReturnValue([{ id: 'event-1' }]);
		const handler = registeredHandlers.get('agentRun:events');

		const result = await handler?.({}, 'run-1');

		expect(storeMocks.readAgentRunEvents).toHaveBeenCalledWith('run-1');
		expect(result).toEqual({ success: true, events: [{ id: 'event-1' }] });
	});

	it('appends an agent run event through strict store validation', async () => {
		storeMocks.appendAgentRunEvent.mockReturnValue({ id: 'event-1' });
		const handler = registeredHandlers.get('agentRun:event');

		const result = await handler?.({}, { id: 'event-1' });

		expect(storeMocks.appendAgentRunEvent).toHaveBeenCalledWith({ id: 'event-1' });
		expect(result).toEqual({ success: true, event: { id: 'event-1' } });
	});

	it('lists campaigns with sanitized default options', async () => {
		storeMocks.listCampaigns.mockReturnValue([{ id: 'campaign-1' }]);
		const handler = registeredHandlers.get('campaign:list');

		const result = await handler?.({}, undefined);

		expect(storeMocks.listCampaigns).toHaveBeenCalledWith({});
		expect(result).toEqual({ success: true, campaigns: [{ id: 'campaign-1' }] });
	});

	it('records a campaign through strict store validation', async () => {
		storeMocks.upsertCampaign.mockReturnValue({ id: 'campaign-1' });
		const handler = registeredHandlers.get('campaign:record');

		const result = await handler?.({}, { id: 'campaign-1' });

		expect(storeMocks.upsertCampaign).toHaveBeenCalledWith({ id: 'campaign-1' });
		expect(result).toEqual({ success: true, campaign: { id: 'campaign-1' } });
	});

	it('shows a campaign when it exists', async () => {
		storeMocks.getCampaign.mockReturnValue({ id: 'campaign-1' });
		const handler = registeredHandlers.get('campaign:show');

		const result = await handler?.({}, 'campaign-1');

		expect(storeMocks.getCampaign).toHaveBeenCalledWith('campaign-1');
		expect(result).toEqual({ success: true, campaign: { id: 'campaign-1' } });
	});

	it('returns a not-found response for a missing campaign', async () => {
		storeMocks.getCampaign.mockReturnValue(undefined);
		const handler = registeredHandlers.get('campaign:show');

		const result = await handler?.({}, 'missing-campaign');

		expect(result).toEqual({ success: false, error: 'Campaign not found: missing-campaign' });
	});

	it('keeps cancellation explicit and gated when the destructive-action setting is disabled', async () => {
		settingsStore.get.mockReturnValue({});
		const handler = registeredHandlers.get('agentRun:cancel');

		const result = await handler?.({}, 'run-1');

		expect(settingsStore.get).toHaveBeenCalledWith('encoreFeatures');
		expect(storeMocks.getAgentRun).not.toHaveBeenCalled();
		expect(result).toEqual({ success: false, error: 'gated' });
	});

	it('logs and returns store errors', async () => {
		storeMocks.listAgentRuns.mockImplementation(() => {
			throw new Error('read failed');
		});
		const handler = registeredHandlers.get('agentRun:list');

		const result = await handler?.({}, { status: 'running' });

		expect(loggerMock.error).toHaveBeenCalledWith(
			'list agent runs error',
			'[IPC:AgentRun]',
			expect.objectContaining({ name: 'Error', message: 'read failed' })
		);
		expect(result).toEqual({ success: false, error: 'read failed' });
	});
});
