import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/agent-run-store', () => ({
	appendAgentRunEvent: vi.fn(),
	getAgentRun: vi.fn(),
	getCampaign: vi.fn(),
	listAgentRuns: vi.fn(),
	listCampaigns: vi.fn(),
	readAgentRunEvents: vi.fn(),
	upsertAgentRun: vi.fn(),
	upsertCampaign: vi.fn(),
}));

import {
	agentRunAppendEvent,
	agentRunList,
	agentRunRecord,
	agentRunShow,
	campaignList,
	campaignRecord,
	campaignShow,
} from '../../../cli/commands/agent-run';
import {
	appendAgentRunEvent,
	getAgentRun,
	getCampaign,
	listAgentRuns,
	listCampaigns,
	readAgentRunEvents,
	upsertAgentRun,
	upsertCampaign,
} from '../../../cli/services/agent-run-store';

describe('agent-run command surface', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;
	let tempDir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		tempDir = mkdtempSync(join(tmpdir(), 'maestro-agent-run-cli-'));
	});

	afterEach(() => {
		consoleSpy.mockRestore();
		processExitSpy.mockRestore();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeJsonFile(name: string, value: unknown): string {
		const filePath = join(tempDir, name);
		writeFileSync(filePath, JSON.stringify(value), 'utf8');
		return filePath;
	}

	it('records a valid agent run from --file and preserves future provider metadata', () => {
		const run = {
			id: 'run-1',
			createdAt: 1714268000000,
			updatedAt: 1714268000000,
			provider: 'future-provider',
			status: 'running',
			artifacts: [],
			touchedFiles: [],
			checks: [],
			reviews: [],
			metadata: { plugin: 'pianola-adapter' },
		};
		const filePath = writeJsonFile('run.json', run);
		vi.mocked(upsertAgentRun).mockReturnValue(run as never);

		agentRunRecord({ file: filePath, json: true });

		expect(upsertAgentRun).toHaveBeenCalledWith(run);
		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output).toEqual({ success: true, run });
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('returns scriptable JSON for malformed agent run JSON', () => {
		const filePath = join(tempDir, 'bad.json');
		writeFileSync(filePath, '{bad json', 'utf8');

		agentRunRecord({ file: filePath, json: true });

		expect(upsertAgentRun).not.toHaveBeenCalled();
		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('INVALID_JSON');
		expect(output.error).toContain('Invalid JSON');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('returns scriptable JSON when the agent run file is missing', () => {
		agentRunRecord({ file: join(tempDir, 'missing.json'), json: true });

		expect(upsertAgentRun).not.toHaveBeenCalled();
		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output).toMatchObject({
			success: false,
			code: 'FILE_NOT_FOUND',
		});
		expect(output.error).toContain('File not found');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('rejects agent runs with malformed child evidence instead of dropping it', () => {
		const filePath = writeJsonFile('run-with-bad-check.json', {
			id: 'run-1',
			createdAt: 1714268000000,
			updatedAt: 1714268000000,
			provider: 'claude-code',
			status: 'running',
			artifacts: [],
			touchedFiles: [],
			checks: [{ status: 'passed' }],
			reviews: [],
		});

		agentRunRecord({ file: filePath, json: true });

		expect(upsertAgentRun).not.toHaveBeenCalled();
		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output).toMatchObject({ success: false, code: 'INVALID_AGENT_RUN' });
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('appends an event with a status update payload', () => {
		vi.mocked(appendAgentRunEvent).mockImplementation((event) => event as never);

		agentRunAppendEvent('run-1', {
			type: 'status_change',
			status: 'needs_review',
			message: 'Ready for review',
			json: true,
		});

		expect(appendAgentRunEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: 'run-1',
				type: 'status_change',
				status: 'needs_review',
				message: 'Ready for review',
			})
		);
		const event = vi.mocked(appendAgentRunEvent).mock.calls[0][0];
		expect(event.id).toMatch(/^evt_/);
		expect(Number.isFinite(event.timestamp)).toBe(true);
		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(true);
		expect(output.event.status).toBe('needs_review');
	});

	it('passes list filters through to the store', () => {
		vi.mocked(listAgentRuns).mockReturnValue([]);

		agentRunList({ status: 'running', campaign: 'camp-1', limit: '25', json: true });

		expect(listAgentRuns).toHaveBeenCalledWith({
			status: 'running',
			campaignId: 'camp-1',
			limit: 25,
		});
		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output).toEqual({ success: true, runs: [] });
	});

	it('returns a missing-run error for show', () => {
		vi.mocked(getAgentRun).mockReturnValue(undefined);

		agentRunShow('missing-run', { json: true });

		expect(readAgentRunEvents).not.toHaveBeenCalled();
		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output).toEqual({
			success: false,
			error: 'Agent run not found: missing-run',
			code: 'AGENT_RUN_NOT_FOUND',
		});
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('renders a concise text list output', () => {
		vi.mocked(listAgentRuns).mockReturnValue([
			{
				id: 'run-1',
				createdAt: 1714268000000,
				updatedAt: 1714269000000,
				provider: 'claude-code',
				agentName: 'Reviewer',
				status: 'completed',
				artifacts: [],
				touchedFiles: [],
				checks: [],
				reviews: [],
			},
		] as never);

		agentRunList({});

		expect(consoleSpy.mock.calls[0][0]).toBe('run-1  completed  claude-code  Reviewer');
	});

	it('shows a run plus events as JSON', () => {
		const run = {
			id: 'run-1',
			createdAt: 1714268000000,
			updatedAt: 1714269000000,
			provider: 'codex',
			status: 'running',
			artifacts: [],
			touchedFiles: [],
			checks: [],
			reviews: [],
		};
		const events = [{ id: 'evt-1', runId: 'run-1', timestamp: 1714269000000, type: 'started' }];
		vi.mocked(getAgentRun).mockReturnValue(run as never);
		vi.mocked(readAgentRunEvents).mockReturnValue(events as never);

		agentRunShow('run-1', { json: true });

		expect(readAgentRunEvents).toHaveBeenCalledWith('run-1');
		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output).toEqual({ success: true, run, events });
	});
});

describe('campaign command surface', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;
	let tempDir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		tempDir = mkdtempSync(join(tmpdir(), 'maestro-campaign-cli-'));
	});

	afterEach(() => {
		consoleSpy.mockRestore();
		processExitSpy.mockRestore();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeJsonFile(name: string, value: unknown): string {
		const filePath = join(tempDir, name);
		writeFileSync(filePath, JSON.stringify(value), 'utf8');
		return filePath;
	}

	it('records a valid campaign from --file', () => {
		const campaign = {
			id: 'camp-1',
			title: 'Fix parser',
			createdAt: 1714268000000,
			updatedAt: 1714269000000,
			status: 'running',
			runIds: ['run-1'],
			tasks: [],
		};
		const filePath = writeJsonFile('campaign.json', campaign);
		vi.mocked(upsertCampaign).mockReturnValue(campaign as never);

		campaignRecord({ file: filePath, json: true });

		expect(upsertCampaign).toHaveBeenCalledWith(campaign);
		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output).toEqual({ success: true, campaign });
	});

	it('rejects campaigns with malformed tasks instead of dropping them', () => {
		const filePath = writeJsonFile('campaign-with-bad-task.json', {
			id: 'camp-1',
			title: 'Fix parser',
			createdAt: 1714268000000,
			updatedAt: 1714269000000,
			status: 'running',
			runIds: ['run-1'],
			tasks: [{ id: 'task-1', title: 'Bad task', status: 'not-real', dependsOn: [] }],
		});

		campaignRecord({ file: filePath, json: true });

		expect(upsertCampaign).not.toHaveBeenCalled();
		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output).toMatchObject({ success: false, code: 'INVALID_CAMPAIGN' });
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('passes campaign list filters through to the store', () => {
		vi.mocked(listCampaigns).mockReturnValue([]);

		campaignList({ status: 'needs_review', limit: '5', json: true });

		expect(listCampaigns).toHaveBeenCalledWith({ status: 'needs_review', limit: 5 });
		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output).toEqual({ success: true, campaigns: [] });
	});

	it('shows a campaign as JSON', () => {
		const campaign = {
			id: 'camp-1',
			title: 'Fix parser',
			createdAt: 1714268000000,
			updatedAt: 1714269000000,
			status: 'complete',
			runIds: ['run-1'],
			tasks: [],
		};
		vi.mocked(getCampaign).mockReturnValue(campaign as never);

		campaignShow('camp-1', { json: true });

		expect(getCampaign).toHaveBeenCalledWith('camp-1');
		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output).toEqual({ success: true, campaign });
	});

	it('renders a concise campaign text list output', () => {
		vi.mocked(listCampaigns).mockReturnValue([
			{
				id: 'camp-1',
				title: 'Fix parser',
				createdAt: 1714268000000,
				updatedAt: 1714269000000,
				status: 'running',
				runIds: [],
				tasks: [],
			},
		] as never);

		campaignList({});

		expect(consoleSpy.mock.calls[0][0]).toBe('camp-1  running  Fix parser');
	});
});
