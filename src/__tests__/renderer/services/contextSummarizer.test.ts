/**
 * Tests for ContextSummarizationService
 *
 * Tests the context compaction logic including:
 * - Eligibility checks (context usage % and token count fallback)
 * - Single-pass summarization for small contexts
 * - Chunked summarization for large contexts
 * - Consolidation passes when combined chunks are still too large
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	ContextSummarizationService,
	contextSummarizationService,
} from '../../../renderer/services/contextSummarizer';
import type { LogEntry } from '../../../renderer/types';

// Mock window.maestro for IPC calls
const mockGroomContext = vi.fn();
const mockCancelGrooming = vi.fn();
const mockGetAllPaginated = vi.fn();
const mockLog = vi.fn();

vi.stubGlobal('window', {
	maestro: {
		context: {
			groomContext: mockGroomContext,
			cancelGrooming: mockCancelGrooming,
		},
		history: { getAllPaginated: mockGetAllPaginated },
		logger: { log: mockLog },
	},
});

// Helper to create a mock log entry
function createMockLog(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		id: `log-${Math.random().toString(36).slice(2)}`,
		timestamp: Date.now(),
		source: 'user',
		text: 'Test message',
		...overrides,
	};
}

// Helper to create logs with a specific estimated token count
// ~4 chars per token, so 1000 tokens ≈ 4000 chars
function createLogsWithTokenCount(targetTokens: number): LogEntry[] {
	const charsNeeded = targetTokens * 4;
	const text = 'A'.repeat(charsNeeded);
	return [createMockLog({ text })];
}

describe('ContextSummarizationService', () => {
	let service: ContextSummarizationService;

	beforeEach(() => {
		service = new ContextSummarizationService();
		vi.clearAllMocks();

		// Default mock implementation
		mockGroomContext.mockResolvedValue(`## Summary
Compacted conversation summary.

## Key Decisions
- Decision 1
- Decision 2

## Next Steps
Continue with implementation.`);
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	describe('constructor', () => {
		it('should create instance with default config', () => {
			const instance = new ContextSummarizationService();
			expect(instance).toBeInstanceOf(ContextSummarizationService);
			expect(instance.getMinContextUsagePercent()).toBe(25);
		});

		it('should create instance with custom config', () => {
			const instance = new ContextSummarizationService({
				minContextUsagePercent: 30,
				timeoutMs: 60000,
			});
			expect(instance).toBeInstanceOf(ContextSummarizationService);
			expect(instance.getMinContextUsagePercent()).toBe(30);
		});
	});

	describe('canSummarize', () => {
		describe('context usage percentage check', () => {
			it('should allow summarization when context usage >= 25%', () => {
				expect(service.canSummarize(25)).toBe(true);
				expect(service.canSummarize(50)).toBe(true);
				expect(service.canSummarize(100)).toBe(true);
			});

			it('should deny summarization when context usage < 25% and no logs', () => {
				expect(service.canSummarize(0)).toBe(false);
				expect(service.canSummarize(10)).toBe(false);
				expect(service.canSummarize(24)).toBe(false);
			});

			it('should deny summarization when context usage < 25% and empty logs', () => {
				expect(service.canSummarize(10, [])).toBe(false);
			});
		});

		describe('token count fallback check', () => {
			it('should allow summarization when logs have >= 2k tokens', () => {
				// 2,000 tokens * 4 chars/token = 8,000 chars
				const logsWithManyTokens = createLogsWithTokenCount(2000);
				expect(service.canSummarize(0, logsWithManyTokens)).toBe(true);
			});

			it('should allow summarization when logs have > 2k tokens', () => {
				const logsWithManyTokens = createLogsWithTokenCount(5000);
				expect(service.canSummarize(0, logsWithManyTokens)).toBe(true);
			});

			it('should deny summarization when logs have < 2k tokens, usage < 25%, and < 8 entries', () => {
				const logsWithFewTokens = createLogsWithTokenCount(500);
				expect(service.canSummarize(0, logsWithFewTokens)).toBe(false);
			});

			it('should prioritize context usage check over token count', () => {
				// Even with few tokens, if usage is high enough, allow it
				const logsWithFewTokens = createLogsWithTokenCount(500);
				expect(service.canSummarize(30, logsWithFewTokens)).toBe(true);
			});
		});

		describe('log entry count fallback check', () => {
			it('should allow summarization when >= 8 meaningful log entries exist', () => {
				// Create 8 meaningful log entries (user/AI messages)
				const logs = [
					createMockLog({ source: 'user', text: 'msg1' }),
					createMockLog({ source: 'ai', text: 'msg2' }),
					createMockLog({ source: 'user', text: 'msg3' }),
					createMockLog({ source: 'ai', text: 'msg4' }),
					createMockLog({ source: 'user', text: 'msg5' }),
					createMockLog({ source: 'ai', text: 'msg6' }),
					createMockLog({ source: 'user', text: 'msg7' }),
					createMockLog({ source: 'ai', text: 'msg8' }),
				];
				// Even with very low token count and 0% usage, 8 entries should allow compaction
				expect(service.canSummarize(0, logs)).toBe(true);
			});

			it('should count stdout as meaningful (AI responses)', () => {
				const logs = [
					createMockLog({ source: 'user', text: 'msg1' }),
					createMockLog({ source: 'stdout', text: 'msg2' }),
					createMockLog({ source: 'user', text: 'msg3' }),
					createMockLog({ source: 'stdout', text: 'msg4' }),
					createMockLog({ source: 'user', text: 'msg5' }),
					createMockLog({ source: 'stdout', text: 'msg6' }),
					createMockLog({ source: 'user', text: 'msg7' }),
					createMockLog({ source: 'stdout', text: 'msg8' }),
				];
				expect(service.canSummarize(0, logs)).toBe(true);
			});

			it('should not count system/error/thinking logs as meaningful', () => {
				const logs = [
					createMockLog({ source: 'user', text: 'msg1' }),
					createMockLog({ source: 'ai', text: 'msg2' }),
					createMockLog({ source: 'system', text: 'sys1' }),
					createMockLog({ source: 'system', text: 'sys2' }),
					createMockLog({ source: 'error', text: 'err1' }),
					createMockLog({ source: 'thinking', text: 'think1' }),
					createMockLog({ source: 'user', text: 'msg3' }),
				];
				// Only 4 meaningful entries (user x3, ai x1), less than 8
				expect(service.canSummarize(0, logs)).toBe(false);
			});

			it('should deny when < 8 meaningful entries, < 2k tokens, and < 25% usage', () => {
				const logs = [
					createMockLog({ source: 'user', text: 'short' }),
					createMockLog({ source: 'ai', text: 'reply' }),
				];
				expect(service.canSummarize(0, logs)).toBe(false);
			});
		});

		describe('custom threshold', () => {
			it('should respect custom minContextUsagePercent', () => {
				const customService = new ContextSummarizationService({
					minContextUsagePercent: 50,
				});

				expect(customService.canSummarize(49)).toBe(false);
				expect(customService.canSummarize(50)).toBe(true);
			});
		});
	});

	describe('formatCompactedTabName', () => {
		it('should format tab name with date suffix', () => {
			const name = service.formatCompactedTabName('My Session');
			const dateRegex = /^My Session Compacted \d{4}-\d{2}-\d{2}$/;
			expect(name).toMatch(dateRegex);
		});

		it('should use "Session" as default for null name', () => {
			const name = service.formatCompactedTabName(null);
			expect(name).toContain('Session Compacted');
		});

		it("should include today's date", () => {
			const today = new Date().toISOString().split('T')[0];
			const name = service.formatCompactedTabName('Test');
			expect(name).toContain(today);
		});
	});

	describe('summarizeContext', () => {
		const baseRequest = {
			sourceSessionId: 'session-123',
			sourceTabId: 'tab-456',
			projectRoot: '/test/project',
			agentType: 'claude-code' as const,
		};

		it('should call groomContext with formatted prompt', async () => {
			const logs = [
				createMockLog({ source: 'user', text: 'How do I implement X?' }),
				createMockLog({ source: 'ai', text: 'To implement X, you should...' }),
			];

			const progressUpdates: string[] = [];
			await service.summarizeContext(baseRequest, logs, (p) => progressUpdates.push(p.message));

			expect(mockGroomContext).toHaveBeenCalledTimes(1);
			expect(mockGroomContext).toHaveBeenCalledWith(
				'/test/project',
				'claude-code',
				expect.stringContaining('How do I implement X?'),
				// 4th param is options object (SSH/custom config)
				expect.any(Object)
			);
		});

		it('should pass SSH and custom config options to groomContext', async () => {
			const requestWithSshConfig = {
				...baseRequest,
				sshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/remote/path',
				},
				customPath: '/custom/agent',
				customArgs: '--flag',
				customEnvVars: { MY_VAR: 'value' },
			};

			const logs = [createMockLog({ text: 'Test content' })];
			await service.summarizeContext(requestWithSshConfig, logs, () => {});

			expect(mockGroomContext).toHaveBeenCalledWith(
				'/test/project',
				'claude-code',
				expect.any(String),
				{
					sshRemoteConfig: {
						enabled: true,
						remoteId: 'remote-1',
						workingDirOverride: '/remote/path',
					},
					customPath: '/custom/agent',
					customArgs: '--flag',
					customEnvVars: { MY_VAR: 'value' },
					// Summarization opts into the low tier / low effort turn. Asserted
					// here so a future refactor cannot silently drop the flag and put
					// summaries back on the agent's full model.
					cheapTurn: true,
				}
			);
		});

		it('should report progress through stages', async () => {
			const logs = [createMockLog({ text: 'Test content' })];
			const progressUpdates: { stage: string; progress: number }[] = [];

			await service.summarizeContext(baseRequest, logs, (p) =>
				progressUpdates.push({ stage: p.stage, progress: p.progress })
			);

			// Should start with extracting
			expect(progressUpdates[0].stage).toBe('extracting');
			expect(progressUpdates[0].progress).toBe(0);

			// Should end with creating stage
			const lastProgress = progressUpdates[progressUpdates.length - 1];
			expect(lastProgress.stage).toBe('creating');
			expect(lastProgress.progress).toBe(90);
		});

		it('should return summarized logs and token stats', async () => {
			const logs = [
				createMockLog({ source: 'user', text: 'Question here' }),
				createMockLog({ source: 'ai', text: 'Answer here with details...' }),
			];

			const result = await service.summarizeContext(baseRequest, logs, () => {});

			expect(result).not.toBeNull();
			expect(result!.summarizedLogs.length).toBeGreaterThan(0);
			expect(result!.originalTokens).toBeGreaterThan(0);
			expect(result!.compactedTokens).toBeGreaterThan(0);
		});

		it('should surface the underlying IPC error', async () => {
			mockGroomContext.mockRejectedValue(new Error('IPC failed'));

			const logs = [createMockLog({ text: 'Test' })];

			// The original error is rethrown verbatim so callers (and the
			// Compaction Failed toast) can show the real cause instead of a
			// generic 'Context summarization failed' wrapper.
			await expect(service.summarizeContext(baseRequest, logs, () => {})).rejects.toThrow(
				'IPC failed'
			);
		});
	});

	describe('chunked summarization', () => {
		const baseRequest = {
			sourceSessionId: 'session-123',
			sourceTabId: 'tab-456',
			projectRoot: '/test/project',
			agentType: 'claude-code' as const,
		};

		it('should chunk large contexts (> 50k tokens)', async () => {
			// Create logs that exceed 50k tokens (need > 200k chars)
			// Split into multiple logs to trigger chunking
			const largeText = 'B'.repeat(60000); // ~15k tokens per log
			const logs = [
				createMockLog({ text: largeText }),
				createMockLog({ text: largeText }),
				createMockLog({ text: largeText }),
				createMockLog({ text: largeText }),
			]; // ~60k tokens total

			const progressMessages: string[] = [];
			await service.summarizeContext(baseRequest, logs, (p) => progressMessages.push(p.message));

			// Should report chunked summarization
			const chunkMessages = progressMessages.filter((m) => m.includes('chunk'));
			expect(chunkMessages.length).toBeGreaterThan(0);

			// Should have made multiple groomContext calls
			expect(mockGroomContext.mock.calls.length).toBeGreaterThan(1);
		});

		it('should consolidate if combined chunks exceed 40k tokens', async () => {
			// First calls return large summaries, then consolidation reduces
			let callCount = 0;
			mockGroomContext.mockImplementation(() => {
				callCount++;
				if (callCount <= 2) {
					// Chunk summaries: each ~25k tokens
					return Promise.resolve('X'.repeat(100000)); // ~25k tokens each
				}
				// Consolidation pass: reduced
				return Promise.resolve('Y'.repeat(40000)); // ~10k tokens
			});

			// Create logs that will trigger chunking
			const largeText = 'A'.repeat(80000);
			const logs = [
				createMockLog({ text: largeText }),
				createMockLog({ text: largeText }),
				createMockLog({ text: largeText }),
			];

			const progressMessages: string[] = [];
			await service.summarizeContext(baseRequest, logs, (p) => progressMessages.push(p.message));

			// Should have consolidation pass messages
			const consolidationMessages = progressMessages.filter((m) =>
				m.toLowerCase().includes('consolidation')
			);
			expect(consolidationMessages.length).toBeGreaterThan(0);
		});

		it('should stop consolidation after max depth (3 passes)', async () => {
			// Always return large summaries to trigger max consolidation
			mockGroomContext.mockResolvedValue('Z'.repeat(200000)); // ~50k tokens, always too large

			const largeText = 'A'.repeat(80000);
			const logs = [
				createMockLog({ text: largeText }),
				createMockLog({ text: largeText }),
				createMockLog({ text: largeText }),
			];

			await service.summarizeContext(baseRequest, logs, () => {});

			// Should have chunk calls + up to 3 consolidation calls
			// Exact count depends on chunking, but should be bounded
			expect(mockGroomContext.mock.calls.length).toBeLessThanOrEqual(10);
		});

		it('should stop consolidation if not making progress', async () => {
			let callCount = 0;
			mockGroomContext.mockImplementation(() => {
				callCount++;
				// Return same size each time (no reduction)
				return Promise.resolve('Z'.repeat(200000));
			});

			const largeText = 'A'.repeat(80000);
			const logs = [
				createMockLog({ text: largeText }),
				createMockLog({ text: largeText }),
				createMockLog({ text: largeText }),
			];

			await service.summarizeContext(baseRequest, logs, () => {});

			// Should stop early since no progress is being made
			// (first consolidation attempt won't reduce by 10%)
			const initialCalls = mockGroomContext.mock.calls.length;

			// Reset and run again to verify consistent behavior
			mockGroomContext.mockClear();
			callCount = 0;

			await service.summarizeContext(baseRequest, logs, () => {});

			expect(mockGroomContext.mock.calls.length).toBe(initialCalls);
		});
	});

	describe('buildContinuityDigest', () => {
		const logs: LogEntry[] = [
			createMockLog({ id: 'u1', source: 'user', text: 'Ship the exporter. Never touch the CLI.' }),
			createMockLog({
				id: 't1',
				source: 'tool',
				text: 'Bash',
				metadata: {
					toolState: {
						status: 'failed',
						input: { command: 'npm test' },
						output: 'FAIL src/a.test.ts',
					},
				},
			}),
		];

		it('digests the tab logs it is handed, with the source of each line', () => {
			const digest = service.buildContinuityDigest(logs);

			expect(digest.objective?.text).toBe('Ship the exporter. Never touch the CLI.');
			expect(digest.constraints.map((item) => item.text)).toEqual(['Never touch the CLI.']);
			expect(digest.unresolvedFailures[0]).toMatchObject({ text: 'npm test', origin: 'tool' });
			expect(digest.references.map((ref) => ref.entryId)).toEqual(['u1', 't1']);
		});

		it('passes synopses and the budget through to the builder', () => {
			const digest = service.buildContinuityDigest(logs, {
				synopses: [{ id: 'h-1', response: '**Summary:** Earlier work' }],
				maxChars: 0,
			});

			expect(digest.excerpts).toEqual([]);
			expect(digest.omitted.excerpts).toBe(1);
		});

		it('starts no turn: it reads the logs and calls nothing', () => {
			service.buildContinuityDigest(logs);

			expect(mockGroomContext).not.toHaveBeenCalled();
			expect(mockCancelGrooming).not.toHaveBeenCalled();
		});

		it('does not change the logs it reads', () => {
			const before = JSON.stringify(logs);
			service.buildContinuityDigest(logs);
			expect(JSON.stringify(logs)).toBe(before);
		});
	});

	describe('previewContinuity', () => {
		const tab = {
			id: 'tab-1',
			agentSessionId: 'sess-1',
			provider: 'claude-code',
			entries: [
				createMockLog({
					id: 'u1',
					source: 'user',
					text: 'Ship the exporter. Never touch the CLI.',
				}),
			],
		};
		const asked = { agentId: 'agent-1', tabId: 'tab-1' };

		it('plans the preview of the tab it is handed', () => {
			const result = service.previewContinuity({
				target: asked,
				agentId: 'agent-1',
				tab,
				history: [],
			});

			expect(result.ok).toBe(true);
			expect(result.ok && result.preview.digest.constraints.map((item) => item.text)).toEqual([
				'Never touch the CLI.',
			]);
			expect(result.ok && result.preview.text).toContain('Continuity preview of tab tab-1');
		});

		it('refuses a tab that is not the one asked for, before reading anything', () => {
			const result = service.previewContinuity({
				target: { agentId: 'agent-1', tabId: 'tab-2' },
				agentId: 'agent-1',
				tab,
				history: [],
			});

			expect(result).toMatchObject({ ok: false, code: 'wrong-target' });
		});

		it('starts no turn, reads no History and writes nothing', () => {
			service.previewContinuity({ target: asked, agentId: 'agent-1', tab, history: [] });

			expect(mockGroomContext).not.toHaveBeenCalled();
			expect(mockCancelGrooming).not.toHaveBeenCalled();
			expect(mockGetAllPaginated).not.toHaveBeenCalled();
		});
	});

	describe('readContinuityHistory', () => {
		const agent = { id: 'agent-1', cwd: '/work/app', projectRoot: '/work/app' };

		it("reads the agent's newest interactive entries through the panel's own read", async () => {
			mockGetAllPaginated.mockResolvedValue({
				entries: [{ id: 'h1', type: 'USER' }],
				hasMore: false,
			});

			const read = await service.readContinuityHistory(agent);

			expect(read).toEqual({ records: [{ id: 'h1', type: 'USER' }], truncated: false });
			expect(mockGetAllPaginated).toHaveBeenCalledTimes(1);
			expect(mockGetAllPaginated).toHaveBeenCalledWith({
				sessionId: 'agent-1',
				projectPath: '/work/app',
				sharedContext: undefined,
				lookbackHours: null,
				types: ['USER'],
				pagination: { limit: 300, offset: 0 },
			});
		});

		it('passes the shared History of an SSH remote that syncs it', async () => {
			mockGetAllPaginated.mockResolvedValue({ entries: [], hasMore: false });

			await service.readContinuityHistory({
				...agent,
				cwd: '/home/dev/app',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1', syncHistory: true },
			});

			expect(mockGetAllPaginated.mock.calls[0][0].sharedContext).toEqual({
				sshRemoteId: 'remote-1',
				remoteCwd: '/home/dev/app',
			});
		});

		it('reports that more History exists than was read', async () => {
			mockGetAllPaginated.mockResolvedValue({ entries: [], hasMore: true });
			expect(await service.readContinuityHistory(agent)).toMatchObject({ truncated: true });
		});

		it('resolves null, and logs it, when the read fails', async () => {
			mockGetAllPaginated.mockRejectedValue(new Error('remote unreachable'));

			expect(await service.readContinuityHistory(agent)).toBeNull();
			expect(mockLog).toHaveBeenCalledWith(
				'warn',
				expect.stringContaining('History could not be read'),
				undefined,
				expect.any(Error)
			);
		});
	});

	describe('summarizing carries no digest', () => {
		it('sends the summarization prompt without any continuity text', async () => {
			const logs = [
				createMockLog({ source: 'user', text: 'Ship the exporter. Never touch the CLI.' }),
				createMockLog({ source: 'ai', text: 'Started on the exporter.' }),
			];

			await service.summarizeContext(
				{
					sourceSessionId: 'session-123',
					sourceTabId: 'tab-456',
					projectRoot: '/test/project',
					agentType: 'claude-code' as const,
				},
				logs,
				() => {}
			);

			const prompt = mockGroomContext.mock.calls[0][2] as string;
			expect(prompt).toContain('Never touch the CLI.');
			expect(prompt).not.toMatch(/continuity (digest|preview)/i);
			expect(prompt).not.toContain('not verified');
			expect(mockGetAllPaginated).not.toHaveBeenCalled();
		});
	});

	describe('singleton instance', () => {
		it('should export a default singleton instance', () => {
			expect(contextSummarizationService).toBeInstanceOf(ContextSummarizationService);
		});
	});

	describe('cancelSummarization', () => {
		it('should call cancelGrooming IPC', async () => {
			mockCancelGrooming.mockResolvedValue(undefined);
			await service.cancelSummarization();
			expect(mockCancelGrooming).toHaveBeenCalled();
		});

		it('should not throw when IPC call fails', async () => {
			mockCancelGrooming.mockRejectedValue(new Error('IPC error'));
			await expect(service.cancelSummarization()).resolves.not.toThrow();
		});
	});

	describe('isSummarizationActive', () => {
		it('should return false (state tracked by caller)', () => {
			expect(service.isSummarizationActive()).toBe(false);
		});
	});
});
