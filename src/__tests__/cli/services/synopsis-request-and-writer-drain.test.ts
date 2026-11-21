// Source: src/__tests__/cli/services/synopsis.test.ts
// Source: src/main/process-manager/utils/__tests__/synopsisWriterGate.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import type { SessionInfo } from '../../../shared/types';
import { requestCliSynopsis } from '../../../cli/services/synopsis';
import { spawnAgent } from '../../../cli/services/agent-spawner';
import { captureCliRun } from '../../../cli/services/agent-run-capture';
import { getCliPrompt } from '../../../cli/services/prompt-loader';
import { PROMPT_IDS } from '../../../shared/promptDefinitions';
import { EventEmitter } from 'events';
import { afterEach } from 'vitest';
import { awaitSynopsisWriters } from '../../../main/process-manager/utils/synopsisWriterGate';
vi.mock('../../../cli/services/agent-spawner', () => ({
	spawnAgent: vi.fn(),
}));
vi.mock('../../../cli/services/agent-run-capture', () => ({
	captureCliRun: vi.fn(async (_input: unknown, run: () => Promise<unknown>) => run()),
	settlementFromAgentResult: vi.fn(),
}));
vi.mock('../../../cli/services/prompt-loader', () => ({
	getCliPrompt: vi.fn().mockResolvedValue('SYNOPSIS PROMPT'),
}));
describe('synopsis', () => {
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
			expect(opts).toMatchObject({
				customModel: 'haiku',
				customEffort: 'low',
				querySource: 'auto',
			});
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
					customPath: '/agent/bin/claude',
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
				sessionCustomPath: '/agent/bin/claude',
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
});
describe('synopsisWriterGate', () => {
	type FakeProcess = { sessionId: string; agentSessionId?: string };

	function makeRegistry(initial: FakeProcess[]) {
		const processes = new Map(initial.map((p) => [p.sessionId, p]));
		const emitter = new EventEmitter();
		const exit = (sessionId: string) => {
			processes.delete(sessionId);
			emitter.emit('exit', sessionId, 0);
		};
		const registry = {
			getAll: vi.fn(() => Array.from(processes.values())),
			get: vi.fn((id: string) => processes.get(id)),
			kill: vi.fn((id: string) => {
				exit(id);
				return true;
			}),
			on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
				emitter.on(event, fn);
				return registry;
			}),
			off: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
				emitter.off(event, fn);
				return registry;
			}),
		};
		return { registry, exit, emitter };
	}

	describe('awaitSynopsisWriters', () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it('returns at once when no synopsis holds the provider session', async () => {
			const { registry } = makeRegistry([
				{ sessionId: 'agent-1-ai-tab-1', agentSessionId: 'thread-a' },
				{ sessionId: 'agent-1-synopsis-123', agentSessionId: 'thread-b' },
			]);
			const result = await awaitSynopsisWriters(registry as never, 'thread-a');
			expect(result).toEqual({ waitedFor: [], killed: [], elapsedMs: 0 });
			expect(registry.on).not.toHaveBeenCalled();
		});

		it('waits for a synopsis resuming the same session to exit', async () => {
			const { registry, exit, emitter } = makeRegistry([
				{ sessionId: 'agent-1-synopsis-123', agentSessionId: 'thread-a' },
			]);
			let settled = false;
			const pending = awaitSynopsisWriters(registry as never, 'thread-a').then((r) => {
				settled = true;
				return r;
			});
			await vi.advanceTimersByTimeAsync(5_000);
			expect(settled).toBe(false);

			exit('agent-1-synopsis-123');
			const result = await pending;
			expect(result.waitedFor).toEqual(['agent-1-synopsis-123']);
			expect(result.killed).toEqual([]);
			expect(registry.kill).not.toHaveBeenCalled();
			expect(emitter.listenerCount('exit')).toBe(0);
		});

		it('kills a synopsis that outlives the wait', async () => {
			const { registry } = makeRegistry([
				{ sessionId: 'agent-1-synopsis-123', agentSessionId: 'thread-a' },
			]);
			const pending = awaitSynopsisWriters(registry as never, 'thread-a', {
				waitMs: 1_000,
				killGraceMs: 500,
			});
			await vi.advanceTimersByTimeAsync(1_000);
			const result = await pending;
			expect(registry.kill).toHaveBeenCalledWith('agent-1-synopsis-123');
			expect(result.killed).toEqual(['agent-1-synopsis-123']);
		});

		it('cancels a wait without killing the synopsis or retaining listeners', async () => {
			const { registry, emitter } = makeRegistry([
				{ sessionId: 'agent-1-synopsis-123', agentSessionId: 'thread-a' },
			]);
			const controller = new AbortController();
			const pending = awaitSynopsisWriters(registry as never, 'thread-a', {
				waitMs: 1_000,
				signal: controller.signal,
			}).then(
				() => null,
				(error: Error) => error
			);
			controller.abort();
			await vi.advanceTimersByTimeAsync(2_000);
			expect(await pending).toBeInstanceOf(Error);
			expect(registry.kill).not.toHaveBeenCalled();
			expect(emitter.listenerCount('exit')).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('does not wait on a non-synopsis process holding the session', async () => {
			const { registry } = makeRegistry([
				{ sessionId: 'agent-1-ai-tab-1', agentSessionId: 'thread-a' },
				{ sessionId: 'agent-1-batch-123', agentSessionId: 'thread-a' },
			]);
			const result = await awaitSynopsisWriters(registry as never, 'thread-a');
			expect(result.waitedFor).toEqual([]);
		});
	});
});
