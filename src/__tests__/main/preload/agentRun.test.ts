import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createAgentRunApi } from '../../../main/preload/agentRun';

describe('AgentRun Preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('lists agent runs through IPC with filters', async () => {
		mockInvoke.mockResolvedValue({ success: true, runs: [] });
		const api = createAgentRunApi();

		const result = await api.list({ status: 'running', campaign: 'campaign-1', limit: 5 });

		expect(mockInvoke).toHaveBeenCalledWith('agentRun:list', {
			status: 'running',
			campaign: 'campaign-1',
			limit: 5,
		});
		expect(result).toEqual({ success: true, runs: [] });
	});

	it('records one run through IPC', async () => {
		mockInvoke.mockResolvedValue({ success: true, run: { id: 'run-1' } });
		const api = createAgentRunApi();

		const result = await api.record({ id: 'run-1' } as never);

		expect(mockInvoke).toHaveBeenCalledWith('agentRun:record', { id: 'run-1' });
		expect(result).toEqual({ success: true, run: { id: 'run-1' } });
	});

	it('shows one run through IPC', async () => {
		mockInvoke.mockResolvedValue({ success: false, error: 'Run not found: run-1' });
		const api = createAgentRunApi();

		const result = await api.show('run-1');

		expect(mockInvoke).toHaveBeenCalledWith('agentRun:show', 'run-1');
		expect(result).toEqual({ success: false, error: 'Run not found: run-1' });
	});

	it('reads run events through IPC', async () => {
		mockInvoke.mockResolvedValue({ success: true, events: [] });
		const api = createAgentRunApi();

		const result = await api.events('run-1');

		expect(mockInvoke).toHaveBeenCalledWith('agentRun:events', 'run-1');
		expect(result).toEqual({ success: true, events: [] });
	});

	it('appends one run event through IPC', async () => {
		mockInvoke.mockResolvedValue({ success: true, event: { id: 'event-1' } });
		const api = createAgentRunApi();

		const result = await api.appendEvent({ id: 'event-1' } as never);

		expect(mockInvoke).toHaveBeenCalledWith('agentRun:event', { id: 'event-1' });
		expect(result).toEqual({ success: true, event: { id: 'event-1' } });
	});

	it('lists campaigns through nested IPC API with filters', async () => {
		mockInvoke.mockResolvedValue({ success: true, campaigns: [] });
		const api = createAgentRunApi();

		const result = await api.campaigns.list({ status: 'needs_review', limit: 10 });

		expect(mockInvoke).toHaveBeenCalledWith('campaign:list', {
			status: 'needs_review',
			limit: 10,
		});
		expect(result).toEqual({ success: true, campaigns: [] });
	});

	it('records one campaign through nested IPC API', async () => {
		mockInvoke.mockResolvedValue({ success: true, campaign: { id: 'campaign-1' } });
		const api = createAgentRunApi();

		const result = await api.campaigns.record({ id: 'campaign-1' } as never);

		expect(mockInvoke).toHaveBeenCalledWith('campaign:record', { id: 'campaign-1' });
		expect(result).toEqual({ success: true, campaign: { id: 'campaign-1' } });
	});

	it('shows one campaign through nested IPC API', async () => {
		mockInvoke.mockResolvedValue({ success: true, campaign: { id: 'campaign-1' } });
		const api = createAgentRunApi();

		const result = await api.campaigns.show('campaign-1');

		expect(mockInvoke).toHaveBeenCalledWith('campaign:show', 'campaign-1');
		expect(result).toEqual({ success: true, campaign: { id: 'campaign-1' } });
	});
});
