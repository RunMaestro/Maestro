/**
 * Tests for src/main/process-manager/handlers/StdoutHandler.ts
 *
 * Covers the StdoutHandler class and its internal normalizeUsageToDelta logic.
 * normalizeUsageToDelta is a private module-level function, so it is tested
 * indirectly through the StdoutHandler's stream-JSON processing paths.
 *
 * normalizeUsageToDelta behavior:
 * - First call: stores totals in lastUsageTotals, returns stats as-is
 * - Subsequent calls (cumulative): computes delta from previous totals
 * - If values decrease (not monotonic): sets usageIsCumulative = false, returns raw stats
 * - If usageIsCumulative is already false: returns raw stats, stores totals
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../../main/process-manager/utils/bufferUtils', () => ({
	appendToBuffer: vi.fn((buf: string, data: string) => buf + data),
}));

vi.mock('../../../../main/parsers/usage-aggregator', () => ({
	aggregateModelUsage: vi.fn(() => ({
		inputTokens: 100,
		outputTokens: 50,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0.01,
		contextWindow: 200000,
	})),
}));

vi.mock('../../../../main/parsers/error-patterns', () => ({
	matchSshErrorPattern: vi.fn(() => null),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import {
	StdoutHandler,
	extractDeniedPath,
} from '../../../../main/process-manager/handlers/StdoutHandler';
import type { ManagedProcess } from '../../../../main/process-manager/types';

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

function createMockBufferManager() {
	return {
		emitDataBuffered: vi.fn(),
		flushDataBuffer: vi.fn(),
	};
}

function createTestContext(processOverrides: Partial<ManagedProcess> = {}) {
	const processes = new Map<string, ManagedProcess>();
	const emitter = new EventEmitter();
	const bufferManager = createMockBufferManager();
	const sessionId = 'test-session';
	const proc = createMockProcess({ sessionId, ...processOverrides });
	processes.set(sessionId, proc);

	const handler = new StdoutHandler({ processes, emitter, bufferManager: bufferManager as any });

	return { processes, emitter, bufferManager, handler, sessionId, proc };
}

/**
 * Send a complete JSON line through stream-JSON mode.
 * Appends a newline so the handler parses it as a complete line.
 */
