import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	FeedbackConversationManager,
	getConfidenceColor,
	FEEDBACK_CONFIDENCE_THRESHOLD,
	type FeedbackParsedResponse,
} from '../../../renderer/services/feedbackConversation';
import type { ToolType } from '../../../renderer/types';

type DataHandler = (sessionId: string, data: string) => void;
type ExitHandler = (sessionId: string, code: number) => void;
type ThinkingHandler = (sessionId: string, content: string) => void;

let dataHandler: DataHandler;
let exitHandler: ExitHandler;
let thinkingHandler: ThinkingHandler;
const dataCleanup = vi.fn();
const exitCleanup = vi.fn();
const thinkingCleanup = vi.fn();

const baseAgent = {
	id: 'claude-code',
	name: 'Claude Code',
	available: true,
	command: 'claude',
	args: [],
	capabilities: { supportsStreamJsonInput: true },
};

function validResponse(overrides: Partial<FeedbackParsedResponse> = {}) {
	return {
		confidence: 88,
		ready: true,
		message: 'Thanks, I have enough detail.',
		category: 'bug_report',
		summary: 'Terminal freezes',
		structured: {
			expectedBehavior: 'Terminal should stream',
			actualBehavior: 'Terminal freezes',
			reproductionSteps: 'Run a long command',
			additionalContext: 'Started after update',
		},
		...overrides,
	};
}

function mockAgent(overrides: Record<string, unknown> = {}) {
	window.maestro.agents.get = vi.fn(async () => ({
		...baseAgent,
		...overrides,
	}));
}

function startManager(agentType: ToolType = 'claude-code') {
	const manager = new FeedbackConversationManager();
	const sessionId = manager.start({
		agentType,
		systemPrompt: 'Collect feedback as JSON.',
	});
	return { manager, sessionId };
}

async function sendAndFlush(manager: FeedbackConversationManager) {
	const onChunk = vi.fn();
	const onThinkingChunk = vi.fn();
	const onComplete = vi.fn();
	const onError = vi.fn();
	const promise = manager.sendMessage(
		'Terminal freezes',
		[
			{ role: 'system', content: 'ignored system', timestamp: 1 },
			{ role: 'user', content: 'Earlier user note', timestamp: 2 },
			{ role: 'assistant', content: 'Earlier assistant reply', timestamp: 3 },
		],
		{ onChunk, onThinkingChunk, onComplete, onError }
	);
	await vi.waitFor(() => {
		expect(window.maestro.process.spawn).toHaveBeenCalled();
	});
	return { promise, onChunk, onThinkingChunk, onComplete, onError };
}

