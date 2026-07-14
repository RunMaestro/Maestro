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

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../../main/parsers/error-patterns', () => ({
	matchSshErrorPattern: vi.fn(() => null),
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

vi.mock('../../../../main/process-manager/utils/imageUtils', () => ({
	cleanupTempFiles: vi.fn(),
}));

// SSH config resolution: real getters require initialized stores, which don't
// exist in unit tests. Mock so each test controls whether the remote resolves.
vi.mock('../../../../main/stores/getters', () => ({
	getSshRemoteById: vi.fn(() => null),
}));

// For SSH-remote Copilot sessions the events file is read over SSH via
// remote-fs. Mock the two read paths the shutdown reconciliation uses.
vi.mock('../../../../main/utils/remote-fs', () => ({
	readFileRemote: vi.fn(),
	readFileTailRemote: vi.fn(),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { ExitHandler } from '../../../../main/process-manager/handlers/ExitHandler';
import { DataBufferManager } from '../../../../main/process-manager/handlers/DataBufferManager';
import { matchSshErrorPattern } from '../../../../main/parsers/error-patterns';
import { getSshRemoteById } from '../../../../main/stores/getters';
import { readFileRemote, readFileTailRemote } from '../../../../main/utils/remote-fs';
import type { ManagedProcess } from '../../../../main/process-manager/types';
import type { AgentOutputParser, ParsedEvent } from '../../../../main/parsers';

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
		processes = new Map();
		emitter = new EventEmitter();
		bufferManager = new DataBufferManager(processes, emitter);
		exitHandler = new ExitHandler({ processes, emitter, bufferManager });
		// Default: no SSH remote resolves and no remote reads happen. Individual
		// SSH tests override these. Reset so per-test mock values don't leak.
		vi.mocked(getSshRemoteById)
			.mockReset()
			.mockReturnValue(null as never);
		vi.mocked(readFileRemote).mockReset();
		vi.mocked(readFileTailRemote).mockReset();
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

	describe('SSH error pattern false-positive prevention', () => {
		it('should only check stderr for SSH patterns, not stdout', async () => {
			const mockedMatchSsh = vi.mocked(matchSshErrorPattern);
			mockedMatchSsh.mockReturnValue(null);

			const proc = createMockProcess({
				sshRemoteId: 'remote-1',
				// stdout contains JSONL with response text that mentions "command not found"
				stdoutBuffer:
					'{"type":"assistant","message":{"content":[{"text":"bash: opencode: command not found"}]}}\n',
				stderrBuffer: 'Warning: something harmless',
			});
			processes.set('test-session', proc);

			await exitHandler.handleExit('test-session', 1);

			// Should be called with stderr only, NOT the combined stdout+stderr
			expect(mockedMatchSsh).toHaveBeenCalledWith('Warning: something harmless');

			mockedMatchSsh.mockReset();
		});

		it('should NOT false-positive when agent response text contains SSH error keywords', async () => {
			const mockedMatchSsh = vi.mocked(matchSshErrorPattern);
			// Return null — no SSH error in stderr
			mockedMatchSsh.mockReturnValue(null);

			const proc = createMockProcess({
				sshRemoteId: 'remote-1',
				stdoutBuffer:
					'{"type":"result","result":"The pattern bash:.*opencode.*command not found matches shell errors"}\n',
				stderrBuffer: '',
			});
			processes.set('test-session', proc);

			const errors: unknown[] = [];
			emitter.on('agent-error', (...args: unknown[]) => errors.push(args));

			await exitHandler.handleExit('test-session', 1);

			// matchSshErrorPattern should receive empty stderr, not the stdout with response text
			expect(mockedMatchSsh).toHaveBeenCalledWith('');
			expect(errors).toHaveLength(0);

			mockedMatchSsh.mockReset();
		});

		it('should detect real SSH errors from stderr', async () => {
			const mockedMatchSsh = vi.mocked(matchSshErrorPattern);
			mockedMatchSsh.mockReturnValue({
				type: 'agent_crashed',
				message: 'OpenCode command not found.',
				recoverable: false,
			});

			const proc = createMockProcess({
				sshRemoteId: 'remote-1',
				stdoutBuffer: '',
				stderrBuffer: 'bash: opencode: command not found',
			});
			processes.set('test-session', proc);

			const errors: Array<[string, unknown]> = [];
			emitter.on('agent-error', (sid: string, err: unknown) => errors.push([sid, err]));

			await exitHandler.handleExit('test-session', 1);

			expect(mockedMatchSsh).toHaveBeenCalledWith('bash: opencode: command not found');
			expect(errors).toHaveLength(1);

			mockedMatchSsh.mockReset();
		});
	});

	describe('Copilot post-exit shutdown wait', () => {
		it('blocks `exit` until events.jsonl shutdown marker is observed and overrides streamedText with the on-disk final answer', async () => {
			// Set up a real Copilot events.jsonl on a temp config dir. The
			// streamedText our parent captured is the stale planning narration;
			// the on-disk file has the real final answer plus the shutdown marker.
			const fs = await import('fs/promises');
			const os = await import('os');
			const path = await import('path');
			const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-exit-copilot-'));
			const agentSessionId = 'cp-exit-session';
			const eventsPath = path.join(configDir, 'session-state', agentSessionId, 'events.jsonl');
			await fs.mkdir(path.dirname(eventsPath), { recursive: true });
			await fs.writeFile(
				eventsPath,
				[
					JSON.stringify({ type: 'session.start', data: { sessionId: agentSessionId } }),
					JSON.stringify({
						type: 'assistant.message',
						data: { content: "I'll run this end-to-end.", toolRequests: [] },
					}),
					JSON.stringify({
						type: 'assistant.message',
						data: { content: 'Final: I did the thing.', toolRequests: [] },
					}),
					JSON.stringify({ type: 'session.shutdown', data: { currentTokens: 42 } }),
				].join('\n') + '\n'
			);

			const prevConfigDir = process.env.COPILOT_CONFIG_DIR;
			process.env.COPILOT_CONFIG_DIR = configDir;

			try {
				const proc = createMockProcess({
					toolType: 'copilot-cli',
					isStreamJsonMode: true,
					isBatchMode: true,
					agentSessionId,
					streamedText: "I'll run this end-to-end.",
				});
				processes.set('test-session', proc);

				const dataEvents: string[] = [];
				const exitEvents: number[] = [];
				emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));
				emitter.on('exit', (_sid: string, code: number) => exitEvents.push(code));

				await exitHandler.handleExit('test-session', 0);

				expect(dataEvents).toContain('Final: I did the thing.');
				expect(dataEvents).not.toContain("I'll run this end-to-end.");
				expect(exitEvents).toEqual([0]);
				expect(processes.has('test-session')).toBe(false);
			} finally {
				if (prevConfigDir === undefined) {
					delete process.env.COPILOT_CONFIG_DIR;
				} else {
					process.env.COPILOT_CONFIG_DIR = prevConfigDir;
				}
				await fs.rm(configDir, { recursive: true, force: true });
			}
		});

		it('skips reconciliation when the SSH remote cannot be resolved (no leaking to local disk)', async () => {
			// The agent opted into SSH but the remote id no longer resolves. We must
			// NOT fall back to reading a local events.jsonl (which would never match);
			// the handler skips reconciliation and exits cleanly.
			vi.mocked(getSshRemoteById).mockReturnValue(null as never);

			const proc = createMockProcess({
				toolType: 'copilot-cli',
				isStreamJsonMode: true,
				isBatchMode: true,
				agentSessionId: 'cp-ssh-session',
				sshRemoteId: 'remote-1',
				streamedText: 'whatever the parent saw',
			});
			processes.set('test-session', proc);

			const exitEvents: number[] = [];
			emitter.on('exit', (_sid: string, code: number) => exitEvents.push(code));

			const start = Date.now();
			await exitHandler.handleExit('test-session', 0);
			const elapsed = Date.now() - start;

			expect(exitEvents).toEqual([0]);
			expect(elapsed).toBeLessThan(200); // no polling delay
			expect(readFileTailRemote).not.toHaveBeenCalled();
			expect(readFileRemote).not.toHaveBeenCalled();
		});

		it('reconciles over SSH when the remote resolves, overriding streamedText with the remote final answer', async () => {
			// The events file lives on the remote host; the readers must go over SSH.
			// Without this the remote context gauge stays stuck at 0% and the stale
			// parent narration is never replaced by the real final answer.
			vi.mocked(getSshRemoteById).mockReturnValue({
				id: 'remote-1',
				name: 'remote',
				host: 'remote.example',
				port: 22,
				username: 'pedram',
				privateKeyPath: '/tmp/key',
				enabled: true,
			} as never);

			// The waiter tails the remote file and sees the shutdown marker.
			vi.mocked(readFileTailRemote).mockResolvedValue({
				success: true,
				data:
					[
						JSON.stringify({ type: 'session.start', data: { sessionId: 'cp-ssh-session' } }),
						JSON.stringify({ type: 'session.shutdown', data: { currentTokens: 99 } }),
					].join('\n') + '\n',
			});
			// The final-answer / usage readers read the whole remote file.
			vi.mocked(readFileRemote).mockResolvedValue({
				success: true,
				data:
					[
						JSON.stringify({ type: 'session.start', data: { sessionId: 'cp-ssh-session' } }),
						JSON.stringify({
							type: 'assistant.message',
							data: { content: 'planning narration', toolRequests: [] },
						}),
						JSON.stringify({
							type: 'session.task_complete',
							data: { summary: 'Remote final answer.' },
						}),
						JSON.stringify({ type: 'session.shutdown', data: { currentTokens: 99 } }),
					].join('\n') + '\n',
			});

			const proc = createMockProcess({
				toolType: 'copilot-cli',
				isStreamJsonMode: true,
				isBatchMode: true,
				agentSessionId: 'cp-ssh-session',
				sshRemoteId: 'remote-1',
				streamedText: 'planning narration',
			});
			processes.set('test-session', proc);

			const dataEvents: string[] = [];
			const exitEvents: number[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));
			emitter.on('exit', (_sid: string, code: number) => exitEvents.push(code));

			await exitHandler.handleExit('test-session', 0);

			expect(readFileTailRemote).toHaveBeenCalled();
			expect(dataEvents).toContain('Remote final answer.');
			expect(exitEvents).toEqual([0]);
			expect(processes.has('test-session')).toBe(false);
		});

		it('skips the wait when agentSessionId was never observed (Copilot crashed before session.start)', async () => {
			const proc = createMockProcess({
				toolType: 'copilot-cli',
				isStreamJsonMode: true,
				isBatchMode: true,
				agentSessionId: undefined,
				streamedText: '',
			});
			processes.set('test-session', proc);

			const exitEvents: number[] = [];
			emitter.on('exit', (_sid: string, code: number) => exitEvents.push(code));

			const start = Date.now();
			await exitHandler.handleExit('test-session', 1);
			const elapsed = Date.now() - start;

			expect(exitEvents).toEqual([1]);
			expect(elapsed).toBeLessThan(200);
		});
	});

	describe('omp silent-exit hardening', () => {
		function ompProc(overrides: Partial<ManagedProcess> = {}): ManagedProcess {
			return createMockProcess({
				toolType: 'omp',
				isStreamJsonMode: true,
				outputParser: createMockOutputParser({ agentId: 'omp' }),
				resultEmitted: false,
				errorEmitted: false,
				streamedText: '',
				...overrides,
			});
		}

		it('surfaces a recoverable agent_crashed error when omp exits clean with no result, error, or output', async () => {
			processes.set('sess-ai-tab1', ompProc());

			const errors: Array<{ type: string; recoverable: boolean; message: string }> = [];
			const exitEvents: number[] = [];
			emitter.on('agent-error', (_sid: string, err) => errors.push(err));
			emitter.on('exit', (_sid: string, code: number) => exitEvents.push(code));

			await exitHandler.handleExit('sess-ai-tab1', 0);

			expect(errors).toHaveLength(1);
			expect(errors[0].type).toBe('agent_crashed');
			expect(errors[0].recoverable).toBe(true);
			expect(errors[0].message).toContain('without producing a response');
			// The exit event still fires so the tab leaves the busy state.
			expect(exitEvents).toEqual([0]);
		});

		it('does not fire when the user interrupted the turn (null signal coerced to code 0)', async () => {
			processes.set('sess-ai-tab1', ompProc({ interrupted: true }));

			const errors: unknown[] = [];
			emitter.on('agent-error', (_sid: string, err) => errors.push(err));

			await exitHandler.handleExit('sess-ai-tab1', 0);

			expect(errors).toHaveLength(0);
		});

		it('does not fire when omp streamed text that the exit fallback flushes as the result', async () => {
			processes.set('sess-ai-tab1', ompProc({ streamedText: 'here is my answer' }));

			const errors: unknown[] = [];
			const dataEvents: string[] = [];
			emitter.on('agent-error', (_sid: string, err) => errors.push(err));
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));

			await exitHandler.handleExit('sess-ai-tab1', 0);

			expect(errors).toHaveLength(0);
			expect(dataEvents).toContain('here is my answer');
		});

		it('does not fire for non-omp agents that exit clean with no output', async () => {
			processes.set('sess-ai-tab1', ompProc({ toolType: 'claude-code' }));

			const errors: unknown[] = [];
			emitter.on('agent-error', (_sid: string, err) => errors.push(err));

			await exitHandler.handleExit('sess-ai-tab1', 0);

			expect(errors).toHaveLength(0);
		});

		it('does not fire for background omp synopsis or tab-naming sessions', async () => {
			processes.set('sess-synopsis-123', ompProc());
			processes.set('tab-naming-abc', ompProc());

			const errors: unknown[] = [];
			emitter.on('agent-error', (_sid: string, err) => errors.push(err));

			await exitHandler.handleExit('sess-synopsis-123', 0);
			await exitHandler.handleExit('tab-naming-abc', 0);

			expect(errors).toHaveLength(0);
		});

		it('does not double-report when a non-zero exit already emitted an error', async () => {
			// detectErrorFromExit fires for non-zero codes; the guard must see
			// errorEmitted and stay quiet so only one error surfaces.
			const parser = createMockOutputParser({
				agentId: 'omp',
				detectErrorFromExit: vi.fn(() => ({
					type: 'agent_crashed',
					message: 'Oh My Pi exited with code 1',
					recoverable: true,
					agentId: 'omp',
					timestamp: Date.now(),
				})) as unknown as AgentOutputParser['detectErrorFromExit'],
			});
			processes.set('sess-ai-tab1', ompProc({ outputParser: parser }));

			const errors: Array<{ message: string }> = [];
			emitter.on('agent-error', (_sid: string, err) => errors.push(err));

			await exitHandler.handleExit('sess-ai-tab1', 1);

			expect(errors).toHaveLength(1);
			expect(errors[0].message).toContain('code 1');
		});
	});
});