function sendJsonLine(handler: StdoutHandler, sessionId: string, obj: Record<string, unknown>) {
	handler.handleData(sessionId, JSON.stringify(obj) + '\n');
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('StdoutHandler', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ── handleData dispatch routing ────────────────────────────────────────

	describe('handleData routing', () => {
		it('should silently return when sessionId is not found in processes map', () => {
			const { handler, bufferManager } = createTestContext();
			handler.handleData('nonexistent-session', 'some output');
			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();
		});

		it('should emit via bufferManager in plain text mode', () => {
			const { handler, bufferManager, sessionId } = createTestContext({
				isStreamJsonMode: false,
				isBatchMode: false,
			});

			handler.handleData(sessionId, 'Hello, world!');
			expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith(sessionId, 'Hello, world!');
		});

		it('should accumulate to jsonBuffer in batch mode', () => {
			const { handler, bufferManager, sessionId, proc } = createTestContext({
				isBatchMode: true,
				isStreamJsonMode: false,
			});

			handler.handleData(sessionId, '{"partial":');
			handler.handleData(sessionId, '"data"}');

			expect(proc.jsonBuffer).toBe('{"partial":"data"}');
			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();
		});

		it('should process complete lines in stream JSON mode', () => {
			const { handler, bufferManager, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
			});

			// Send non-JSON text as a complete line -- it should fall through
			// to the catch block and be emitted via bufferManager
			handler.handleData(sessionId, 'plain text output\n');
			expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith(sessionId, 'plain text output');
		});

		it('should buffer incomplete lines in stream JSON mode until newline arrives', () => {
			const { handler, bufferManager, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
			});

			// Send partial line (no newline)
			handler.handleData(sessionId, '{"incomplete":');
			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();

			// jsonBuffer should hold the partial data
			expect(proc.jsonBuffer).toBe('{"incomplete":');
		});

		it('should skip empty lines in stream JSON mode', () => {
			const { handler, bufferManager, sessionId } = createTestContext({
				isStreamJsonMode: true,
			});

			handler.handleData(sessionId, '\n\n\n');
			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();
		});
	});

	// ── Legacy message handling (no outputParser) ──────────────────────────

	describe('legacy message handling (no outputParser)', () => {
		it('should emit result data for type=result messages', () => {
			const { handler, bufferManager, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
			});

			sendJsonLine(handler, sessionId, {
				type: 'result',
				result: 'Here is the answer.',
			});

			expect(proc.resultEmitted).toBe(true);
			expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith(sessionId, 'Here is the answer.');
		});

		it('should only emit result once (first result wins)', () => {
			const { handler, bufferManager, sessionId } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
			});

			sendJsonLine(handler, sessionId, {
				type: 'result',
				result: 'First answer.',
			});

			sendJsonLine(handler, sessionId, {
				type: 'result',
				result: 'Second answer.',
			});

			const resultCalls = (bufferManager.emitDataBuffered as any).mock.calls.filter(
				(call: any[]) => call[1] === 'First answer.' || call[1] === 'Second answer.'
			);
			expect(resultCalls).toHaveLength(1);
			expect(resultCalls[0][1]).toBe('First answer.');
		});

		it('should extract session_id and emit session-id event', () => {
			const { handler, emitter, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
			});

			const sessionIdSpy = vi.fn();
			emitter.on('session-id', sessionIdSpy);

			sendJsonLine(handler, sessionId, {
				session_id: 'agent-session-xyz',
			});

			expect(proc.sessionIdEmitted).toBe(true);
			expect(sessionIdSpy).toHaveBeenCalledWith(sessionId, 'agent-session-xyz');
		});

		it('should only emit session-id once', () => {
			const { handler, emitter, sessionId } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
			});

			const sessionIdSpy = vi.fn();
			emitter.on('session-id', sessionIdSpy);

			sendJsonLine(handler, sessionId, { session_id: 'first-id' });
			sendJsonLine(handler, sessionId, { session_id: 'second-id' });

			expect(sessionIdSpy).toHaveBeenCalledTimes(1);
			expect(sessionIdSpy).toHaveBeenCalledWith(sessionId, 'first-id');
		});

		it('should emit slash-commands for system init messages', () => {
			const { handler, emitter, sessionId } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
			});

			const slashSpy = vi.fn();
			emitter.on('slash-commands', slashSpy);

			sendJsonLine(handler, sessionId, {
				type: 'system',
				subtype: 'init',
				slash_commands: ['/help', '/compact'],
			});

			expect(slashSpy).toHaveBeenCalledWith(sessionId, ['/help', '/compact']);
		});

		it('should skip error messages in legacy mode', () => {
			const { handler, bufferManager, sessionId } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
			});

			sendJsonLine(handler, sessionId, {
				type: 'error',
				error: 'Something went wrong',
			});

			// Error messages should not be emitted via bufferManager
			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();
		});

		it('should skip messages with error field in legacy mode', () => {
			const { handler, bufferManager, sessionId } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
			});

			sendJsonLine(handler, sessionId, {
				error: 'auth failed',
			});

			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();
		});

		it('should emit usage stats for messages with modelUsage', () => {
			const { handler, emitter, sessionId } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			sendJsonLine(handler, sessionId, {
				modelUsage: {
					'claude-3-sonnet': {
						inputTokens: 1000,
						outputTokens: 500,
					},
				},
				total_cost_usd: 0.05,
			});

			expect(usageSpy).toHaveBeenCalledTimes(1);
			// The mock aggregateModelUsage always returns the fixed value
			expect(usageSpy).toHaveBeenCalledWith(sessionId, {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.01,
				contextWindow: 200000,
			});
		});

		it('should emit usage stats for messages with usage field', () => {
			const { handler, emitter, sessionId } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			sendJsonLine(handler, sessionId, {
				usage: { input_tokens: 500, output_tokens: 200 },
			});

			expect(usageSpy).toHaveBeenCalledTimes(1);
		});

		it('should emit usage stats for messages with total_cost_usd only', () => {
			const { handler, emitter, sessionId } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			sendJsonLine(handler, sessionId, {
				total_cost_usd: 0.03,
			});

			expect(usageSpy).toHaveBeenCalledTimes(1);
		});

		it('should handle combined result and session_id in one message', () => {
			const { handler, emitter, bufferManager, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
			});

			const sessionIdSpy = vi.fn();
			emitter.on('session-id', sessionIdSpy);

			sendJsonLine(handler, sessionId, {
				type: 'result',
				result: 'The answer is 42.',
				session_id: 'sess-combined',
			});

			expect(proc.resultEmitted).toBe(true);
			expect(proc.sessionIdEmitted).toBe(true);
			expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith(sessionId, 'The answer is 42.');
			expect(sessionIdSpy).toHaveBeenCalledWith(sessionId, 'sess-combined');
		});
	});

	describe('codex multi-message turn handling', () => {
		it('should emit only the final Codex result at turn completion', () => {
			const parser = {
				agentId: 'codex',
				parseJsonLine: vi.fn((line: string) => {
					const parsed = JSON.parse(line);
					if (parsed.type === 'agent') {
						return { type: 'result', text: parsed.text };
					}
					if (parsed.type === 'done') {
						return {
							type: 'usage',
							usage: {
								inputTokens: 100,
								outputTokens: 50,
								cacheReadTokens: 0,
								cacheCreationTokens: 0,
								contextWindow: 400000,
							},
						};
					}
					return { type: 'system' };
				}),
				parseJsonObject: vi.fn((parsed: any) => {
					if (parsed.type === 'agent') {
						return { type: 'result', text: parsed.text };
					}
					if (parsed.type === 'done') {
						return {
							type: 'usage',
							usage: {
								inputTokens: 100,
								outputTokens: 50,
								cacheReadTokens: 0,
								cacheCreationTokens: 0,
								contextWindow: 400000,
							},
						};
					}
					return { type: 'system' };
				}),
				extractUsage: vi.fn((event: any) => event.usage || null),
				extractSessionId: vi.fn(() => null),
				extractSlashCommands: vi.fn(() => null),
				isResultMessage: vi.fn((event: any) => event.type === 'result' && !!event.text),
				detectErrorFromLine: vi.fn(() => null),
				detectErrorFromParsed: vi.fn(() => null),
			};

			const { handler, bufferManager, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'codex',
				outputParser: parser as any,
			});

			sendJsonLine(handler, sessionId, {
				type: 'agent',
				text: "I'm checking the project directory now.",
			});
			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();
			expect(proc.resultEmitted).toBe(false);

			sendJsonLine(handler, sessionId, {
				type: 'agent',
				text: '{"confidence":55,"ready":false,"message":"README.md"}',
			});
			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();
			expect(proc.resultEmitted).toBe(false);

			sendJsonLine(handler, sessionId, { type: 'done' });

			expect(proc.resultEmitted).toBe(true);
			expect(bufferManager.emitDataBuffered).toHaveBeenCalledTimes(1);
			expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith(
				sessionId,
				'{"confidence":55,"ready":false,"message":"README.md"}'
			);
		});
	});

	// ── Gemini text routing ───────────────────────────────────────────────

	describe('Gemini text routing', () => {
		function createGeminiParser() {
			return {
				agentId: 'gemini-cli',
				parseJsonLine: vi.fn((line: string) => {
					try {
						const parsed = JSON.parse(line);
						if (parsed.type === 'message' && parsed.role === 'assistant') {
							return {
								type: 'text' as const,
								text: parsed.content,
								isPartial: parsed.delta === true,
							};
						}
						return null;
					} catch {
						return null;
					}
				}),
				parseJsonObject: vi.fn((parsed: any) => {
					if (parsed.type === 'message' && parsed.role === 'assistant') {
						return {
							type: 'text' as const,
							text: parsed.content,
							isPartial: parsed.delta === true,
						};
					}
					return null;
				}),
				extractUsage: vi.fn(() => null),
				extractSessionId: vi.fn(() => null),
				extractSlashCommands: vi.fn(() => null),
				isResultMessage: vi.fn(() => false),
				detectErrorFromLine: vi.fn(() => null),
				detectErrorFromParsed: vi.fn(() => null),
			};
		}

		it('should route non-partial Gemini text through data path for immediate display', () => {
			const parser = createGeminiParser();
			const { handler, emitter, bufferManager, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'gemini-cli',
				outputParser: parser as any,
			});

			const thinkingSpy = vi.fn();
			emitter.on('thinking-chunk', thinkingSpy);

			sendJsonLine(handler, sessionId, {
				type: 'message',
				role: 'assistant',
				content: 'Hello from Gemini!',
				// no delta field => isPartial = false
			});

			// Non-partial text should go through BOTH thinking-chunk AND data path
			expect(thinkingSpy).toHaveBeenCalledWith(sessionId, 'Hello from Gemini!');
			expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith(sessionId, 'Hello from Gemini!');
			// Non-partial text should NOT accumulate in streamedText
			expect(proc.streamedText).toBe('');
		});

		it('should route partial/delta Gemini text through thinking-chunk only', () => {
			const parser = createGeminiParser();
			const { handler, emitter, bufferManager, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'gemini-cli',
				outputParser: parser as any,
			});

			const thinkingSpy = vi.fn();
			emitter.on('thinking-chunk', thinkingSpy);

			sendJsonLine(handler, sessionId, {
				type: 'message',
				role: 'assistant',
				content: 'streaming...',
				delta: true,
			});

			// Partial text should go through thinking-chunk only, NOT data
			expect(thinkingSpy).toHaveBeenCalledWith(sessionId, 'streaming...');
			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();
			// Should accumulate in streamedText for result-time emission
			expect(proc.streamedText).toBe('streaming...');
		});

		it('should use accumulated streamedText as fallback in result event after partial streaming', () => {
			// Parser that returns partial text events, then a result event
			const parser = {
				agentId: 'gemini-cli',
				parseJsonLine: vi.fn((line: string) => {
					try {
						const parsed = JSON.parse(line);
						if (parsed.type === 'result') {
							return { type: 'result' as const, text: '' }; // empty text on result
						}
						if (parsed.type === 'message' && parsed.role === 'assistant') {
							return {
								type: 'text' as const,
								text: parsed.content,
								isPartial: parsed.delta === true,
							};
						}
						return null;
					} catch {
						return null;
					}
				}),
				parseJsonObject: vi.fn((parsed: any) => {
					if (parsed.type === 'result') {
						return { type: 'result' as const, text: '' }; // empty text on result
					}
					if (parsed.type === 'message' && parsed.role === 'assistant') {
						return {
							type: 'text' as const,
							text: parsed.content,
							isPartial: parsed.delta === true,
						};
					}
					return null;
				}),
				extractUsage: vi.fn(() => null),
				extractSessionId: vi.fn(() => null),
				extractSlashCommands: vi.fn(() => null),
				isResultMessage: vi.fn((event: any) => event.type === 'result'),
				detectErrorFromLine: vi.fn(() => null),
				detectErrorFromParsed: vi.fn(() => null),
			};

			const { handler, emitter, bufferManager, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'gemini-cli',
				outputParser: parser as any,
			});

			const thinkingSpy = vi.fn();
			emitter.on('thinking-chunk', thinkingSpy);

			// Send partial streaming chunks
			sendJsonLine(handler, sessionId, {
				type: 'message',
				role: 'assistant',
				content: 'Hello ',
				delta: true,
			});
			sendJsonLine(handler, sessionId, {
				type: 'message',
				role: 'assistant',
				content: 'from Gemini!',
				delta: true,
			});

			// Verify partial chunks accumulated
			expect(proc.streamedText).toBe('Hello from Gemini!');
			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();

			// Send result event with empty text — should fall back to streamedText
			sendJsonLine(handler, sessionId, { type: 'result' });

			expect(proc.resultEmitted).toBe(true);
			expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith(sessionId, 'Hello from Gemini!');
		});

		it('should not affect Claude Code partial text routing (non-Gemini agent unaffected)', () => {
			const parser = {
				agentId: 'claude-code',
				parseJsonLine: vi.fn((line: string) => {
					try {
						const parsed = JSON.parse(line);
						if (parsed.type === 'assistant' && parsed.content) {
							return {
								type: 'text' as const,
								text: parsed.content,
								isPartial: parsed.partial === true,
							};
						}
						return null;
					} catch {
						return null;
					}
				}),
				parseJsonObject: vi.fn((parsed: any) => {
					if (parsed.type === 'assistant' && parsed.content) {
						return {
							type: 'text' as const,
							text: parsed.content,
							isPartial: parsed.partial === true,
						};
					}
					return null;
				}),
				extractUsage: vi.fn(() => null),
				extractSessionId: vi.fn(() => null),
				extractSlashCommands: vi.fn(() => null),
				isResultMessage: vi.fn(() => false),
				detectErrorFromLine: vi.fn(() => null),
				detectErrorFromParsed: vi.fn(() => null),
			};

			const { handler, emitter, bufferManager, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'claude-code',
				outputParser: parser as any,
			});

			const thinkingSpy = vi.fn();
			emitter.on('thinking-chunk', thinkingSpy);

			// Send partial text for Claude Code
			sendJsonLine(handler, sessionId, {
				type: 'assistant',
				content: 'thinking about your question...',
				partial: true,
			});

			// Partial text should still go through thinking-chunk and accumulate in streamedText
			expect(thinkingSpy).toHaveBeenCalledWith(sessionId, 'thinking about your question...');
			expect(proc.streamedText).toBe('thinking about your question...');
			// Partial text should NOT be emitted via data path
			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();

			// Send non-partial text for Claude Code
			sendJsonLine(handler, sessionId, {
				type: 'assistant',
				content: 'Here is my answer.',
				partial: false,
			});

			// Non-partial Claude text also goes through thinking-chunk AND data path
			expect(thinkingSpy).toHaveBeenCalledWith(sessionId, 'Here is my answer.');
			expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith(sessionId, 'Here is my answer.');
		});
	});

	// ── normalizeUsageToDelta (tested via outputParser path) ───────────────

	describe('normalizeUsageToDelta (via outputParser stream-JSON path)', () => {
		/**
		 * These tests exercise the normalizeUsageToDelta function indirectly
		 * through the StdoutHandler's handleParsedEvent -> buildUsageStats ->
		 * normalizeUsageToDelta pipeline. We create a minimal outputParser mock
		 * that returns usage data, allowing us to observe the normalized result
		 * via the 'usage' event emitter.
		 */

		function createOutputParserMock(
			usageReturn: {
				inputTokens: number;
				outputTokens: number;
				cacheReadTokens?: number;
				cacheCreationTokens?: number;
				costUsd?: number;
				contextWindow?: number;
				reasoningTokens?: number;
			} | null
		) {
			return {
				agentId: 'claude-code',
				parseJsonLine: vi.fn((line: string) => {
					try {
						const parsed = JSON.parse(line);
						return {
							type: parsed.type || 'message',
							text: parsed.text,
							isPartial: false,
						};
					} catch {
						return null;
					}
				}),
				parseJsonObject: vi.fn((parsed: any) => {
					return {
						type: parsed.type || 'message',
						text: parsed.text,
						isPartial: false,
					};
				}),
				extractUsage: vi.fn(() => usageReturn),
				extractSessionId: vi.fn(() => null),
				extractSlashCommands: vi.fn(() => null),
				isResultMessage: vi.fn(() => false),
				detectErrorFromLine: vi.fn(() => null),
				detectErrorFromParsed: vi.fn(() => null),
			};
		}

		it('should pass through usage stats on first call (no previous totals)', () => {
			const parser = createOutputParserMock({
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 200,
				cacheCreationTokens: 100,
				costUsd: 0.05,
				contextWindow: 200000,
			});

			const { handler, emitter, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'claude-code',
				outputParser: parser as any,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			sendJsonLine(handler, sessionId, { type: 'message', text: 'hello' });

			expect(usageSpy).toHaveBeenCalledTimes(1);
			const emittedUsage = usageSpy.mock.calls[0][1];
			expect(emittedUsage.inputTokens).toBe(1000);
			expect(emittedUsage.outputTokens).toBe(500);
			expect(emittedUsage.cacheReadInputTokens).toBe(200);
			expect(emittedUsage.cacheCreationInputTokens).toBe(100);
			expect(emittedUsage.totalCostUsd).toBe(0.05);
			expect(emittedUsage.contextWindow).toBe(200000);

			// Should have stored totals for next call
			expect(proc.lastUsageTotals).toEqual({
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadInputTokens: 200,
				cacheCreationInputTokens: 100,
				reasoningTokens: 0,
			});
		});

		it('should compute delta on second cumulative call (monotonically increasing)', () => {
			// Start with a parser that returns increasing cumulative values
			let callCount = 0;
			const usageSequence = [
				{
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadTokens: 200,
					cacheCreationTokens: 100,
					costUsd: 0.05,
					contextWindow: 200000,
				},
				{
					inputTokens: 1800,
					outputTokens: 900,
					cacheReadTokens: 350,
					cacheCreationTokens: 180,
					costUsd: 0.09,
					contextWindow: 200000,
				},
			];

			const parser = createOutputParserMock(null);
			parser.extractUsage.mockImplementation(() => {
				return usageSequence[callCount++] || null;
			});

			const { handler, emitter, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'claude-code',
				outputParser: parser as any,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			// First call: returns raw values
			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 1' });

			expect(usageSpy).toHaveBeenCalledTimes(1);
			expect(usageSpy.mock.calls[0][1].inputTokens).toBe(1000);
			expect(usageSpy.mock.calls[0][1].outputTokens).toBe(500);

			// Second call: should return delta
			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 2' });

			expect(usageSpy).toHaveBeenCalledTimes(2);
			const delta = usageSpy.mock.calls[1][1];
			expect(delta.inputTokens).toBe(800); // 1800 - 1000
			expect(delta.outputTokens).toBe(400); // 900 - 500
			expect(delta.cacheReadInputTokens).toBe(150); // 350 - 200
			expect(delta.cacheCreationInputTokens).toBe(80); // 180 - 100

			// Cost and contextWindow should still be passed through from the raw stats
			expect(delta.totalCostUsd).toBe(0.09);
			expect(delta.contextWindow).toBe(200000);

			// usageIsCumulative should be set to true
			expect(proc.usageIsCumulative).toBe(true);
		});

		it('should detect non-monotonic decrease and switch to raw mode', () => {
			let callCount = 0;
			const usageSequence = [
				{
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadTokens: 200,
					cacheCreationTokens: 100,
					costUsd: 0.05,
					contextWindow: 200000,
				},
				{
					// inputTokens decreased: indicates per-turn reporting, not cumulative
					inputTokens: 300,
					outputTokens: 150,
					cacheReadTokens: 50,
					cacheCreationTokens: 20,
					costUsd: 0.02,
					contextWindow: 200000,
				},
			];

			const parser = createOutputParserMock(null);
			parser.extractUsage.mockImplementation(() => {
				return usageSequence[callCount++] || null;
			});

			const { handler, emitter, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'claude-code',
				outputParser: parser as any,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			// First call: raw values
			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 1' });
			expect(usageSpy.mock.calls[0][1].inputTokens).toBe(1000);

			// Second call: decrease detected, returns raw values (not negative deltas)
			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 2' });

			expect(usageSpy).toHaveBeenCalledTimes(2);
			const rawStats = usageSpy.mock.calls[1][1];
			expect(rawStats.inputTokens).toBe(300);
			expect(rawStats.outputTokens).toBe(150);
			expect(rawStats.cacheReadInputTokens).toBe(50);
			expect(rawStats.cacheCreationInputTokens).toBe(20);

			// Should have flagged as non-cumulative
			expect(proc.usageIsCumulative).toBe(false);
		});

		it('should continue returning raw stats once usageIsCumulative is false', () => {
			let callCount = 0;
			const usageSequence = [
				{
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadTokens: 200,
					cacheCreationTokens: 100,
					costUsd: 0.05,
					contextWindow: 200000,
				},
				{
					// Decrease triggers non-cumulative detection
					inputTokens: 300,
					outputTokens: 150,
					cacheReadTokens: 50,
					cacheCreationTokens: 20,
					costUsd: 0.02,
					contextWindow: 200000,
				},
				{
					// Third call: even though this looks "cumulative" relative to 2nd,
					// usageIsCumulative is false so it returns raw
					inputTokens: 800,
					outputTokens: 400,
					cacheReadTokens: 100,
					cacheCreationTokens: 50,
					costUsd: 0.04,
					contextWindow: 200000,
				},
			];

			const parser = createOutputParserMock(null);
			parser.extractUsage.mockImplementation(() => {
				return usageSequence[callCount++] || null;
			});

			const { handler, emitter, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'claude-code',
				outputParser: parser as any,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			// Turn 1
			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 1' });
			// Turn 2: triggers non-cumulative
			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 2' });
			expect(proc.usageIsCumulative).toBe(false);

			// Turn 3: should still return raw since flag is false
			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 3' });

			expect(usageSpy).toHaveBeenCalledTimes(3);
			const thirdCallUsage = usageSpy.mock.calls[2][1];
			expect(thirdCallUsage.inputTokens).toBe(800);
			expect(thirdCallUsage.outputTokens).toBe(400);
			expect(thirdCallUsage.cacheReadInputTokens).toBe(100);
			expect(thirdCallUsage.cacheCreationInputTokens).toBe(50);

			// Flag should remain false
			expect(proc.usageIsCumulative).toBe(false);
		});

		it('should handle multiple consecutive cumulative turns correctly', () => {
			let callCount = 0;
			const usageSequence = [
				{
					inputTokens: 500,
					outputTokens: 200,
					cacheReadTokens: 100,
					cacheCreationTokens: 50,
					costUsd: 0.03,
					contextWindow: 200000,
				},
				{
					inputTokens: 1200,
					outputTokens: 600,
					cacheReadTokens: 300,
					cacheCreationTokens: 120,
					costUsd: 0.07,
					contextWindow: 200000,
				},
				{
					inputTokens: 2000,
					outputTokens: 1000,
					cacheReadTokens: 500,
					cacheCreationTokens: 200,
					costUsd: 0.12,
					contextWindow: 200000,
				},
			];

			const parser = createOutputParserMock(null);
			parser.extractUsage.mockImplementation(() => {
				return usageSequence[callCount++] || null;
			});

			const { handler, emitter, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'claude-code',
				outputParser: parser as any,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			// Turn 1: raw
			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 1' });
			expect(usageSpy.mock.calls[0][1].inputTokens).toBe(500);

			// Turn 2: delta from turn 1
			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 2' });
			expect(usageSpy.mock.calls[1][1].inputTokens).toBe(700); // 1200 - 500
			expect(usageSpy.mock.calls[1][1].outputTokens).toBe(400); // 600 - 200

			// Turn 3: delta from turn 2
			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 3' });
			expect(usageSpy.mock.calls[2][1].inputTokens).toBe(800); // 2000 - 1200
			expect(usageSpy.mock.calls[2][1].outputTokens).toBe(400); // 1000 - 600
			expect(usageSpy.mock.calls[2][1].cacheReadInputTokens).toBe(200); // 500 - 300
			expect(usageSpy.mock.calls[2][1].cacheCreationInputTokens).toBe(80); // 200 - 120

			expect(proc.usageIsCumulative).toBe(true);
		});

		it('should handle zero deltas correctly (same cumulative values)', () => {
			let callCount = 0;
			const usageSequence = [
				{
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadTokens: 200,
					cacheCreationTokens: 100,
					costUsd: 0.05,
					contextWindow: 200000,
				},
				{
					// Identical to first (no new tokens consumed)
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadTokens: 200,
					cacheCreationTokens: 100,
					costUsd: 0.05,
					contextWindow: 200000,
				},
			];

			const parser = createOutputParserMock(null);
			parser.extractUsage.mockImplementation(() => {
				return usageSequence[callCount++] || null;
			});

			const { handler, emitter, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'claude-code',
				outputParser: parser as any,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 1' });
			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 2' });

			expect(usageSpy).toHaveBeenCalledTimes(2);
			const delta = usageSpy.mock.calls[1][1];
			expect(delta.inputTokens).toBe(0);
			expect(delta.outputTokens).toBe(0);
			expect(delta.cacheReadInputTokens).toBe(0);
			expect(delta.cacheCreationInputTokens).toBe(0);

			// Zero delta is still monotonic, so cumulative stays true
			expect(proc.usageIsCumulative).toBe(true);
		});

		it('should handle reasoningTokens in cumulative delta calculations', () => {
			let callCount = 0;
			const usageSequence = [
				{
					inputTokens: 500,
					outputTokens: 200,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					costUsd: 0.03,
					contextWindow: 200000,
					reasoningTokens: 100,
				},
				{
					inputTokens: 1000,
					outputTokens: 400,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					costUsd: 0.06,
					contextWindow: 200000,
					reasoningTokens: 250,
				},
			];

			const parser = createOutputParserMock(null);
			parser.extractUsage.mockImplementation(() => {
				return usageSequence[callCount++] || null;
			});

			const { handler, emitter, sessionId } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'codex',
				outputParser: parser as any,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 1' });
			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 2' });

			expect(usageSpy).toHaveBeenCalledTimes(2);
			const delta = usageSpy.mock.calls[1][1];
			expect(delta.inputTokens).toBe(500); // 1000 - 500
			expect(delta.outputTokens).toBe(200); // 400 - 200
			expect(delta.reasoningTokens).toBe(150); // 250 - 100
		});

		it('should detect decrease in reasoningTokens as non-monotonic', () => {
			let callCount = 0;
			const usageSequence = [
				{
					inputTokens: 500,
					outputTokens: 200,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					costUsd: 0.03,
					contextWindow: 200000,
					reasoningTokens: 300,
				},
				{
					// All fields increase except reasoningTokens decreases
					inputTokens: 1000,
					outputTokens: 400,
					cacheReadTokens: 50,
					cacheCreationTokens: 20,
					costUsd: 0.06,
					contextWindow: 200000,
					reasoningTokens: 100,
				},
			];

			const parser = createOutputParserMock(null);
			parser.extractUsage.mockImplementation(() => {
				return usageSequence[callCount++] || null;
			});

			const { handler, emitter, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'codex',
				outputParser: parser as any,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 1' });
			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 2' });

			expect(usageSpy).toHaveBeenCalledTimes(2);
			// Non-monotonic detected -- raw values returned
			const rawStats = usageSpy.mock.calls[1][1];
			expect(rawStats.inputTokens).toBe(1000);
			expect(rawStats.outputTokens).toBe(400);
			expect(rawStats.reasoningTokens).toBe(100);

			expect(proc.usageIsCumulative).toBe(false);
		});

		it('should NOT normalize usage for non-claude-code/codex toolTypes', () => {
			let callCount = 0;
			const usageSequence = [
				{
					inputTokens: 500,
					outputTokens: 200,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					costUsd: 0.03,
					contextWindow: 200000,
				},
				{
					inputTokens: 1200,
					outputTokens: 600,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					costUsd: 0.07,
					contextWindow: 200000,
				},
			];

			const parser = createOutputParserMock(null);
			parser.extractUsage.mockImplementation(() => {
				return usageSequence[callCount++] || null;
			});

			const { handler, emitter, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'opencode',
				outputParser: parser as any,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 1' });
			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 2' });

			expect(usageSpy).toHaveBeenCalledTimes(2);
			// opencode does NOT go through normalizeUsageToDelta, so raw values
			const second = usageSpy.mock.calls[1][1];
			expect(second.inputTokens).toBe(1200);
			expect(second.outputTokens).toBe(600);

			// lastUsageTotals should NOT be set since normalization was skipped
			expect(proc.lastUsageTotals).toBeUndefined();
		});

		it('should normalize usage for codex toolType (not just claude-code)', () => {
			let callCount = 0;
			const usageSequence = [
				{
					inputTokens: 500,
					outputTokens: 200,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					costUsd: 0.03,
					contextWindow: 200000,
				},
				{
					inputTokens: 1200,
					outputTokens: 600,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					costUsd: 0.07,
					contextWindow: 200000,
				},
			];

			const parser = createOutputParserMock(null);
			parser.extractUsage.mockImplementation(() => {
				return usageSequence[callCount++] || null;
			});

			const { handler, emitter, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'codex',
				outputParser: parser as any,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 1' });
			sendJsonLine(handler, sessionId, { type: 'message', text: 'turn 2' });

			expect(usageSpy).toHaveBeenCalledTimes(2);
			const delta = usageSpy.mock.calls[1][1];
			expect(delta.inputTokens).toBe(700); // 1200 - 500
			expect(delta.outputTokens).toBe(400); // 600 - 200

			expect(proc.usageIsCumulative).toBe(true);
		});

		it('should not emit usage when extractUsage returns null', () => {
			const parser = createOutputParserMock(null);
			// extractUsage always returns null (already the default from our null param)

			const { handler, emitter, sessionId } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'claude-code',
				outputParser: parser as any,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			sendJsonLine(handler, sessionId, { type: 'message', text: 'no usage' });

			expect(usageSpy).not.toHaveBeenCalled();
		});
	});

	// ── buildUsageStats (indirectly tested via defaults) ───────────────────

	describe('buildUsageStats defaults', () => {
		it('should default optional fields to 0 when not provided by parser', () => {
			const parser = createMinimalOutputParser({
				inputTokens: 100,
				outputTokens: 50,
				// No cacheReadTokens, cacheCreationTokens, costUsd, contextWindow
			});

			const { handler, emitter, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'opencode', // avoid normalization
				outputParser: parser as any,
				contextWindow: 128000,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			sendJsonLine(handler, sessionId, { type: 'message', text: 'hi' });

			expect(usageSpy).toHaveBeenCalledTimes(1);
			const stats = usageSpy.mock.calls[0][1];
			expect(stats.inputTokens).toBe(100);
			expect(stats.outputTokens).toBe(50);
			expect(stats.cacheReadInputTokens).toBe(0);
			expect(stats.cacheCreationInputTokens).toBe(0);
			expect(stats.totalCostUsd).toBe(0);
			// Falls back to managedProcess.contextWindow
			expect(stats.contextWindow).toBe(128000);
		});

		it('should use parser-reported contextWindow over managedProcess default', () => {
			const parser = createMinimalOutputParser({
				inputTokens: 100,
				outputTokens: 50,
				contextWindow: 1000000,
			});

			const { handler, emitter, sessionId } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'opencode',
				outputParser: parser as any,
				contextWindow: 200000,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			sendJsonLine(handler, sessionId, { type: 'message', text: 'hi' });

			expect(usageSpy.mock.calls[0][1].contextWindow).toBe(1000000);
		});

		it('should fall back to 200000 when neither parser nor process has contextWindow', () => {
			const parser = createMinimalOutputParser({
				inputTokens: 100,
				outputTokens: 50,
				// no contextWindow from parser
			});

			const { handler, emitter, sessionId } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'opencode',
				outputParser: parser as any,
				contextWindow: undefined,
			});

			const usageSpy = vi.fn();
			emitter.on('usage', usageSpy);

			sendJsonLine(handler, sessionId, { type: 'message', text: 'hi' });

			expect(usageSpy.mock.calls[0][1].contextWindow).toBe(200000);
		});
	});

	// ── Stream JSON mode: multi-line handling ──────────────────────────────

	describe('stream JSON mode line splitting', () => {
		it('should process multiple complete JSON lines in a single chunk', () => {
			const { handler, emitter, bufferManager, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
			});

			const sessionIdSpy = vi.fn();
			emitter.on('session-id', sessionIdSpy);

			const chunk =
				JSON.stringify({ session_id: 'abc' }) +
				'\n' +
				JSON.stringify({ type: 'result', result: 'done' }) +
				'\n';

			handler.handleData(sessionId, chunk);

			expect(proc.sessionIdEmitted).toBe(true);
			expect(proc.resultEmitted).toBe(true);
			expect(sessionIdSpy).toHaveBeenCalledWith(sessionId, 'abc');
			expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith(sessionId, 'done');
		});

		it('should reassemble split JSON lines across multiple chunks', () => {
			const { handler, bufferManager, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
			});

			const fullJson = JSON.stringify({ type: 'result', result: 'split-result' });
			const half1 = fullJson.substring(0, Math.floor(fullJson.length / 2));
			const half2 = fullJson.substring(Math.floor(fullJson.length / 2));

			// Send first half (no newline, so it stays in buffer)
			handler.handleData(sessionId, half1);
			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();

			// Send second half with newline
			handler.handleData(sessionId, half2 + '\n');
			expect(proc.resultEmitted).toBe(true);
			expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith(sessionId, 'split-result');
		});
	});

	// ── Edge cases ─────────────────────────────────────────────────────────

	describe('Gemini CLI non-partial text events', () => {
		function createGeminiParser() {
			return {
				agentId: 'gemini-cli',
				parseJsonLine: vi.fn(() => null),
				parseJsonObject: vi.fn((parsed: any) => {
					if (parsed.type === 'message' && parsed.role === 'assistant') {
						return {
							type: 'text',
							text: parsed.content,
							isPartial: parsed.delta === true,
							raw: parsed,
						};
					}
					if (parsed.type === 'result') {
						return { type: 'result', text: '', raw: parsed };
					}
					return null;
				}),
				extractUsage: vi.fn(() => null),
				extractSessionId: vi.fn(() => null),
				extractSlashCommands: vi.fn(() => null),
				isResultMessage: vi.fn((event: any) => event?.raw?.type === 'result'),
				detectErrorFromLine: vi.fn(() => null),
				detectErrorFromParsed: vi.fn(() => null),
				detectErrorFromExit: vi.fn(() => null),
			};
		}

		it('should emit complete (delta:false) message events as data immediately', () => {
			const parser = createGeminiParser();
			const { handler, bufferManager, sessionId, proc, emitter } = createTestContext({
				toolType: 'gemini-cli' as any,
				isStreamJsonMode: true,
				outputParser: parser as any,
			});

			const thinkingSpy = vi.fn();
			emitter.on('thinking-chunk', thinkingSpy);

			// Gemini sends a complete message (delta: false or absent)
			sendJsonLine(handler, sessionId, {
				type: 'message',
				role: 'assistant',
				content: 'Hello! How can I help you?',
			});

			// Should be emitted immediately as data, not accumulated
			expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith(
				sessionId,
				'Hello! How can I help you?'
			);
			// Should also emit thinking-chunk for live display
			expect(thinkingSpy).toHaveBeenCalledWith(sessionId, 'Hello! How can I help you?');
			// Should NOT be accumulated in streamedText
			expect(proc.streamedText).toBe('');
		});

		it('should accumulate partial (delta:true) message events in streamedText', () => {
			const parser = createGeminiParser();
			const { handler, bufferManager, sessionId, proc, emitter } = createTestContext({
				toolType: 'gemini-cli' as any,
				isStreamJsonMode: true,
				outputParser: parser as any,
			});

			const thinkingSpy = vi.fn();
			emitter.on('thinking-chunk', thinkingSpy);

			// Gemini sends streaming delta
			sendJsonLine(handler, sessionId, {
				type: 'message',
				role: 'assistant',
				content: 'Hello',
				delta: true,
			});

			// Should accumulate in streamedText
			expect(proc.streamedText).toBe('Hello');
			// Should emit thinking-chunk
			expect(thinkingSpy).toHaveBeenCalledWith(sessionId, 'Hello');
			// Should NOT emit via emitDataBuffered (deferred to result)
			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();
		});
	});

	describe('edge cases', () => {
		it('should emit non-JSON lines via bufferManager in stream JSON mode', () => {
			const { handler, bufferManager, sessionId } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
			});

			handler.handleData(sessionId, 'This is not JSON\n');
			expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith(sessionId, 'This is not JSON');
		});

		it('should append to stdoutBuffer for each processed line in stream JSON mode', () => {
			const { handler, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
				stdoutBuffer: '',
			});

			sendJsonLine(handler, sessionId, { session_id: 'x' });

			// stdoutBuffer should contain the processed line
			expect(proc.stdoutBuffer).toContain('session_id');
		});

		it('should handle result with empty result string gracefully', () => {
			const { handler, bufferManager, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
			});

			sendJsonLine(handler, sessionId, {
				type: 'result',
				result: '',
			});

			// Empty string is falsy in JS, so the legacy handler's
			// `msgRecord.result && ...` guard skips it entirely
			expect(proc.resultEmitted).toBe(false);
			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();
		});

		it('should handle result with no result field gracefully', () => {
			const { handler, bufferManager, sessionId, proc } = createTestContext({
				isStreamJsonMode: true,
				outputParser: undefined,
			});

			sendJsonLine(handler, sessionId, {
				type: 'result',
				// no result field
			});

			// msgRecord.result is undefined which is falsy, so resultEmitted stays false
			expect(proc.resultEmitted).toBe(false);
			expect(bufferManager.emitDataBuffered).not.toHaveBeenCalled();
		});
	});

	// ── OpenCode multi-step result handling ────────────────────────────────

	describe('opencode multi-step result handling', () => {
		/**
		 * OpenCode emits multiple steps: step_start → text → tool_use → step_finish(tool-calls) → repeat.
		 * Each step can have a text event (intermediate thinking). Only the last text event
		 * (before step_finish with reason:"stop") is the real result.
		 *
		 * Bug reproduced from issue #512: the first text event locked resultEmitted=true,
		 * causing subsequent text events (including the final summary) to be silently dropped.
		 *
		 * Fix: reset resultEmitted on each new step_start for opencode.
		 */
		function createOpenCodeParser() {
			return {
				agentId: 'opencode',
				parseJsonLine: vi.fn((line: string) => {
					const parsed = JSON.parse(line);
					if (parsed.type === 'step_start') {
						return { type: 'init', sessionId: parsed.sessionID };
					}
					if (parsed.type === 'text') {
						return { type: 'result', text: parsed.part?.text, sessionId: parsed.sessionID };
					}
					if (parsed.type === 'tool_use') {
						return { type: 'tool_use', toolName: parsed.part?.tool, sessionId: parsed.sessionID };
					}
					if (parsed.type === 'step_finish') {
						return { type: 'system', sessionId: parsed.sessionID };
					}
					return { type: 'system' };
				}),
				parseJsonObject: vi.fn((parsed: any) => {
					if (parsed.type === 'step_start') {
						return { type: 'init', sessionId: parsed.sessionID };
					}
					if (parsed.type === 'text') {
						return { type: 'result', text: parsed.part?.text, sessionId: parsed.sessionID };
					}
					if (parsed.type === 'tool_use') {
						return { type: 'tool_use', toolName: parsed.part?.tool, sessionId: parsed.sessionID };
					}
					if (parsed.type === 'step_finish') {
						return { type: 'system', sessionId: parsed.sessionID };
					}
					return { type: 'system' };
				}),
				extractUsage: vi.fn(() => null),
				extractSessionId: vi.fn((event: any) => event.sessionId || null),
				extractSlashCommands: vi.fn(() => null),
				isResultMessage: vi.fn((event: any) => event.type === 'result'),
				detectErrorFromLine: vi.fn(() => null),
				detectErrorFromParsed: vi.fn(() => null),
			};
		}

		it('should emit the final text result (last step) not just the first', () => {
			// Reproduces issue #512: step1 text was shown, step3 final summary was dropped
			const parser = createOpenCodeParser();
			const { handler, bufferManager, sessionId } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'opencode',
				outputParser: parser as any,
			});

			// Step 1: tool call with no text before it
			sendJsonLine(handler, sessionId, { type: 'step_start', sessionID: 'ses_abc' });
			sendJsonLine(handler, sessionId, {
				type: 'tool_use',
				sessionID: 'ses_abc',
				part: { tool: 'glob' },
			});
			sendJsonLine(handler, sessionId, {
				type: 'step_finish',
				sessionID: 'ses_abc',
				part: { reason: 'tool-calls' },
			});

			// Step 2: intermediate thinking text + more tool calls
			sendJsonLine(handler, sessionId, { type: 'step_start', sessionID: 'ses_abc' });
			sendJsonLine(handler, sessionId, {
				type: 'text',
				sessionID: 'ses_abc',
				part: { text: 'Intermediate thinking...' },
			});
			sendJsonLine(handler, sessionId, {
				type: 'tool_use',
				sessionID: 'ses_abc',
				part: { tool: 'glob' },
			});
			sendJsonLine(handler, sessionId, {
				type: 'step_finish',
				sessionID: 'ses_abc',
				part: { reason: 'tool-calls' },
			});

			// Step 3: final answer
			sendJsonLine(handler, sessionId, { type: 'step_start', sessionID: 'ses_abc' });
			sendJsonLine(handler, sessionId, {
				type: 'text',
				sessionID: 'ses_abc',
				part: { text: 'Final summary answer.' },
			});
			sendJsonLine(handler, sessionId, {
				type: 'step_finish',
				sessionID: 'ses_abc',
				part: { reason: 'stop' },
			});

			const emittedTexts = (bufferManager.emitDataBuffered as any).mock.calls.map(
				(call: any[]) => call[1]
			);

			// Both the intermediate and final texts should be emitted
			expect(emittedTexts).toContain('Intermediate thinking...');
			expect(emittedTexts).toContain('Final summary answer.');
		});

		it('should reset resultEmitted on each new step_start for opencode', () => {
			const parser = createOpenCodeParser();
			const { handler, proc, sessionId } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'opencode',
				outputParser: parser as any,
			});

			// After first step_start, resultEmitted should be false
			sendJsonLine(handler, sessionId, { type: 'step_start', sessionID: 'ses_abc' });
			expect(proc.resultEmitted).toBe(false);

			// After text (result), resultEmitted becomes true
			sendJsonLine(handler, sessionId, {
				type: 'text',
				sessionID: 'ses_abc',
				part: { text: 'Step 1 text.' },
			});
			expect(proc.resultEmitted).toBe(true);

			// New step_start resets it
			sendJsonLine(handler, sessionId, { type: 'step_start', sessionID: 'ses_abc' });
			expect(proc.resultEmitted).toBe(false);
		});

		it('should NOT reset resultEmitted on step_start for non-opencode agents', () => {
			// claude-code should keep the one-result-per-run gate intact
			const parser = {
				agentId: 'claude-code',
				parseJsonLine: vi.fn((line: string) => {
					const parsed = JSON.parse(line);
					if (parsed.type === 'step_start') return { type: 'init', sessionId: 'x' };
					if (parsed.type === 'text') return { type: 'result', text: parsed.text };
					return { type: 'system' };
				}),
				parseJsonObject: vi.fn((parsed: any) => {
					if (parsed.type === 'step_start') return { type: 'init', sessionId: 'x' };
					if (parsed.type === 'text') return { type: 'result', text: parsed.text };
					return { type: 'system' };
				}),
				extractUsage: vi.fn(() => null),
				extractSessionId: vi.fn(() => null),
				extractSlashCommands: vi.fn(() => null),
				isResultMessage: vi.fn((event: any) => event.type === 'result'),
				detectErrorFromLine: vi.fn(() => null),
				detectErrorFromParsed: vi.fn(() => null),
			};

			const { handler, proc, sessionId } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'claude-code',
				outputParser: parser as any,
			});

			sendJsonLine(handler, sessionId, { type: 'step_start' });
			sendJsonLine(handler, sessionId, { type: 'text', text: 'First result.' });
			expect(proc.resultEmitted).toBe(true);

			// step_start should NOT reset for claude-code
			sendJsonLine(handler, sessionId, { type: 'step_start' });
			expect(proc.resultEmitted).toBe(true);
		});
	});
});

