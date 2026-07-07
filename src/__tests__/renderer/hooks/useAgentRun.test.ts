import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, AgentRunEvent } from '../../../shared/agent-run';
import type { Campaign } from '../../../shared/campaign';
import { useAgentRun } from '../../../renderer/hooks/agentRun/useAgentRun';

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
		show: ReturnType<typeof vi.fn>;
		events: ReturnType<typeof vi.fn>;
		campaigns: {
			list: ReturnType<typeof vi.fn>;
			show: ReturnType<typeof vi.fn>;
		};
	};
}

describe('useAgentRun', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		agentRunApi().list.mockResolvedValue({ success: true, runs: [run] });
		agentRunApi().show.mockResolvedValue({ success: true, run });
		agentRunApi().events.mockResolvedValue({ success: true, events: [event] });
		agentRunApi().campaigns.list.mockResolvedValue({ success: true, campaigns: [campaign] });
		agentRunApi().campaigns.show.mockResolvedValue({ success: true, campaign });
	});

	it('loads runs and campaigns on mount', async () => {
		const { result } = renderHook(() => useAgentRun());

		await waitFor(() => expect(result.current.loading).toBe(false));

		expect(result.current.runs).toEqual([run]);
		expect(result.current.campaigns).toEqual([campaign]);
		expect(agentRunApi().list).toHaveBeenCalledWith(undefined);
		expect(agentRunApi().campaigns.list).toHaveBeenCalledWith(undefined);
	});

	it('passes filter options into manual refreshes', async () => {
		const { result } = renderHook(() => useAgentRun({ loadOnMount: false }));

		await act(async () => {
			await result.current.refreshRuns({ status: 'running', campaign: 'campaign-1', limit: 2 });
			await result.current.refreshCampaigns({ status: 'running', limit: 3 });
		});

		expect(agentRunApi().list).toHaveBeenCalledWith({
			status: 'running',
			campaign: 'campaign-1',
			limit: 2,
		});
		expect(agentRunApi().campaigns.list).toHaveBeenCalledWith({ status: 'running', limit: 3 });
		expect(result.current.runs).toEqual([run]);
		expect(result.current.campaigns).toEqual([campaign]);
	});

	it('shows a run and loads its events on demand', async () => {
		const { result } = renderHook(() => useAgentRun({ loadOnMount: false }));

		await act(async () => {
			await result.current.showRun('run-1');
			await result.current.loadRunEvents('run-1');
		});

		expect(agentRunApi().show).toHaveBeenCalledWith('run-1');
		expect(agentRunApi().events).toHaveBeenCalledWith('run-1');
		expect(result.current.selectedRun).toEqual(run);
		expect(result.current.selectedRunEvents).toEqual([event]);
	});

	it('shows one campaign and clears selected state', async () => {
		const { result } = renderHook(() => useAgentRun({ loadOnMount: false }));

		await act(async () => {
			await result.current.showCampaign('campaign-1');
		});

		expect(result.current.selectedCampaign).toEqual(campaign);

		act(() => {
			result.current.clearSelection();
		});

		expect(result.current.selectedRun).toBeNull();
		expect(result.current.selectedRunEvents).toEqual([]);
		expect(result.current.selectedCampaign).toBeNull();
	});

	it('surfaces service errors without replacing current state', async () => {
		const { result } = renderHook(() => useAgentRun({ loadOnMount: false }));

		await act(async () => {
			await result.current.refreshRuns();
		});

		agentRunApi().list.mockResolvedValue({ success: false, error: 'read failed' });

		await act(async () => {
			const runs = await result.current.refreshRuns();
			expect(runs).toEqual([]);
		});

		expect(result.current.runs).toEqual([run]);
		expect(result.current.error).toBe('read failed');
	});
});