describe('FeedbackConversationManager', () => {
	beforeEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		dataCleanup.mockReset();
		exitCleanup.mockReset();
		thinkingCleanup.mockReset();
		dataHandler = vi.fn();
		exitHandler = vi.fn();
		thinkingHandler = vi.fn();
		mockAgent();
		window.maestro.process.spawn = vi.fn();
		window.maestro.process.kill = vi.fn();
		(window.maestro.process as any).onData = vi.fn((handler: DataHandler) => {
			dataHandler = handler;
			return dataCleanup;
		});
		window.maestro.process.onExit = vi.fn((handler: ExitHandler) => {
			exitHandler = handler;
			return exitCleanup;
		});
		(window.maestro.process as any).onThinkingChunk = vi.fn((handler: ThinkingHandler) => {
			thinkingHandler = handler;
			return thinkingCleanup;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('starts sessions, sends prompts with history, and parses direct JSON responses', async () => {
		const { manager, sessionId } = startManager();
		const { promise, onChunk, onThinkingChunk, onComplete } = await sendAndFlush(manager);

		dataHandler('other-session', 'ignored');
		thinkingHandler('other-session', 'ignored thinking');
		thinkingHandler(sessionId, '');
		thinkingHandler(sessionId, 'reasoning');
		dataHandler(sessionId, JSON.stringify(validResponse()));
		exitHandler('other-session', 0);
		exitHandler(sessionId, 0);

		const response = await promise;
		expect(response).toMatchObject(validResponse());
		expect(onChunk).toHaveBeenCalledWith(expect.stringContaining('"confidence"'));
		expect(onThinkingChunk).toHaveBeenCalledWith('reasoning');
		expect(onComplete).toHaveBeenCalledWith(response);
		expect(dataCleanup).toHaveBeenCalled();
		expect(exitCleanup).toHaveBeenCalled();
		expect(thinkingCleanup).toHaveBeenCalled();
		expect(window.maestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId,
				toolType: 'claude-code',
				command: 'claude',
				args: ['--output-format', 'stream-json', '--include-partial-messages'],
				prompt: expect.stringContaining('User: Earlier user note'),
			})
		);
		expect(manager.isActive).toBe(true);
	});

	it('normalizes code-block JSON responses', async () => {
		const { manager, sessionId } = startManager();
		const { promise } = await sendAndFlush(manager);
		const longSummary = 'x'.repeat(160);

		dataHandler(
			sessionId,
			[
				'```json',
				JSON.stringify({
					confidence: 120.4,
					ready: true,
					message: 'Ready from code block',
					category: 'unknown',
					summary: longSummary,
					structured: { expectedBehavior: 'Expected' },
				}),
				'```',
			].join('\n')
		);
		exitHandler(sessionId, 0);

		const response = await promise;
		expect(response.confidence).toBe(100);
		expect(response.ready).toBe(true);
		expect(response.category).toBe('general_feedback');
		expect(response.summary).toHaveLength(120);
		expect(response.structured.expectedBehavior).toBe('Expected');
		expect(response.structured.actualBehavior).toBe('');
	});

	it('falls through invalid JSON candidates and defaults optional response fields', async () => {
		let started = startManager();
		let sent = await sendAndFlush(started.manager);
		dataHandler(
			started.sessionId,
			['```json', '{"confidence":"bad","message":"Bad"}', '```'].join('\n')
		);
		exitHandler(started.sessionId, 0);
		await expect(sent.promise).resolves.toMatchObject({ confidence: 20, ready: false });

		started = startManager();
		sent = await sendAndFlush(started.manager);
		dataHandler(
			started.sessionId,
			JSON.stringify({
				confidence: 80,
				ready: true,
				message: '',
				category: 'improvement',
			})
		);
		exitHandler(started.sessionId, 0);
		await expect(sent.promise).resolves.toMatchObject({
			confidence: 80,
			ready: true,
			message: '',
			category: 'improvement',
			summary: '',
			structured: {
				expectedBehavior: '',
				actualBehavior: '',
				reproductionSteps: '',
				additionalContext: '',
			},
		});
	});

	it('parses embedded JSON objects and stream-json assistant chunks', async () => {
		let started = startManager();
		let sent = await sendAndFlush(started.manager);
		dataHandler(
			started.sessionId,
			`prefix ${JSON.stringify(validResponse({ confidence: 41, ready: false, message: 'Embedded' }))} suffix`
		);
		exitHandler(started.sessionId, 0);
		await expect(sent.promise).resolves.toMatchObject({ confidence: 41, message: 'Embedded' });

		started = startManager();
		sent = await sendAndFlush(started.manager);
		const streamedJson = JSON.stringify(validResponse({ message: 'Streamed' }));
		dataHandler(
			started.sessionId,
			`{"type":"assistant","content":${JSON.stringify(streamedJson)}}`
		);
		exitHandler(started.sessionId, 0);
		await expect(sent.promise).resolves.toMatchObject({ message: 'Streamed' });
	});

	it('falls back for malformed or low-confidence responses and non-zero exits', async () => {
		let started = startManager();
		let sent = await sendAndFlush(started.manager);
		dataHandler(started.sessionId, '{"not":"feedback"}');
		exitHandler(started.sessionId, 0);
		await expect(sent.promise).resolves.toMatchObject({
			confidence: 20,
			ready: false,
			message: "I didn't quite catch that. Could you describe the issue or idea again?",
		});

		started = startManager();
		sent = await sendAndFlush(started.manager);
		dataHandler(
			started.sessionId,
			JSON.stringify(validResponse({ confidence: 79, ready: true, message: 'Almost ready' }))
		);
		exitHandler(started.sessionId, 0);
		await expect(sent.promise).resolves.toMatchObject({ confidence: 79, ready: false });

		started = startManager();
		sent = await sendAndFlush(started.manager);
		exitHandler(started.sessionId, 7);
		await expect(sent.promise).resolves.toMatchObject({
			message: 'Something went wrong processing your message. Please try again.',
		});
		expect(sent.onError).toHaveBeenCalledWith('Agent exited with code 7');
	});

	it('rejects invalid agent states and allows unavailable remote agents', async () => {
		const manager = new FeedbackConversationManager();
		await expect(manager.sendMessage('hi', [])).rejects.toThrow('No active feedback conversation');

		manager.start({ agentType: 'claude-code', systemPrompt: 'system' });
		window.maestro.agents.get = vi.fn(async () => null);
		await expect(manager.sendMessage('hi', [])).rejects.toThrow('Agent claude-code not found');

		manager.start({ agentType: 'claude-code', systemPrompt: 'system' });
		mockAgent({ available: false });
		await expect(manager.sendMessage('hi', [])).rejects.toThrow(
			'Agent claude-code is not available'
		);

		manager.start({
			agentType: 'claude-code',
			systemPrompt: 'system',
			sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		mockAgent({ available: false });
		const promise = manager.sendMessage('hi', []);
		await vi.waitFor(() => {
			expect(window.maestro.process.spawn).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: expect.any(String) })
			);
		});
		exitHandler((window.maestro.process.spawn as any).mock.calls.at(-1)[0].sessionId, 0);
		await expect(promise).resolves.toMatchObject({ confidence: 20 });
	});

	it('resolves with a timeout response after inactivity', async () => {
		vi.useFakeTimers();
		const { manager } = startManager();
		const promise = manager.sendMessage('hi', []);
		await vi.waitFor(() => {
			expect(window.maestro.process.spawn).toHaveBeenCalled();
		});

		await vi.advanceTimersByTimeAsync(600000);
		await expect(promise).resolves.toMatchObject({
			message: 'The agent took too long to respond. Please try again.',
		});
		expect(dataCleanup).toHaveBeenCalled();
		expect(exitCleanup).toHaveBeenCalled();
	});

	it('builds agent-specific arguments', async () => {
		const cases: Array<{ toolType: ToolType; agent: Record<string, unknown>; args: string[] }> = [
			{
				toolType: 'claude-code',
				agent: { id: 'claude-code', args: undefined },
				args: ['--output-format', 'stream-json', '--include-partial-messages'],
			},
			{
				toolType: 'claude-code',
				agent: {
					id: 'claude-code',
					args: ['--output-format', 'stream-json', '--include-partial-messages'],
				},
				args: ['--output-format', 'stream-json', '--include-partial-messages'],
			},
			{
				toolType: 'codex',
				agent: {
					id: 'codex',
					command: 'codex',
					args: ['exec'],
					batchModeArgs: ['--batch'],
					jsonOutputArgs: ['--json'],
				},
				args: ['exec', '--batch', '--json'],
			},
			{
				toolType: 'codex',
				agent: { id: 'codex', command: 'codex', args: undefined },
				args: [],
			},
			{
				toolType: 'opencode',
				agent: { id: 'opencode', command: 'opencode', args: ['run'], jsonOutputArgs: ['--json'] },
				args: ['run', '--json'],
			},
			{
				toolType: 'opencode',
				agent: { id: 'opencode', command: 'opencode', args: undefined },
				args: [],
			},
			{
				toolType: 'terminal',
				agent: { id: 'terminal', command: 'sh', args: ['-lc'] },
				args: ['-lc'],
			},
			{
				toolType: 'terminal',
				agent: { id: undefined, command: 'sh', args: undefined },
				args: [],
			},
		];

		for (const testCase of cases) {
			mockAgent(testCase.agent);
			const { manager, sessionId } = startManager(testCase.toolType);
			const promise = manager.sendMessage('hi', []);
			await vi.waitFor(() => {
				expect(window.maestro.process.spawn).toHaveBeenCalledWith(
					expect.objectContaining({ sessionId, args: testCase.args })
				);
			});
			exitHandler(sessionId, 0);
			await promise;
		}
	});

	it('cleans up active sessions and ignores kill failures', () => {
		const manager = new FeedbackConversationManager();
		const firstSessionId = manager.start({ agentType: 'claude-code', systemPrompt: 'system' });
		expect(manager.isActive).toBe(true);

		manager.start({ agentType: 'claude-code', systemPrompt: 'system again' });
		expect(window.maestro.process.kill).toHaveBeenCalledWith(firstSessionId);

		window.maestro.process.kill = vi.fn(() => {
			throw new Error('already dead');
		});
		manager.cleanup();
		expect(manager.isActive).toBe(false);
	});
});

describe('getConfidenceColor', () => {
	it('maps confidence values to red, orange, and green hues', () => {
		expect(FEEDBACK_CONFIDENCE_THRESHOLD).toBe(80);
		expect(getConfidenceColor(100)).toBe('hsl(120, 80%, 45%)');
		expect(getConfidenceColor(60)).toBe('hsl(45, 80%, 45%)');
		expect(getConfidenceColor(20)).toBe('hsl(15, 80%, 45%)');
	});
});