// ── Shared helper for minimal parser ───────────────────────────────────────

function createMinimalOutputParser(usageReturn: {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	costUsd?: number;
	contextWindow?: number;
	reasoningTokens?: number;
}) {
	return {
		agentId: 'opencode',
		parseJsonLine: vi.fn((line: string) => {
			try {
				const parsed = JSON.parse(line);
				return { type: parsed.type || 'message', text: parsed.text, isPartial: false };
			} catch {
				return null;
			}
		}),
		parseJsonObject: vi.fn((parsed: any) => {
			return { type: parsed.type || 'message', text: parsed.text, isPartial: false };
		}),
		extractUsage: vi.fn(() => usageReturn),
		extractSessionId: vi.fn(() => null),
		extractSlashCommands: vi.fn(() => null),
		isResultMessage: vi.fn(() => false),
		detectErrorFromLine: vi.fn(() => null),
		detectErrorFromParsed: vi.fn(() => null),
	};
}

// ── extractDeniedPath tests ─────────────────────────────────────────────────

describe('extractDeniedPath', () => {
	it('extracts directory from path with single quotes and "not in workspace"', () => {
		const result = extractDeniedPath("path '/home/user/project/src' not in workspace");
		expect(result).toBe('/home/user/project/src');
	});

	it('extracts parent directory when path is a file', () => {
		const result = extractDeniedPath("path '/home/user/project/src/main.ts' not in workspace");
		expect(result).toBe('/home/user/project/src');
	});

	it('extracts directory from double-quoted path', () => {
		const result = extractDeniedPath('path "/home/user/project" not in workspace');
		expect(result).toBe('/home/user/project');
	});

	it('extracts directory from "is outside" pattern', () => {
		const result = extractDeniedPath("'/tmp/data' is outside the allowed workspace");
		expect(result).toBe('/tmp/data');
	});

	it('rejects system-critical paths (permission denied on /etc)', () => {
		const result = extractDeniedPath("'/etc/config.json' permission denied");
		expect(result).toBeNull(); // /etc is a system path
	});

	it('rejects system-critical paths (bare /usr/local/bin)', () => {
		const result = extractDeniedPath('/usr/local/bin not in workspace');
		expect(result).toBeNull(); // /usr is a system path
	});

	it('rejects system-critical paths (bare file under /usr)', () => {
		const result = extractDeniedPath('/usr/local/bin/tool.py not in workspace');
		expect(result).toBeNull(); // /usr is a system path
	});

	it('returns null when no path pattern matches', () => {
		const result = extractDeniedPath('some random error message');
		expect(result).toBeNull();
	});

	it('returns null for empty string', () => {
		const result = extractDeniedPath('');
		expect(result).toBeNull();
	});

	it('handles tilde paths', () => {
		const result = extractDeniedPath("'~/projects/foo' not in workspace");
		expect(result).toBe('~/projects/foo');
	});

	// Windows path patterns
	it('extracts Windows quoted directory path', () => {
		const result = extractDeniedPath("'C:\\Users\\dev\\project' not in workspace");
		expect(result).toBe('C:\\Users\\dev\\project');
	});

	it('extracts parent directory from Windows file path', () => {
		const result = extractDeniedPath("'C:\\Users\\dev\\project\\main.ts' not in workspace");
		expect(result).toBe('C:\\Users\\dev\\project');
	});

	it('extracts Windows path with "is outside" pattern', () => {
		const result = extractDeniedPath("'D:\\workspace\\data' is outside the allowed workspace");
		expect(result).toBe('D:\\workspace\\data');
	});

	it('rejects Windows system path (C:\\Windows)', () => {
		const result = extractDeniedPath("'C:\\Windows\\config.json' permission denied");
		expect(result).toBeNull(); // C:\Windows is a system path
	});

	it('extracts bare Windows path without quotes', () => {
		const result = extractDeniedPath('C:\\Users\\dev\\project not in workspace');
		expect(result).toBe('C:\\Users\\dev\\project');
	});

	it('extracts parent dir for bare Windows file path', () => {
		const result = extractDeniedPath('C:\\Users\\dev\\project\\index.js not in workspace');
		expect(result).toBe('C:\\Users\\dev\\project');
	});

	it('extracts Windows path with forward slashes', () => {
		const result = extractDeniedPath("'C:/Users/dev/project' not in workspace");
		expect(result).toBe('C:/Users/dev/project');
	});

	it('extracts Windows path from generic "path" prefix', () => {
		const result = extractDeniedPath("path 'C:\\Users\\dev\\src' not in workspace");
		expect(result).toBe('C:\\Users\\dev\\src');
	});

	// Tests with projectCwd normalization
	it('normalizes relative traversal paths when projectCwd is provided', () => {
		const result = extractDeniedPath("path '../../sibling' not in workspace", '/home/user/project');
		expect(result).toBe('/home/sibling');
	});

	it('resolves tilde paths when projectCwd is provided', () => {
		const result = extractDeniedPath("'~/projects/foo' not in workspace", '/tmp/cwd');
		const os = require('os');
		expect(result).toBe(`${os.homedir()}/projects/foo`);
	});

	it('rejects root path from traversal with projectCwd', () => {
		const result = extractDeniedPath(
			"path '../../../../..' not in workspace",
			'/home/user/project'
		);
		expect(result).toBeNull(); // resolves to / which is a system path
	});
});

