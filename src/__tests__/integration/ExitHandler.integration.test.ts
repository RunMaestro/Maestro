/**
 * Tests for src/main/process-manager/handlers/ExitHandler.ts
 *
 * Covers the ExitHandler class, specifically:
 * - Processing remaining jsonBuffer in stream-json mode at exit
 * - Final data buffer flush before emitting exit event
 * - Emitting accumulated streamedText when no result was emitted
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../main/parsers/error-patterns', () => ({
	matchSshErrorPattern: vi.fn(() => null),
}));

vi.mock('../../main/parsers/usage-aggregator', () => ({
	aggregateModelUsage: vi.fn(() => ({
		inputTokens: 100,
		outputTokens: 50,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0.01,
		contextWindow: 200000,
	})),
}));

vi.mock('../../main/process-manager/utils/imageUtils', () => ({
	cleanupTempFiles: vi.fn(),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { ExitHandler } from '../../main/process-manager/handlers/ExitHandler';
import { DataBufferManager } from '../../main/process-manager/handlers/DataBufferManager';
import { logger } from '../../main/utils/logger';
import { matchSshErrorPattern } from '../../main/parsers/error-patterns';
import { aggregateModelUsage } from '../../main/parsers/usage-aggregator';
import { cleanupTempFiles } from '../../main/process-manager/utils/imageUtils';
import type { ManagedProcess } from '../../main/process-manager/types';
import type { AgentOutputParser } from '../../main/parsers';

// ── Helpers ────────────────────────────────────────────────────────────────

function createMockProcess(overrides: Partial<ManagedProcess> = {}): ManagedProcess {
	return {
		sessionId: 'test-session',
		toolType: 'claude-code',
		cwd: '/tmp',
		pid: 1234,
		isTerminal: false,
		startTime: Date.now(),
		isStreamJsonMode: false,
		isBatchMode: false,
		jsonBuffer: '',
		stdoutBuffer: '',
		stderrBuffer: '',
		contextWindow: 200000,
		lastUsageTotals: undefined,
		usageIsCumulative: undefined,
		sessionIdEmitted: false,
		resultEmitted: false,
		errorEmitted: false,
		outputParser: undefined,
		sshRemoteId: undefined,
		sshRemoteHost: undefined,
		streamedText: '',
		...overrides,
	} as ManagedProcess;
}

function createMockOutputParser(overrides: Partial<AgentOutputParser> = {}): AgentOutputParser {
	return {
		agentId: 'claude-code',
		parseJsonLine: vi.fn(() => null),
		extractUsage: vi.fn(() => null),
		extractSessionId: vi.fn(() => null),
		extractSlashCommands: vi.fn(() => null),
		isResultMessage: vi.fn(() => false),
		detectErrorFromLine: vi.fn(() => null),
		detectErrorFromExit: vi.fn(() => null),
		...overrides,
	} as unknown as AgentOutputParser;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ExitHandler', () => {
	let processes: Map<string, ManagedProcess>;
	let emitter: EventEmitter;
	let bufferManager: DataBufferManager;
	let exitHandler: ExitHandler;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(matchSshErrorPattern).mockReturnValue(null);
		vi.mocked(aggregateModelUsage).mockReturnValue({
			inputTokens: 100,
			outputTokens: 50,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.01,
			contextWindow: 200000,
		});
		processes = new Map();
		emitter = new EventEmitter();
		bufferManager = new DataBufferManager(processes, emitter);
		exitHandler = new ExitHandler({ processes, emitter, bufferManager });
	});

	describe('stream-json jsonBuffer processing at exit', () => {
		it('should process remaining jsonBuffer content as a result message', async () => {
			const resultJson = '{"type":"result","result":"Auth Bug Fix","session_id":"abc"}';
			const mockParser = createMockOutputParser({
				parseJsonLine: vi.fn(() => ({
					type: 'result',
					text: 'Auth Bug Fix',
					sessionId: 'abc',
				})) as unknown as AgentOutputParser['parseJsonLine'],
				isResultMessage: vi.fn(() => true) as unknown as AgentOutputParser['isResultMessage'],
			});

			const proc = createMockProcess({
				isStreamJsonMode: true,
				isBatchMode: true,
				jsonBuffer: resultJson,
				outputParser: mockParser,
			});
			processes.set('test-session', proc);

			const dataEvents: string[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));

			await exitHandler.handleExit('test-session', 0);

			expect(mockParser.parseJsonLine).toHaveBeenCalledWith(resultJson);
			expect(mockParser.isResultMessage).toHaveBeenCalled();
			expect(dataEvents).toContain('Auth Bug Fix');
		});

		it('should not process jsonBuffer if already empty', async () => {
			const mockParser = createMockOutputParser();

			const proc = createMockProcess({
				isStreamJsonMode: true,
				isBatchMode: true,
				jsonBuffer: '',
				outputParser: mockParser,
			});
			processes.set('test-session', proc);

			await exitHandler.handleExit('test-session', 0);

			expect(mockParser.parseJsonLine).not.toHaveBeenCalled();
		});

		it('should not process jsonBuffer if resultEmitted is already true', async () => {
			const resultJson = '{"type":"result","result":"Tab Name"}';
			const mockParser = createMockOutputParser({
				parseJsonLine: vi.fn(() => ({
					type: 'result',
					text: 'Tab Name',
				})) as unknown as AgentOutputParser['parseJsonLine'],
				isResultMessage: vi.fn(() => true) as unknown as AgentOutputParser['isResultMessage'],
			});

			const proc = createMockProcess({
				isStreamJsonMode: true,
				isBatchMode: true,
				jsonBuffer: resultJson,
				outputParser: mockParser,
				resultEmitted: true, // Already emitted during stdout processing
			});
			processes.set('test-session', proc);

			const dataEvents: string[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));

			await exitHandler.handleExit('test-session', 0);

			// parseJsonLine is called, but data should NOT be emitted again
			expect(dataEvents).not.toContain('Tab Name');
		});

		it('should emit raw line as data when JSON parsing fails', async () => {
			const invalidJson = 'not valid json at all';
			const mockParser = createMockOutputParser({
				parseJsonLine: vi.fn(() => {
					throw new Error('JSON parse error');
				}) as unknown as AgentOutputParser['parseJsonLine'],
			});

			const proc = createMockProcess({
				isStreamJsonMode: true,
				isBatchMode: true,
				jsonBuffer: invalidJson,
				outputParser: mockParser,
			});
			processes.set('test-session', proc);

			const dataEvents: string[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));

			await exitHandler.handleExit('test-session', 0);

			expect(dataEvents).toContain(invalidJson);
		});

		it('should use streamedText as fallback when result event has no text', async () => {
			const resultJson = '{"type":"result"}';
			const mockParser = createMockOutputParser({
				parseJsonLine: vi.fn(() => ({
					type: 'result',
					text: '', // Empty text
				})) as unknown as AgentOutputParser['parseJsonLine'],
				isResultMessage: vi.fn(() => true) as unknown as AgentOutputParser['isResultMessage'],
			});

			const proc = createMockProcess({
				isStreamJsonMode: true,
				isBatchMode: true,
				jsonBuffer: resultJson,
				outputParser: mockParser,
				streamedText: 'Accumulated streaming text',
			});
			processes.set('test-session', proc);

			const dataEvents: string[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));

			await exitHandler.handleExit('test-session', 0);

			expect(dataEvents).toContain('Accumulated streaming text');
		});

		it('does not emit data when a result event has no text or streamed fallback', async () => {
			const resultJson = '{"type":"result"}';
			const mockParser = createMockOutputParser({
				parseJsonLine: vi.fn(() => ({
					type: 'result',
					text: '',
				})) as unknown as AgentOutputParser['parseJsonLine'],
				isResultMessage: vi.fn(() => true) as unknown as AgentOutputParser['isResultMessage'],
			});
			const proc = createMockProcess({
				isStreamJsonMode: true,
				jsonBuffer: resultJson,
				outputParser: mockParser,
				streamedText: '',
			});
			processes.set('test-session', proc);
			const dataEvents: string[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));

			await exitHandler.handleExit('test-session', 0);

			expect(proc.resultEmitted).toBe(true);
			expect(dataEvents).toEqual([]);
		});
	});

	describe('final data buffer flush', () => {
		it('should flush data buffer before emitting exit event', async () => {
			const proc = createMockProcess({
				isStreamJsonMode: true,
				isBatchMode: true,
				// Simulate data that was buffered during exit processing
				dataBuffer: 'buffered data',
			});
			processes.set('test-session', proc);

			const events: string[] = [];
			emitter.on('data', () => events.push('data'));
			emitter.on('exit', () => events.push('exit'));

			await exitHandler.handleExit('test-session', 0);

			// Data should come before exit
			const dataIdx = events.indexOf('data');
			const exitIdx = events.indexOf('exit');
			expect(dataIdx).toBeLessThan(exitIdx);
		});

		it('should emit exit event even with no buffered data', async () => {
			const proc = createMockProcess();
			processes.set('test-session', proc);

			const exitEvents: Array<{ sessionId: string; code: number }> = [];
			emitter.on('exit', (sid: string, code: number) => exitEvents.push({ sessionId: sid, code }));

			await exitHandler.handleExit('test-session', 0);

			expect(exitEvents).toEqual([{ sessionId: 'test-session', code: 0 }]);
		});
	});

	describe('streamedText fallback', () => {
		it('should emit streamedText when no result was emitted in stream-json mode', async () => {
			const proc = createMockProcess({
				isStreamJsonMode: true,
				isBatchMode: true,
				resultEmitted: false,
				streamedText: 'Partial response text',
			});
			processes.set('test-session', proc);

			const dataEvents: string[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));

			await exitHandler.handleExit('test-session', 0);

			expect(dataEvents).toContain('Partial response text');
		});

		it('should not emit streamedText when result was already emitted', async () => {
			const proc = createMockProcess({
				isStreamJsonMode: true,
				isBatchMode: true,
				resultEmitted: true,
				streamedText: 'Should not be emitted',
			});
			processes.set('test-session', proc);

			const dataEvents: string[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));

			await exitHandler.handleExit('test-session', 0);

			expect(dataEvents).not.toContain('Should not be emitted');
		});
	});

	describe('process cleanup', () => {
		it('should remove process from map after exit', async () => {
			const proc = createMockProcess();
			processes.set('test-session', proc);

			await exitHandler.handleExit('test-session', 0);

			expect(processes.has('test-session')).toBe(false);
		});

		it('should emit exit event for unknown sessions', async () => {
			const exitEvents: Array<{ sessionId: string; code: number }> = [];
			emitter.on('exit', (sid: string, code: number) => exitEvents.push({ sessionId: sid, code }));

			await exitHandler.handleExit('unknown-session', 1);

			expect(exitEvents).toEqual([{ sessionId: 'unknown-session', code: 1 }]);
		});
	});

	describe('synopsis exit logging', () => {
		it('logs synopsis exit details with populated buffers', async () => {
			const proc = createMockProcess({
				resultEmitted: true,
				streamedText: 'streamed synopsis',
				stdoutBuffer: 'stdout synopsis',
				stderrBuffer: 'stderr synopsis',
			});
			processes.set('agent-synopsis-1', proc);

			await exitHandler.handleExit('agent-synopsis-1', 0);

			expect(logger.info).toHaveBeenCalledWith(
				'[ProcessManager] Synopsis session exit',
				'ProcessManager',
				expect.objectContaining({
					sessionId: 'agent-synopsis-1',
					streamedTextLength: 'streamed synopsis'.length,
					stdoutBufferLength: 'stdout synopsis'.length,
					stderrBufferLength: 'stderr synopsis'.length,
				})
			);
		});

		it('logs synopsis exit details with empty fallback previews', async () => {
			processes.set('agent-synopsis-2', createMockProcess());

			await exitHandler.handleExit('agent-synopsis-2', 0);

			expect(logger.info).toHaveBeenCalledWith(
				'[ProcessManager] Synopsis session exit',
				'ProcessManager',
				expect.objectContaining({
					sessionId: 'agent-synopsis-2',
					streamedTextPreview: '(empty)',
					stderrPreview: '(empty)',
				})
			);
		});
	});

	describe('batch mode JSON and lifecycle events', () => {
		it('parses batch JSON result, session id, and usage at exit', async () => {
			const proc = createMockProcess({
				isBatchMode: true,
				isStreamJsonMode: false,
				jsonBuffer: JSON.stringify({
					result: 'Batch result',
					session_id: 'agent-session-1',
					usage: { input_tokens: 10 },
					total_cost_usd: 0.25,
				}),
			});
			processes.set('test-session', proc);
			const dataEvents: string[] = [];
			const sessionEvents: string[] = [];
			const usageEvents: unknown[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));
			emitter.on('session-id', (_sid: string, agentSessionId: string) =>
				sessionEvents.push(agentSessionId)
			);
			emitter.on('usage', (_sid: string, usage: unknown) => usageEvents.push(usage));

			await exitHandler.handleExit('test-session', 0);

			expect(dataEvents).toContain('Batch result');
			expect(sessionEvents).toEqual(['agent-session-1']);
			expect(aggregateModelUsage).toHaveBeenCalledWith(undefined, { input_tokens: 10 }, 0.25);
			expect(usageEvents).toEqual([
				{
					inputTokens: 100,
					outputTokens: 50,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.01,
					contextWindow: 200000,
				},
			]);
			expect(proc.resultEmitted).toBe(true);
			expect(proc.sessionIdEmitted).toBe(true);
		});

		it('does not re-emit result or session id when already emitted and handles modelUsage-only usage', async () => {
			const proc = createMockProcess({
				isBatchMode: true,
				isStreamJsonMode: false,
				resultEmitted: true,
				sessionIdEmitted: true,
				jsonBuffer: JSON.stringify({
					result: 'Already sent',
					session_id: 'already-sent',
					modelUsage: {
						sonnet: { inputTokens: 10 },
					},
				}),
			});
			processes.set('test-session', proc);
			const dataEvents: string[] = [];
			const sessionEvents: string[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));
			emitter.on('session-id', (_sid: string, agentSessionId: string) =>
				sessionEvents.push(agentSessionId)
			);

			await exitHandler.handleExit('test-session', 0);

			expect(dataEvents).not.toContain('Already sent');
			expect(sessionEvents).toEqual([]);
			expect(aggregateModelUsage).toHaveBeenCalledWith({ sonnet: { inputTokens: 10 } }, {}, 0);
		});

		it('does not emit usage when batch JSON has no usage fields', async () => {
			const proc = createMockProcess({
				isBatchMode: true,
				isStreamJsonMode: false,
				jsonBuffer: JSON.stringify({ result: 'No usage payload' }),
			});
			processes.set('test-session', proc);
			const usageEvents: unknown[] = [];
			emitter.on('usage', (_sid: string, usage: unknown) => usageEvents.push(usage));

			await exitHandler.handleExit('test-session', 0);

			expect(aggregateModelUsage).not.toHaveBeenCalled();
			expect(usageEvents).toEqual([]);
		});

		it('falls back to raw batch output when JSON parsing fails', async () => {
			const proc = createMockProcess({
				isBatchMode: true,
				isStreamJsonMode: false,
				jsonBuffer: '{bad json',
			});
			processes.set('test-session', proc);
			const dataEvents: string[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));

			await exitHandler.handleExit('test-session', 1);

			expect(logger.error).toHaveBeenCalledWith(
				'[ProcessManager] Failed to parse JSON response',
				'ProcessManager',
				expect.objectContaining({ sessionId: 'test-session' })
			);
			expect(dataEvents).toContain('{bad json');
		});
	});

	describe('exit error detection', () => {
		it('emits parser-detected agent errors from exit details', async () => {
			const agentError = {
				type: 'rate_limit' as const,
				message: 'Rate limit exceeded',
				recoverable: true,
				agentId: 'claude-code',
				timestamp: 123,
			};
			const mockParser = createMockOutputParser({
				detectErrorFromExit: vi.fn(() => agentError),
			});
			const proc = createMockProcess({
				outputParser: mockParser,
				stderrBuffer: 'rate limited',
				stdoutBuffer: 'partial stdout',
			});
			processes.set('test-session', proc);
			const errorEvents: unknown[] = [];
			emitter.on('agent-error', (_sid: string, error: unknown) => errorEvents.push(error));

			await exitHandler.handleExit('test-session', 1);

			expect(mockParser.detectErrorFromExit).toHaveBeenCalledWith(
				1,
				'rate limited',
				'partial stdout'
			);
			expect(errorEvents).toEqual([{ ...agentError, sessionId: 'test-session' }]);
			expect(proc.errorEmitted).toBe(true);
		});

		it('emits SSH agent errors detected from stderr', async () => {
			vi.mocked(matchSshErrorPattern).mockReturnValue({
				type: 'auth' as const,
				message: 'Permission denied',
				recoverable: true,
			});
			const proc = createMockProcess({
				sshRemoteId: 'remote-1',
				stdoutBuffer: 'stdout before failure',
				stderrBuffer: 'Permission denied (publickey)',
			});
			processes.set('test-session', proc);
			const errorEvents: unknown[] = [];
			emitter.on('agent-error', (_sid: string, error: unknown) => errorEvents.push(error));

			await exitHandler.handleExit('test-session', 255);

			expect(matchSshErrorPattern).toHaveBeenCalledWith('Permission denied (publickey)');
			expect(errorEvents).toHaveLength(1);
			expect(errorEvents[0]).toMatchObject({
				type: 'auth',
				message: 'Permission denied',
				recoverable: true,
				agentId: 'claude-code',
				sessionId: 'test-session',
				raw: {
					exitCode: 255,
					stderr: 'Permission denied (publickey)',
				},
			});
			expect(proc.errorEmitted).toBe(true);
		});

		it('warns when SSH exits non-zero without a recognized error pattern', async () => {
			const proc = createMockProcess({
				sshRemoteId: 'remote-1',
				stdoutBuffer: '',
				stderrBuffer: 'custom remote failure',
			});
			processes.set('test-session', proc);

			await exitHandler.handleExit('test-session', 2);

			expect(logger.warn).toHaveBeenCalledWith(
				'[ProcessManager] SSH command failed without matching error pattern',
				'ProcessManager',
				expect.objectContaining({
					sessionId: 'test-session',
					exitCode: 2,
					sshRemoteId: 'remote-1',
				})
			);
		});

		it('checks SSH stderr even when exit code is zero and does not warn without a pattern', async () => {
			const proc = createMockProcess({
				sshRemoteId: 'remote-1',
				stderrBuffer: 'remote shell warning',
			});
			processes.set('test-session', proc);

			await exitHandler.handleExit('test-session', 0);

			expect(matchSshErrorPattern).toHaveBeenCalledWith('remote shell warning');
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('does not inspect stdout when stderr is empty on non-zero SSH exit', async () => {
			const proc = createMockProcess({
				sshRemoteId: 'remote-1',
				stdoutBuffer: '',
				streamedText: 'streamed remote failure',
				stderrBuffer: '',
			});
			processes.set('test-session', proc);

			await exitHandler.handleExit('test-session', 2);

			expect(matchSshErrorPattern).toHaveBeenCalledWith('');
			expect(logger.warn).toHaveBeenCalledWith(
				'[ProcessManager] SSH command failed without matching error pattern',
				'ProcessManager',
				expect.objectContaining({
					stderrPreview: '',
				})
			);
		});
	});

	describe('cleanup and process error handling', () => {
		it('cleans temp image files and emits query-complete for batch processes', async () => {
			const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2500);
			try {
				const proc = createMockProcess({
					isBatchMode: true,
					querySource: 'auto',
					startTime: 1000,
					projectPath: '/repo',
					tabId: 'tab-1',
					tempImageFiles: ['/tmp/image-1.png'],
				});
				processes.set('test-session', proc);
				const queryEvents: unknown[] = [];
				emitter.on('query-complete', (_sid: string, event: unknown) => queryEvents.push(event));

				await exitHandler.handleExit('test-session', 0);

				expect(cleanupTempFiles).toHaveBeenCalledWith(['/tmp/image-1.png']);
				expect(queryEvents).toEqual([
					{
						sessionId: 'test-session',
						agentType: 'claude-code',
						source: 'auto',
						startTime: 1000,
						duration: 1500,
						projectPath: '/repo',
						tabId: 'tab-1',
					},
				]);
			} finally {
				nowSpy.mockRestore();
			}
		});

		it('handleError emits agent-error, cleans temp files, exits, and deletes process', async () => {
			const proc = createMockProcess({
				tempImageFiles: ['/tmp/image-1.png'],
			});
			processes.set('test-session', proc);
			const dataEvents: string[] = [];
			const exitEvents: number[] = [];
			const errorEvents: unknown[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));
			emitter.on('exit', (_sid: string, code: number) => exitEvents.push(code));
			emitter.on('agent-error', (_sid: string, error: unknown) => errorEvents.push(error));

			exitHandler.handleError('test-session', new Error('spawn failed'));

			expect(errorEvents).toHaveLength(1);
			expect(errorEvents[0]).toMatchObject({
				type: 'agent_crashed',
				message: 'Agent process error: spawn failed',
				recoverable: true,
				agentId: 'claude-code',
				sessionId: 'test-session',
				raw: { stderr: 'spawn failed' },
			});
			expect(cleanupTempFiles).toHaveBeenCalledWith(['/tmp/image-1.png']);
			expect(dataEvents).toEqual(['[error] spawn failed']);
			expect(exitEvents).toEqual([1]);
			expect(processes.has('test-session')).toBe(false);
		});

		it('handleError still emits data and exit for unknown sessions', async () => {
			const dataEvents: string[] = [];
			const exitEvents: number[] = [];
			const errorEvents: unknown[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));
			emitter.on('exit', (_sid: string, code: number) => exitEvents.push(code));
			emitter.on('agent-error', (_sid: string, error: unknown) => errorEvents.push(error));

			exitHandler.handleError('missing-session', new Error('spawn failed'));

			expect(errorEvents).toEqual([]);
			expect(cleanupTempFiles).not.toHaveBeenCalled();
			expect(dataEvents).toEqual(['[error] spawn failed']);
			expect(exitEvents).toEqual([1]);
		});
	});
});
