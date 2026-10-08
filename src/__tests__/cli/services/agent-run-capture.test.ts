/**
 * @file agent-run-capture.test.ts
 * @description Unit tests for CLI agent-run capture and settlement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	captureCliRun,
	settlementFromAgentResult,
	type CaptureCliRunInput,
} from '../../../cli/services/agent-run-capture';
import { upsertAgentRun, appendAgentRunEvent } from '../../../cli/services/agent-run-store';
import { SIGINT_EXIT_CODE } from '../../../cli/utils/interrupt';
import type { AgentRun } from '../../../shared/agent-run';

vi.mock('../../../cli/services/agent-run-store', () => ({
	upsertAgentRun: vi.fn(),
	appendAgentRunEvent: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

describe('settlementFromAgentResult', () => {
	it('settles interrupted outcome as cancelled with SIGINT exit code', () => {
		const settlement = settlementFromAgentResult({
			success: false,
			outcome: 'interrupted',
			response: 'Stopped',
		});
		expect(settlement).toEqual({
			status: 'cancelled',
			exitCode: SIGINT_EXIT_CODE,
		});
	});

	it('settles successful result as completed with exit code 0', () => {
		const settlement = settlementFromAgentResult({
			success: true,
			outcome: 'completed',
			response: 'Done',
		});
		expect(settlement).toEqual({
			status: 'completed',
			exitCode: 0,
		});
	});

	it('settles failed result as failed with exit code 1', () => {
		const settlement = settlementFromAgentResult({
			success: false,
			outcome: 'failed',
			error: 'Something went wrong',
		});
		expect(settlement).toEqual({
			status: 'failed',
			exitCode: 1,
		});
	});
});

describe('usage on the settled run', () => {
	const usageStats = {
		inputTokens: 120,
		outputTokens: 30,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 5,
		totalCostUsd: 0.0042,
		contextWindow: 200000,
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	const input: CaptureCliRunInput = {
		sessionId: 'session-123',
		toolType: 'claude-code',
		cwd: '/workspace/project',
		source: 'cli:send',
	};

	// `send` writes no history entry, so the ledger is the only place a headless
	// turn's token usage is persisted in the data dir.
	it('records the provider usage on the settled run', async () => {
		await captureCliRun(
			input,
			async () => ({ success: true, outcome: 'completed' as const, usageStats }),
			settlementFromAgentResult
		);
		const settled = vi.mocked(upsertAgentRun).mock.calls[1][0] as AgentRun;
		expect(settled.usage).toEqual(usageStats);
		// The opening snapshot has no usage yet.
		expect((vi.mocked(upsertAgentRun).mock.calls[0][0] as AgentRun).usage).toBeUndefined();
	});

	it('keeps the usage of an interrupted or failed turn', () => {
		expect(
			settlementFromAgentResult({ success: false, outcome: 'interrupted', usageStats }).usage
		).toEqual(usageStats);
		expect(
			settlementFromAgentResult({ success: false, outcome: 'failed', usageStats }).usage
		).toEqual(usageStats);
	});

	it('leaves usage absent rather than inventing a zero record', async () => {
		await captureCliRun(
			input,
			async () => ({ success: true, outcome: 'completed' as const }),
			settlementFromAgentResult
		);
		const settled = vi.mocked(upsertAgentRun).mock.calls[1][0] as AgentRun;
		expect(settled).not.toHaveProperty('usage');
	});
});

describe('captureCliRun', () => {
	const sampleInput: CaptureCliRunInput = {
		sessionId: 'session-123',
		toolType: 'claude-code',
		cwd: '/workspace/project',
		prompt: 'Implement feature',
		source: 'cli:send',
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('opens run with running status and settles to completed on success', async () => {
		const result = await captureCliRun(
			sampleInput,
			async () => ({ success: true, outcome: 'completed' as const }),
			settlementFromAgentResult
		);

		expect(result).toEqual({ success: true, outcome: 'completed' });
		expect(upsertAgentRun).toHaveBeenCalledTimes(2);

		const firstUpsert = vi.mocked(upsertAgentRun).mock.calls[0][0] as AgentRun;
		expect(firstUpsert.status).toBe('running');
		expect(firstUpsert.sessionId).toBe('session-123');
		expect(firstUpsert.provider).toBe('claude-code');
		expect(firstUpsert.source).toBe('cli:send');

		const secondUpsert = vi.mocked(upsertAgentRun).mock.calls[1][0] as AgentRun;
		expect(secondUpsert.status).toBe('completed');
		expect(secondUpsert.metadata?.exitCode).toBe(0);

		expect(appendAgentRunEvent).toHaveBeenCalledTimes(2);
		expect(vi.mocked(appendAgentRunEvent).mock.calls[0][0].status).toBe('running');
		expect(vi.mocked(appendAgentRunEvent).mock.calls[1][0].status).toBe('completed');
	});

	it('settles run to cancelled when turn was interrupted by operator', async () => {
		await captureCliRun(
			sampleInput,
			async () => ({ success: false, outcome: 'interrupted' as const }),
			settlementFromAgentResult
		);

		expect(upsertAgentRun).toHaveBeenCalledTimes(2);
		const secondUpsert = vi.mocked(upsertAgentRun).mock.calls[1][0] as AgentRun;
		expect(secondUpsert.status).toBe('cancelled');
		expect(secondUpsert.metadata?.exitCode).toBe(130);

		const secondEvent = vi.mocked(appendAgentRunEvent).mock.calls[1][0];
		expect(secondEvent.status).toBe('cancelled');
		expect(secondEvent.data?.exitCode).toBe(130);
	});

	it('settles run to failed when result indicates failure', async () => {
		await captureCliRun(
			sampleInput,
			async () => ({ success: false, outcome: 'failed' as const, error: 'syntax error' }),
			settlementFromAgentResult
		);

		expect(upsertAgentRun).toHaveBeenCalledTimes(2);
		const secondUpsert = vi.mocked(upsertAgentRun).mock.calls[1][0] as AgentRun;
		expect(secondUpsert.status).toBe('failed');
		expect(secondUpsert.metadata?.exitCode).toBe(1);
	});

	it('settles run to failed when resolveSettlement throws an exception', async () => {
		await captureCliRun(
			sampleInput,
			async () => ({ success: true }),
			() => {
				throw new Error('extractor exploded');
			}
		);

		const secondUpsert = vi.mocked(upsertAgentRun).mock.calls[1][0] as AgentRun;
		expect(secondUpsert.status).toBe('failed');
		expect(secondUpsert.metadata?.exitCode).toBe(1);
	});

	it('settles run to failed when wrapped action throws and re-throws the error', async () => {
		const actionError = new Error('Spawn process crashed');
		await expect(
			captureCliRun(
				sampleInput,
				async () => {
					throw actionError;
				},
				() => ({ status: 'completed', exitCode: 0 })
			)
		).rejects.toThrow(actionError);

		expect(upsertAgentRun).toHaveBeenCalledTimes(2);
		const secondUpsert = vi.mocked(upsertAgentRun).mock.calls[1][0] as AgentRun;
		expect(secondUpsert.status).toBe('failed');
		expect(secondUpsert.metadata?.exitCode).toBe(1);
	});

	it('swallows ledger exceptions and completes execution safely', async () => {
		vi.mocked(upsertAgentRun).mockImplementation(() => {
			throw new Error('Disk full');
		});

		const result = await captureCliRun(
			sampleInput,
			async () => ({ success: true }),
			() => ({ status: 'completed', exitCode: 0 })
		);

		expect(result).toEqual({ success: true });
	});
});
