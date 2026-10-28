/**
 * @file synopsis.test.ts
 * @description Tests for the CLI synopsis turn shared by `send` and Auto Run.
 *
 * Covers:
 * - What the turn is spawned with (prompt, resumed session, model, permissions)
 * - Which results count as a usable synopsis and which return null
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionInfo } from '../../../shared/types';

vi.mock('../../../cli/services/agent-spawner', () => ({
	spawnAgent: vi.fn(),
}));

// The ledger write is not under test; run the turn and hand its result back.
vi.mock('../../../cli/services/agent-run-capture', () => ({
	captureCliRun: vi.fn(async (_input: unknown, run: () => Promise<unknown>) => run()),
	settlementFromAgentResult: vi.fn(),
}));

vi.mock('../../../cli/services/prompt-loader', () => ({
	getCliPrompt: vi.fn().mockResolvedValue('SYNOPSIS PROMPT'),
}));

import { requestCliSynopsis } from '../../../cli/services/synopsis';
import { spawnAgent } from '../../../cli/services/agent-spawner';
import { captureCliRun } from '../../../cli/services/agent-run-capture';
import { getCliPrompt } from '../../../cli/services/prompt-loader';
import { PROMPT_IDS } from '../../../shared/promptDefinitions';

const mockSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
	id: 'agent-abc-123',
	name: 'Test Agent',
	toolType: 'claude-code',
	cwd: '/path/to/project',
	projectRoot: '/path/to/project',
	...overrides,
});

const SYNOPSIS = '**Summary:** Fixed the parser.\n\n**Details:** Rewrote the tokenizer loop.';

describe('requestCliSynopsis', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(spawnAgent).mockResolvedValue({ success: true, response: SYNOPSIS });
	});

	it('resumes the finished session with the synopsis prompt and records the run under its source', async () => {
		const result = await requestCliSynopsis(mockSession(), 'session-xyz', {
			source: 'cli:send-synopsis',
		});

		expect(getCliPrompt).toHaveBeenCalledWith(PROMPT_IDS.AUTORUN_SYNOPSIS);
		const call = vi.mocked(spawnAgent).mock.calls[0];
		expect(call[0]).toBe('claude-code');
		expect(call[1]).toBe('/path/to/project');
		expect(call[2]).toBe('SYNOPSIS PROMPT');
		expect(call[3]).toBe('session-xyz');
		expect(vi.mocked(captureCliRun).mock.calls[0][0]).toMatchObject({
			sessionId: 'session-xyz',
			toolType: 'claude-code',
			cwd: '/path/to/project',
			source: 'cli:send-synopsis',
		});
		expect(result).toEqual({
			shortSummary: 'Fixed the parser.',
			fullSynopsis: expect.stringContaining('Rewrote the tokenizer loop.'),
		});
	});

	it('runs at the bottom of both ladders and is never marked as a typed turn', async () => {
		await requestCliSynopsis(mockSession({ customModel: 'opus', customEffort: 'max' }), 's', {
			source: 'cli:send-synopsis',
		});

		const opts = vi.mocked(spawnAgent).mock.calls[0][4];
		expect(opts).toMatchObject({ customModel: 'haiku', customEffort: 'low', querySource: 'auto' });
		// The resumed session already holds the system prompt.
		expect(opts?.appendSystemPrompt).toBeUndefined();
	});

	it('keeps the agent model when the cheap tier would shrink the context window', async () => {
		await requestCliSynopsis(mockSession({ customModel: 'opus[1m]' }), 's', {
			source: 'cli:send-synopsis',
		});

		expect(vi.mocked(spawnAgent).mock.calls[0][4]).toMatchObject({
			customModel: 'opus[1m]',
			customEffort: 'low',
		});
	});

	it('sizes the window from what the turn ran at, not from the agent default', async () => {
		// A run override put the summarized turn on the 1M model, so its
		// transcript no longer fits the cheap one even though the agent's own
		// model would have.
		await requestCliSynopsis(mockSession({ customModel: 'sonnet' }), 's', {
			source: 'cli:autorun-synopsis',
			model: 'opus[1m]',
		});

		expect(vi.mocked(spawnAgent).mock.calls[0][4]).toMatchObject({ customModel: 'opus[1m]' });
	});

	it('inherits what the turn ran at on a provider with no cheap tier', async () => {
		await requestCliSynopsis(
			mockSession({ toolType: 'opencode', customModel: 'agent-model', customEffort: 'agent' }),
			's',
			{ source: 'cli:autorun-synopsis', model: 'run-model', effort: 'run' }
		);

		expect(vi.mocked(spawnAgent).mock.calls[0][4]).toMatchObject({
			customModel: 'run-model',
			customEffort: 'run',
		});
	});

	it("runs on the agent's Run on target, where the conversation it resumes ran", async () => {
		const runOn = { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' };

		await requestCliSynopsis(mockSession({ runOn } as never), 's', {
			source: 'cli:send-synopsis',
		});

		// On the provider's model the synopsis would send the whole conversation
		// to the provider's cloud. The spawner swaps its cheap model for the target's.
		expect(vi.mocked(spawnAgent).mock.calls[0][4]).toMatchObject({ runOn });
	});

	it("runs where the summarized turn ran when a tier's target decided it", async () => {
		const own = { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' };

		// A `high` task of a source agent ran on the provider: so does its synopsis.
		await requestCliSynopsis(mockSession({ runOn: own } as never), 's', {
			source: 'cli:autorun-synopsis',
			runOn: { type: 'provider' },
		});

		expect(vi.mocked(spawnAgent).mock.calls[0][4]).toMatchObject({ runOn: { type: 'provider' } });
	});

	it('keeps a read-only turn read-only', async () => {
		await requestCliSynopsis(mockSession(), 's', {
			source: 'cli:send-synopsis',
			readOnlyMode: true,
		});
		expect(vi.mocked(spawnAgent).mock.calls[0][4]).toMatchObject({ readOnlyMode: true });

		vi.mocked(spawnAgent).mockClear();
		await requestCliSynopsis(mockSession(), 's', { source: 'cli:send-synopsis' });
		expect(vi.mocked(spawnAgent).mock.calls[0][4]?.readOnlyMode).toBeUndefined();
	});

	it('forwards the agent configuration and the abort signal', async () => {
		const controller = new AbortController();
		const sshRemoteConfig = { enabled: true, remoteId: 'remote-1' };
		const additionalDirectories = [{ path: '/extra', read: true, write: false }];
		await requestCliSynopsis(
			mockSession({
				customArgs: '--flag',
				customEnvVars: { KEY: 'value' },
				additionalDirectories,
				sessionSshRemoteConfig: sshRemoteConfig,
				enableMaestroP: true,
				maestroPMode: 'dynamic',
				maestroPPath: '/bin/maestro-p',
			}),
			's',
			{ source: 'cli:send-synopsis', signal: controller.signal }
		);

		const opts = vi.mocked(spawnAgent).mock.calls[0][4];
		expect(opts).toMatchObject({
			customArgs: '--flag',
			customEnvVars: { KEY: 'value' },
			additionalDirectories,
			sshRemoteConfig,
			enableMaestroP: true,
			maestroPMode: 'dynamic',
			maestroPPath: '/bin/maestro-p',
		});
		expect(opts?.signal).toBe(controller.signal);
	});

	it('returns null when the synopsis turn fails', async () => {
		vi.mocked(spawnAgent).mockResolvedValue({ success: false, error: 'boom' });
		expect(
			await requestCliSynopsis(mockSession(), 's', { source: 'cli:send-synopsis' })
		).toBeNull();
	});

	it('returns null when the turn produced no text', async () => {
		vi.mocked(spawnAgent).mockResolvedValue({ success: true, response: '' });
		expect(
			await requestCliSynopsis(mockSession(), 's', { source: 'cli:send-synopsis' })
		).toBeNull();
	});

	it('returns null for a bare provider error printed as a successful response', async () => {
		vi.mocked(spawnAgent).mockResolvedValue({ success: true, response: 'Prompt is too long' });
		expect(
			await requestCliSynopsis(mockSession(), 's', { source: 'cli:send-synopsis' })
		).toBeNull();
	});

	it('returns null when the agent reports nothing to record', async () => {
		vi.mocked(spawnAgent).mockResolvedValue({ success: true, response: 'NOTHING_TO_REPORT' });
		expect(
			await requestCliSynopsis(mockSession(), 's', { source: 'cli:send-synopsis' })
		).toBeNull();
	});
});
