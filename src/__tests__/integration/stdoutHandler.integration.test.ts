import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StdoutHandler } from '../../main/process-manager/handlers/StdoutHandler';
import type { AgentError, ManagedProcess } from '../../main/process-manager/types';

const state = vi.hoisted(() => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: state.logger,
}));

function createManagedProcess(overrides: Partial<ManagedProcess> = {}): ManagedProcess {
	return {
		sessionId: 'session-1',
		toolType: 'claude-code',
		cwd: '/repo',
		pid: 1234,
		isTerminal: false,
		startTime: Date.now(),
		isStreamJsonMode: false,
		isBatchMode: false,
		jsonBuffer: '',
		stdoutBuffer: '',
		contextWindow: 200000,
		sessionIdEmitted: false,
		resultEmitted: false,
		errorEmitted: false,
		streamedText: '',
		...overrides,
	} as ManagedProcess;
}

function createParser(overrides: Record<string, unknown> = {}) {
	return {
		agentId: 'claude-code',
		parseJsonLine: vi.fn(),
		parseJsonObject: vi.fn((parsed: unknown) => parsed),
		extractUsage: vi.fn((event: any) => event.usage ?? null),
		extractSessionId: vi.fn((event: any) => event.sessionId ?? null),
		extractSlashCommands: vi.fn((event: any) => event.slashCommands ?? null),
		isResultMessage: vi.fn((event: any) => event.type === 'result'),
		detectErrorFromLine: vi.fn(() => null),
		detectErrorFromParsed: vi.fn(() => null),
		...overrides,
	};
}

function createHarness(processOverrides: Partial<ManagedProcess> = {}) {
	const emitter = new EventEmitter();
	const bufferManager = {
		emitDataBuffered: vi.fn(),
		flushDataBuffer: vi.fn(),
	};
	const process = createManagedProcess(processOverrides);
	const processes = new Map([[process.sessionId, process]]);
	const handler = new StdoutHandler({
		processes,
		emitter,
		bufferManager: bufferManager as never,
	});

	return { bufferManager, emitter, handler, process, sessionId: process.sessionId };
}

function sendJsonLine(handler: StdoutHandler, sessionId: string, value: Record<string, unknown>) {
	handler.handleData(sessionId, `${JSON.stringify(value)}\n`);
}