// ── Performance: single JSON.parse per NDJSON line ──────────────────────

describe('StdoutHandler — single JSON parse per line', () => {
	it('parses JSON exactly once per NDJSON line (output parser path)', () => {
		// Instrument JSON.parse to count calls
		const originalParse = JSON.parse;
		let parseCount = 0;
		const countingParse = vi.fn((...args: Parameters<typeof JSON.parse>) => {
			parseCount++;
			return originalParse.apply(JSON, args);
		});
		JSON.parse = countingParse;

		try {
			const mockParser = {
				agentId: 'gemini-cli',
				parseJsonLine: vi.fn(() => ({
					type: 'text' as const,
					text: 'hello',
					isPartial: true,
					raw: {},
				})),
				parseJsonObject: vi.fn((parsed: unknown) => ({
					type: 'text' as const,
					text: 'hello',
					isPartial: true,
					raw: parsed,
				})),
				isResultMessage: vi.fn(() => false),
				extractSessionId: vi.fn(() => null),
				extractUsage: vi.fn(() => null),
				extractSlashCommands: vi.fn(() => null),
				detectErrorFromLine: vi.fn(() => null),
				detectErrorFromParsed: vi.fn(() => null),
				detectErrorFromExit: vi.fn(() => null),
			};

			const { handler, sessionId } = createTestContext({
				isStreamJsonMode: true,
				toolType: 'gemini-cli' as any,
				outputParser: mockParser as any,
			});

			// Send a valid JSON line
			const jsonLine = JSON.stringify({
				type: 'message',
				role: 'assistant',
				content: 'hi',
				delta: true,
			});
			parseCount = 0; // reset after the stringify parse above

			handler.handleData(sessionId, jsonLine + '\n');

			// Should parse exactly once (in processLine), not 3× as before
			expect(parseCount).toBe(1);

			// parseJsonObject should be called with pre-parsed object (not parseJsonLine)
			expect(mockParser.parseJsonObject).toHaveBeenCalledTimes(1);
			expect(mockParser.parseJsonLine).not.toHaveBeenCalled();

			// detectErrorFromParsed should be called (not detectErrorFromLine)
			expect(mockParser.detectErrorFromParsed).toHaveBeenCalledTimes(1);
			expect(mockParser.detectErrorFromLine).not.toHaveBeenCalled();
		} finally {
			JSON.parse = originalParse;
		}
	});

	it('falls back to detectErrorFromLine for non-JSON lines', () => {
		const mockParser = {
			agentId: 'claude-code',
			parseJsonLine: vi.fn(() => null),
			parseJsonObject: vi.fn(() => null),
			isResultMessage: vi.fn(() => false),
			extractSessionId: vi.fn(() => null),
			extractUsage: vi.fn(() => null),
			extractSlashCommands: vi.fn(() => null),
			detectErrorFromLine: vi.fn(() => null),
			detectErrorFromParsed: vi.fn(() => null),
			detectErrorFromExit: vi.fn(() => null),
		};

		const { handler, sessionId } = createTestContext({
			isStreamJsonMode: true,
			toolType: 'claude-code' as any,
			outputParser: mockParser as any,
		});

		// Send a non-JSON line (e.g., stderr with embedded JSON)
		handler.handleData(sessionId, 'Error streaming: 400 {"type":"error"}\n');

		// Should fall back to line-based detection since JSON.parse fails
		expect(mockParser.detectErrorFromLine).toHaveBeenCalledTimes(1);
		expect(mockParser.detectErrorFromParsed).not.toHaveBeenCalled();
	});
});
