import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	authorRunReport,
	type AuthorRunReportParams,
} from '../../../../renderer/hooks/batch/internal/batchRunReport';
import { buildFinalSummaryFacts } from '../../../../shared/playbookRunReport';
import { cheapTurnSettings } from '../../../../shared/modelTiers';
import type { Session } from '../../../../renderer/types';

const NARRATIVE = {
	version: 1,
	sections: [
		{ kind: 'accomplishments', title: 'Accomplishments', items: [{ text: 'Installed it.' }] },
	],
};

const REPORT_ANSWER = [
	'```json',
	JSON.stringify(NARRATIVE),
	'```',
	'',
	'## How to use it',
	'',
	'Run `bus send hi`.',
	'',
	'## Next steps',
	'',
	'- Send a message.',
].join('\n');

const usageStats = {
	inputTokens: 5,
	outputTokens: 7,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	totalCostUsd: 0.002,
	contextWindow: 0,
};

const session = {
	id: 'agent-1',
	name: 'Agent',
	toolType: 'claude-code',
	cwd: '/repo',
	groupId: undefined,
	activeTabId: 'tab-1',
} as unknown as Session;

function makeParams(overrides: Partial<AuthorRunReportParams> = {}): AuthorRunReportParams {
	return {
		session,
		folderPath: '/repo/docs',
		effectiveCwd: '/repo',
		playbookName: 'Message Bus',
		status: 'completed',
		facts: buildFinalSummaryFacts({
			wasStopped: false,
			totalCompletedTasks: 2,
			totalElapsedMs: 1_000,
			stalledDocuments: new Map(),
			documents: [{ filename: 'bus/one' }],
			loopEnabled: false,
			loopIteration: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCost: 0,
		}),
		synopses: [{ document: 'bus/one', summary: 'Wrote the scanner.', success: true }],
		onSpawnAgent: vi.fn().mockResolvedValue({ success: true, response: REPORT_ANSWER, usageStats }),
		...overrides,
	};
}

function autorunApi() {
	return window.maestro.autorun as unknown as { readDoc: ReturnType<typeof vi.fn> };
}

function promptsApi() {
	return window.maestro.prompts as unknown as { get: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
	vi.clearAllMocks();
	promptsApi().get.mockImplementation(async (id: string) => ({
		success: true,
		content:
			id === 'playbook-report-document'
				? 'DOC {{PLAYBOOK_NAME}} @ {{REPORT_DOCUMENT_PATH}}\n{{REPORT_DOCUMENT}}\n{{RUN_FACTS}}'
				: 'SYN {{PLAYBOOK_NAME}}\n{{TASK_SYNOPSES}}',
	}));
});

describe('authorRunReport', () => {
	it.each(['failed', 'stopped'] as const)('writes nothing for a %s run', async (status) => {
		const params = makeParams({ status, reportDocument: 'bus/REPORT' });
		await expect(authorRunReport(params)).resolves.toEqual({});
		expect(params.onSpawnAgent).not.toHaveBeenCalled();
		expect(autorunApi().readDoc).not.toHaveBeenCalled();
	});

	it('runs the report document once and reads back all three parts', async () => {
		autorunApi().readDoc.mockResolvedValueOnce({
			success: true,
			content: 'Explain how to use the bus at [BUS_DIR].',
		});
		const params = makeParams({
			reportDocument: 'bus/REPORT',
			sshRemoteId: 'remote-1',
			runModel: 'opus',
			playbookParams: {
				specs: [{ name: 'BUS_DIR', type: 'string', required: true, source: 'prose' }],
				values: { BUS_DIR: '~/bus' },
			},
		});

		const result = await authorRunReport(params);

		expect(autorunApi().readDoc).toHaveBeenCalledWith('/repo/docs', 'bus/REPORT.md', 'remote-1');
		expect(params.onSpawnAgent).toHaveBeenCalledTimes(1);
		const [agentId, prompt, cwd, turn] = vi.mocked(params.onSpawnAgent).mock.calls[0];
		expect(agentId).toBe('agent-1');
		expect(cwd).toBe('/repo');
		expect(turn).toEqual({ modelOverride: 'opus' });
		expect(prompt).toContain('DOC Message Bus @ /repo/docs/bus/REPORT.md');
		// Parameters are substituted in memory before the document reaches the agent.
		expect(prompt).toContain('Explain how to use the bus at ~/bus.');
		expect(prompt).toContain('- Status: Completed');

		expect(result).toEqual({
			narrative: NARRATIVE,
			howToUse: 'Run `bus send hi`.',
			nextSteps: ['Send a message.'],
			usageStats,
		});
	});

	it('narrates a partial run too', async () => {
		autorunApi().readDoc.mockResolvedValueOnce({ success: true, content: 'Report.' });
		const result = await authorRunReport(
			makeParams({ status: 'partial', reportDocument: 'bus/REPORT' })
		);
		expect(result.narrative).toEqual(NARRATIVE);
	});

	it('synthesizes from the synopses on the cheap tier when there is no report document', async () => {
		const params = makeParams({
			onSpawnAgent: vi
				.fn()
				.mockResolvedValue({ success: true, response: JSON.stringify(NARRATIVE), usageStats }),
		});

		const result = await authorRunReport(params);

		expect(autorunApi().readDoc).not.toHaveBeenCalled();
		const [, prompt, , turn] = vi.mocked(params.onSpawnAgent).mock.calls[0];
		expect(prompt).toBe('SYN Message Bus\n- [bus/one] Wrote the scanner.');
		const cheap = cheapTurnSettings('claude-code');
		expect(turn).toEqual({
			...(cheap.model && { modelOverride: cheap.model }),
			...(cheap.effort && { effortOverride: cheap.effort }),
		});
		// A synthesis writes the narrative only; the authored sections stay absent.
		expect(result).toEqual({ narrative: NARRATIVE, usageStats });
	});

	it('synthesizes when the report document cannot be read', async () => {
		autorunApi().readDoc.mockResolvedValueOnce({ success: false, error: 'ENOENT' });
		const params = makeParams({
			reportDocument: 'bus/REPORT',
			onSpawnAgent: vi
				.fn()
				.mockResolvedValue({ success: true, response: JSON.stringify(NARRATIVE) }),
		});

		const result = await authorRunReport(params);

		expect(vi.mocked(params.onSpawnAgent).mock.calls[0][1]).toMatch(/^SYN /);
		expect(result.narrative).toEqual(NARRATIVE);
	});

	it('spends no turn when there is nothing to synthesize', async () => {
		const params = makeParams({ synopses: [{ document: 'bus/one', summary: ' ', success: true }] });
		await expect(authorRunReport(params)).resolves.toEqual({});
		expect(params.onSpawnAgent).not.toHaveBeenCalled();
	});

	it('keeps the cost but no narrative when the turn fails', async () => {
		const params = makeParams({
			onSpawnAgent: vi.fn().mockResolvedValue({ success: false, error: 'boom', usageStats }),
		});
		await expect(authorRunReport(params)).resolves.toEqual({ usageStats });
	});

	it('never throws: a prompt that cannot load costs only the narrative', async () => {
		promptsApi().get.mockResolvedValue({ success: false, error: 'missing' });
		const params = makeParams();
		await expect(authorRunReport(params)).resolves.toEqual({});
		expect(params.onSpawnAgent).not.toHaveBeenCalled();
	});
});