describe('StdoutHandler integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('routes plain, batch, and stream output through real buffering and ANSI stripping', () => {
		const plain = createHarness();
		plain.handler.handleData('missing-session', 'ignored');
		plain.handler.handleData(plain.sessionId, '\x1b[31m\x1b[0m');
		plain.handler.handleData(plain.sessionId, '\x1b[?1h\x1b=Hello from stdout');
		expect(plain.bufferManager.emitDataBuffered).toHaveBeenCalledTimes(1);
		expect(plain.bufferManager.emitDataBuffered).toHaveBeenCalledWith(
			plain.sessionId,
			'Hello from stdout'
		);

		const batch = createHarness({ isBatchMode: true });
		batch.handler.handleData(batch.sessionId, '{"partial":');
		batch.handler.handleData(batch.sessionId, '"json"}');
		expect(batch.process.jsonBuffer).toBe('{"partial":"json"}');
		expect(batch.bufferManager.emitDataBuffered).not.toHaveBeenCalled();

		const stream = createHarness({ isStreamJsonMode: true });
		stream.handler.handleData(stream.sessionId, '{"incomplete":');
		expect(stream.process.jsonBuffer).toBe('{"incomplete":');
		stream.handler.handleData(stream.sessionId, '"line"}\n\nplain text\n');
		expect(stream.process.stdoutBuffer).toContain('{"incomplete":"line"}\n');
		expect(stream.bufferManager.emitDataBuffered).toHaveBeenCalledWith(
			stream.sessionId,
			'plain text'
		);
	});

	it('emits parser-detected and SSH-detected agent errors before normal buffering', () => {
		const agentError: AgentError = {
			type: 'auth_expired',
			message: 'Claude authentication expired',
			recoverable: true,
			agentId: 'claude-code',
			timestamp: 1,
		};
		const parser = createParser({
			detectErrorFromParsed: vi.fn(() => agentError),
		});
		const parsedError = createHarness({
			isStreamJsonMode: true,
			outputParser: parser as never,
			sshRemoteId: 'remote-1',
			sshRemoteHost: 'build-box',
		});
		const parsedErrorSpy = vi.fn();
		parsedError.emitter.on('agent-error', parsedErrorSpy);

		sendJsonLine(parsedError.handler, parsedError.sessionId, { type: 'error' });

		expect(parsedError.process.errorEmitted).toBe(true);
		expect(agentError.sessionId).toBe(parsedError.sessionId);
		expect(agentError.message).toContain('Authentication failed on remote host "build-box"');
		expect(parsedErrorSpy).toHaveBeenCalledWith(parsedError.sessionId, agentError);

		const sshError = createHarness({
			isStreamJsonMode: true,
			sshRemoteId: 'remote-1',
			toolType: 'codex',
		});
		const sshErrorSpy = vi.fn();
		sshError.emitter.on('agent-error', sshErrorSpy);

		sshError.handler.handleData(sshError.sessionId, 'ssh: Could not resolve hostname example\n');

		expect(sshError.process.errorEmitted).toBe(true);
		expect(sshErrorSpy).toHaveBeenCalledWith(
			sshError.sessionId,
			expect.objectContaining({
				type: 'network_error',
				message: 'SSH could not resolve hostname. Check the remote host address.',
				recoverable: false,
				agentId: 'codex',
				raw: { errorLine: 'ssh: Could not resolve hostname example' },
			})
		);
		expect(sshError.bufferManager.emitDataBuffered).not.toHaveBeenCalled();
	});

	it('emits parser events for usage, session IDs, slash commands, thinking chunks, and tools', () => {
		const parser = createParser();
		const { bufferManager, emitter, handler, process, sessionId } = createHarness({
			isStreamJsonMode: true,
			toolType: 'codex',
			outputParser: parser as never,
		});
		const usageSpy = vi.fn();
		const sessionSpy = vi.fn();
		const slashSpy = vi.fn();
		const thinkingSpy = vi.fn();
		const toolSpy = vi.fn();
		emitter.on('usage', usageSpy);
		emitter.on('session-id', sessionSpy);
		emitter.on('slash-commands', slashSpy);
		emitter.on('thinking-chunk', thinkingSpy);
		emitter.on('tool-execution', toolSpy);

		sendJsonLine(handler, sessionId, {
			type: 'usage',
			sessionId: 'agent-session-1',
			slashCommands: ['/help', '/compact'],
			usage: {
				inputTokens: 100,
				outputTokens: 40,
				cacheReadTokens: 10,
				cacheCreationTokens: 5,
				costUsd: 0.25,
				contextWindow: 300000,
				reasoningTokens: 12,
			},
		});
		sendJsonLine(handler, sessionId, {
			type: 'usage',
			sessionId: 'agent-session-2',
			usage: {
				inputTokens: 160,
				outputTokens: 55,
				cacheReadTokens: 20,
				cacheCreationTokens: 8,
				costUsd: 0.5,
				contextWindow: 300000,
				reasoningTokens: 20,
			},
		});
		sendJsonLine(handler, sessionId, { type: 'text', isPartial: true, text: 'thinking...' });
		sendJsonLine(handler, sessionId, {
			type: 'tool_use',
			toolName: 'Read',
			toolState: { status: 'running' },
		});
		sendJsonLine(handler, sessionId, {
			type: 'text',
			toolUseBlocks: [{ name: 'Write', input: { file_path: 'notes.md' } }],
		});
		sendJsonLine(handler, sessionId, { type: 'result', text: 'intermediate result' });
		sendJsonLine(handler, sessionId, {
			type: 'usage',
			usage: {
				inputTokens: 170,
				outputTokens: 70,
				contextWindow: 300000,
			},
		});

		expect(usageSpy).toHaveBeenNthCalledWith(
			1,
			sessionId,
			expect.objectContaining({
				inputTokens: 100,
				outputTokens: 40,
				cacheReadInputTokens: 10,
				cacheCreationInputTokens: 5,
				reasoningTokens: 12,
				contextWindow: 300000,
			})
		);
		expect(usageSpy).toHaveBeenNthCalledWith(
			2,
			sessionId,
			expect.objectContaining({
				inputTokens: 60,
				outputTokens: 15,
				cacheReadInputTokens: 10,
				cacheCreationInputTokens: 3,
				reasoningTokens: 8,
			})
		);
		expect(sessionSpy).toHaveBeenCalledTimes(1);
		expect(sessionSpy).toHaveBeenCalledWith(sessionId, 'agent-session-1');
		expect(slashSpy).toHaveBeenCalledWith(sessionId, ['/help', '/compact']);
		expect(thinkingSpy).toHaveBeenCalledWith(sessionId, 'thinking...');
		expect(toolSpy).toHaveBeenCalledWith(
			sessionId,
			expect.objectContaining({ toolName: 'Read', state: { status: 'running' } })
		);
		expect(toolSpy).toHaveBeenCalledWith(
			sessionId,
			expect.objectContaining({
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'notes.md' } },
			})
		);
		expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith(sessionId, 'intermediate result');
		expect(process.resultEmitted).toBe(true);
	});

	it('handles OpenCode step resets and non-Codex parser result fallbacks', () => {
		const parser = createParser();
		const { bufferManager, handler, process, sessionId } = createHarness({
			isStreamJsonMode: true,
			toolType: 'opencode',
			outputParser: parser as never,
			resultEmitted: true,
			streamedText: 'old text',
		});

		sendJsonLine(handler, sessionId, { type: 'init' });
		expect(process.resultEmitted).toBe(false);
		expect(process.streamedText).toBe('');

		sendJsonLine(handler, sessionId, { type: 'text', isPartial: true, text: 'partial answer' });
		sendJsonLine(handler, sessionId, { type: 'result' });

		expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith(sessionId, 'partial answer');
		expect(process.resultEmitted).toBe(true);
	});

	it('handles null parser events, parser error events, and synopsis diagnostics', () => {
		const nullParser = createParser({
			parseJsonObject: vi.fn(() => null),
		});
		const nullEvent = createHarness({
			isStreamJsonMode: true,
			outputParser: nullParser as never,
		});
		sendJsonLine(nullEvent.handler, nullEvent.sessionId, { type: 'unknown' });
		expect(nullEvent.bufferManager.emitDataBuffered).not.toHaveBeenCalled();

		const errorEvent = createHarness({
			isStreamJsonMode: true,
			outputParser: createParser() as never,
		});
		sendJsonLine(errorEvent.handler, errorEvent.sessionId, {
			type: 'error',
			text: 'handled elsewhere',
		});
		expect(errorEvent.bufferManager.emitDataBuffered).not.toHaveBeenCalled();

		const synopsis = createHarness({
			isStreamJsonMode: true,
			outputParser: createParser() as never,
			sessionId: 'run-synopsis-1',
			streamedText: 'streamed synopsis',
		});
		sendJsonLine(synopsis.handler, synopsis.sessionId, { type: 'result' });
		expect(synopsis.bufferManager.emitDataBuffered).toHaveBeenCalledWith(
			synopsis.sessionId,
			'streamed synopsis'
		);
		expect(state.logger.info).toHaveBeenCalledWith(
			'[ProcessManager] Synopsis result processing',
			'ProcessManager',
			expect.objectContaining({ sessionId: synopsis.sessionId })
		);

		const emptySynopsis = createHarness({
			isStreamJsonMode: true,
			outputParser: createParser() as never,
			sessionId: 'empty-synopsis-1',
			streamedText: '',
		});
		sendJsonLine(emptySynopsis.handler, emptySynopsis.sessionId, { type: 'result' });
		expect(emptySynopsis.bufferManager.emitDataBuffered).not.toHaveBeenCalled();
		expect(state.logger.warn).toHaveBeenCalledWith(
			'[ProcessManager] Synopsis result is empty - no text to emit',
			'ProcessManager',
			expect.objectContaining({ sessionId: emptySynopsis.sessionId })
		);
	});

	it('handles legacy stream JSON result, session, slash-command, error, and usage messages', () => {
		const { bufferManager, emitter, handler, process, sessionId } = createHarness({
			isStreamJsonMode: true,
		});
		const sessionSpy = vi.fn();
		const slashSpy = vi.fn();
		const usageSpy = vi.fn();
		emitter.on('session-id', sessionSpy);
		emitter.on('slash-commands', slashSpy);
		emitter.on('usage', usageSpy);

		sendJsonLine(handler, sessionId, { type: 'error', error: 'handled elsewhere' });
		sendJsonLine(handler, sessionId, { type: 'result', result: 'Final answer' });
		sendJsonLine(handler, sessionId, { type: 'result', result: 'Duplicate answer' });
		sendJsonLine(handler, sessionId, { session_id: 'agent-session-legacy' });
		sendJsonLine(handler, sessionId, { session_id: 'ignored-second-session' });
		sendJsonLine(handler, sessionId, {
			type: 'system',
			subtype: 'init',
			slash_commands: ['/status'],
		});
		sendJsonLine(handler, sessionId, {
			usage: { input_tokens: 12, output_tokens: 3 },
			total_cost_usd: 0.04,
		});

		expect(bufferManager.emitDataBuffered).toHaveBeenCalledTimes(1);
		expect(bufferManager.emitDataBuffered).toHaveBeenCalledWith(sessionId, 'Final answer');
		expect(process.resultEmitted).toBe(true);
		expect(sessionSpy).toHaveBeenCalledTimes(1);
		expect(sessionSpy).toHaveBeenCalledWith(sessionId, 'agent-session-legacy');
		expect(slashSpy).toHaveBeenCalledWith(sessionId, ['/status']);
		expect(usageSpy).toHaveBeenCalledWith(
			sessionId,
			expect.objectContaining({
				totalCostUsd: 0.04,
				contextWindow: expect.any(Number),
			})
		);
	});

	it('switches usage normalization to raw values when cumulative totals decrease', () => {
		const parser = createParser();
		const { emitter, handler, process, sessionId } = createHarness({
			isStreamJsonMode: true,
			toolType: 'claude-code',
			outputParser: parser as never,
		});
		const usageSpy = vi.fn();
		emitter.on('usage', usageSpy);

		sendJsonLine(handler, sessionId, {
			type: 'usage',
			usage: { inputTokens: 80, outputTokens: 20, reasoningTokens: 10 },
		});
		sendJsonLine(handler, sessionId, {
			type: 'usage',
			usage: { inputTokens: 60, outputTokens: 15, reasoningTokens: 5 },
		});
		sendJsonLine(handler, sessionId, {
			type: 'usage',
			usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 1 },
		});

		expect(process.usageIsCumulative).toBe(false);
		expect(usageSpy).toHaveBeenNthCalledWith(
			2,
			sessionId,
			expect.objectContaining({ inputTokens: 60, outputTokens: 15, reasoningTokens: 5 })
		);
		expect(usageSpy).toHaveBeenNthCalledWith(
			3,
			sessionId,
			expect.objectContaining({ inputTokens: 10, outputTokens: 5, reasoningTokens: 1 })
		);
	});
});
