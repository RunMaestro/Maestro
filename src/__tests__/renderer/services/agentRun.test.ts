import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, AgentRunEvent } from '../../../shared/agent-run';
import type { Campaign } from '../../../shared/campaign';
import { agentRunService } from '../../../renderer/services/agentRun';

const run: AgentRun = {
	id: 'run-1',
	createdAt: 100,
	updatedAt: 200,
	provider: 'claude-code',
	status: 'running',
	artifacts: [],
	touchedFiles: [],
	checks: [],
	reviews: [],
};

const event: AgentRunEvent = {
	id: 'event-1',
	runId: 'run-1',
	timestamp: 300,
	type: 'status',
	message: 'Run started',
};

const campaign: Campaign = {
	id: 'campaign-1',
	title: 'Ship parser',
	createdAt: 100,
	updatedAt: 200,
	status: 'running',
	runIds: ['run-1'],
	tasks: [],
};

function agentRunApi() {
	return window.maestro.agentRun as unknown as {
		list: ReturnType<typeof vi.fn>;
		record: ReturnType<typeof vi.fn>;
		show: ReturnType<typeof vi.fn>;
		events: ReturnType<typeof vi.fn>;
		appendEvent: ReturnType<typeof vi.fn>;
		campaigns: {
			list: ReturnType<typeof vi.fn>;
			record: ReturnType<typeof vi.fn>;
			show: ReturnType<typeof vi.fn>;
		};
	};
}

describe('agentRunService', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('lists runs through the preload API', async () => {
		agentRunApi().list.mockResolvedValue({ success: true, runs: [run] });

		const result = await agentRunService.list({
			status: 'running',
			campaign: 'campaign-1',
			limit: 5,
		});

		expect(agentRunApi().list).toHaveBeenCalledWith({
			status: 'running',
			campaign: 'campaign-1',
			limit: 5,
		});
		expect(result).toEqual([run]);
	});

	it('throws the IPC error when listing runs fails', async () => {
		agentRunApi().list.mockResolvedValue({ success: false, error: 'boom' });

		await expect(agentRunService.list()).rejects.toThrow('boom');
	});

	it('shows a run or throws on failure', async () => {
		agentRunApi()
			.show.mockResolvedValueOnce({ success: true, run })
			.mockResolvedValueOnce({ success: false, error: 'missing' });

		await expect(agentRunService.show('run-1')).resolves.toEqual(run);
		await expect(agentRunService.show('missing-run')).rejects.toThrow('missing');
	});

	it('records runs through the preload API', async () => {
		agentRunApi().record.mockResolvedValue({ success: true, run });

		const result = await agentRunService.record(run);

		expect(agentRunApi().record).toHaveBeenCalledWith(run);
		expect(result).toEqual(run);
	});

	it('reads events through the preload API', async () => {
		agentRunApi().events.mockResolvedValue({ success: true, events: [event] });

		const result = await agentRunService.events('run-1');

		expect(agentRunApi().events).toHaveBeenCalledWith('run-1');
		expect(result).toEqual([event]);
	});

	it('throws the IPC error when reading events fails', async () => {
		agentRunApi().events.mockResolvedValue({ success: false, error: 'events failed' });

		await expect(agentRunService.events('run-1')).rejects.toThrow('events failed');
	});

	it('appends events through the preload API', async () => {
		agentRunApi().appendEvent.mockResolvedValue({ success: true, event });

		const result = await agentRunService.appendEvent(event);

		expect(agentRunApi().appendEvent).toHaveBeenCalledWith(event);
		expect(result).toEqual(event);
	});

	it('lists and shows campaigns through the preload API', async () => {
		agentRunApi().campaigns.list.mockResolvedValue({ success: true, campaigns: [campaign] });
		agentRunApi().campaigns.show.mockResolvedValue({ success: true, campaign });

		await expect(agentRunService.campaigns.list({ status: 'running', limit: 2 })).resolves.toEqual([
			campaign,
		]);
		await expect(agentRunService.campaigns.show('campaign-1')).resolves.toEqual(campaign);
		expect(agentRunApi().campaigns.list).toHaveBeenCalledWith({ status: 'running', limit: 2 });
		expect(agentRunApi().campaigns.show).toHaveBeenCalledWith('campaign-1');
	});

	it('records campaigns through the preload API', async () => {
		agentRunApi().campaigns.record.mockResolvedValue({ success: true, campaign });

		const result = await agentRunService.campaigns.record(campaign);

		expect(agentRunApi().campaigns.record).toHaveBeenCalledWith(campaign);
		expect(result).toEqual(campaign);
	});

	it('throws campaign IPC errors instead of hiding failures', async () => {
		agentRunApi().campaigns.list.mockResolvedValue({ success: false, error: 'boom' });
		agentRunApi().campaigns.show.mockResolvedValue({ success: false, error: 'missing' });

		await expect(agentRunService.campaigns.list()).rejects.toThrow('boom');
		await expect(agentRunService.campaigns.show('missing-campaign')).rejects.toThrow('missing');
	});
});
