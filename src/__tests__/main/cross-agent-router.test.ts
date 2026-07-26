import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
	serializeTranscript,
	buildCrossAgentPrompt,
	startCrossAgentRequest,
	type CrossAgentTargetSession,
} from '../../main/cross-agent/cross-agent-router';
import type {
	CrossAgentRequest,
	CrossAgentResponseChunk,
	CrossAgentTranscriptEntry,
} from '../../shared/crossAgentTypes';
import { spawnGroupChatAgent } from '../../main/group-chat/spawnGroupChatAgent';

// The router's spawn + output-parse collaborators are mocked so these tests
// exercise the dispatch lifecycle (timers, settlement, spawn-failure) rather
// than the agent CLI. The parser is an identity fn: the buffer IS the answer.
vi.mock('../../main/group-chat/spawnGroupChatAgent', () => ({
	spawnGroupChatAgent: vi.fn(async () => ({ pid: 123, success: true })),
}));
vi.mock('../../main/group-chat/output-parser', () => ({
	extractTextFromStreamJson: vi.fn((raw: string) => raw),
}));
vi.mock('../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * Pure prompt-assembly tests for the cross-agent router. The dispatch itself
 * (spawn + stream) needs a live ProcessManager and is exercised end-to-end.
 */

const entry = (source: string, text?: string): CrossAgentTranscriptEntry => ({ source, text });

function request(overrides: Partial<CrossAgentRequest> = {}): CrossAgentRequest {
	return {
		requestId: 'r1',
		sourceSessionId: 'src',
		sourceTabId: 'tab',
		targetSessionId: 'tgt',
		userPrompt: 'What is your take?',
		transcript: [],
		strategy: { kind: 'full' },
		createdAt: 0,
		...overrides,
	};
}

describe('serializeTranscript', () => {
	it('labels user and assistant turns', () => {
		const out = serializeTranscript([entry('user', 'Hi'), entry('ai', 'Hello there')]);
		expect(out).toBe('**User:** Hi\n**Assistant:** Hello there');
	});

	it('drops entries with no visible text', () => {
		const out = serializeTranscript([
			entry('user', 'Question'),
			entry('ai', '   '),
			entry('ai', undefined),
			entry('tool'),
		]);
		expect(out).toBe('**User:** Question');
	});

	it('keeps tool/thinking entries only when they carry visible text', () => {
		const out = serializeTranscript([
			entry('thinking', 'pondering...'),
			entry('tool', 'ran a search'),
		]);
		expect(out).toContain('pondering...');
		expect(out).toContain('ran a search');
	});

	it('returns an empty string for an empty transcript', () => {
		expect(serializeTranscript([])).toBe('');
	});
});

describe('buildCrossAgentPrompt', () => {
	it('prepends the consult header, then transcript, then the relayed question', () => {
		const prompt = buildCrossAgentPrompt(
			request({
				transcript: [entry('user', 'Hi'), entry('ai', 'Yo')],
				userPrompt: 'Thoughts?',
			})
		);
		expect(prompt).toMatch(/^You are being consulted by another agent in Maestro\./);
		expect(prompt).toContain('**User:** Hi');
		expect(prompt).toContain('**Assistant:** Yo');
		expect(prompt).toContain(
			'**Question from the user (relayed via the source agent):**\nThoughts?'
		);
		// The header comes before the transcript, which comes before the question.
		expect(prompt.indexOf('consulted')).toBeLessThan(prompt.indexOf('**User:** Hi'));
		expect(prompt.indexOf('**Assistant:** Yo')).toBeLessThan(
			prompt.indexOf('Question from the user')
		);
	});

	it('omits the transcript block entirely when there is nothing to forward', () => {
		const prompt = buildCrossAgentPrompt(request({ transcript: [], userPrompt: 'Just this' }));
		expect(prompt).toContain('You are being consulted');
		expect(prompt).toContain('Just this');
		// No stray blank transcript section: header flows straight into the question.
		expect(prompt).not.toContain('**User:**');
	});

	it('grants read access to the source cwd when forwarded, before the question', () => {
		const prompt = buildCrossAgentPrompt(
			request({ sourceCwd: '/Users/me/proj', userPrompt: 'Look at the config' })
		);
		expect(prompt).toContain('`/Users/me/proj`');
		expect(prompt).toContain('permission to READ');
		expect(prompt).toContain('Do NOT modify or create files');
		// The grant rides with the header, ahead of the relayed question.
		expect(prompt.indexOf('/Users/me/proj')).toBeLessThan(prompt.indexOf('Look at the config'));
	});

	it('omits the cwd grant entirely when no source cwd is forwarded', () => {
		const prompt = buildCrossAgentPrompt(request({ sourceCwd: undefined }));
		expect(prompt).not.toContain('permission to READ');
	});

	it('tells the target how to lift the read-only restriction when read-only', () => {
		const prompt = buildCrossAgentPrompt(
			request({ sourceCwd: '/Users/me/proj', userPrompt: 'Fix the bug' })
		);
		expect(prompt).toContain('Settings > General > Cross-Agent Mentions');
	});

	it('grants write access and drops the prohibition when writable is opted into', () => {
		const prompt = buildCrossAgentPrompt(
			request({ sourceCwd: '/Users/me/proj', userPrompt: 'Fix the bug' }),
			true
		);
		expect(prompt).toContain('permission to READ and MODIFY');
		expect(prompt).not.toContain('Do NOT modify or create files');
		expect(prompt).not.toContain('Settings > General > Cross-Agent Mentions');
	});
});

const IDLE_MS = 10 * 60 * 1000;
const HARD_MS = 30 * 60 * 1000;

/** Minimal ProcessManager stand-in: the router only uses on/off/kill. */
class FakeProcessManager extends EventEmitter {
	kill = vi.fn();
}

const targetSession = (): CrossAgentTargetSession => ({
	id: 'tgt',
	name: 'Maestro Marketing',
	toolType: 'claude-code',
	cwd: '/proj',
});

function harness(
	overrides: {
		getTargetSession?: () => CrossAgentTargetSession | null;
		writable?: boolean;
	} = {}
) {
	const processManager = new FakeProcessManager();
	const chunks: CrossAgentResponseChunk[] = [];
	const dispatch = () =>
		startCrossAgentRequest(request(), {
			processManager: processManager as never,
			agentDetector: {
				getAgent: async () => ({
					id: 'claude-code',
					name: 'Claude Code',
					command: 'claude',
					path: 'claude',
					args: [],
					available: true,
				}),
			} as never,
			sshStore: null,
			getTargetSession: overrides.getTargetSession ?? targetSession,
			writable: overrides.writable,
			onChunk: (c) => chunks.push(c),
		});
	// The router keys its listeners on `cross-agent-<requestId>`; request() uses 'r1'.
	const emitData = (text: string) => processManager.emit('data', 'cross-agent-r1', text);
	const emitExit = (code: number) => processManager.emit('exit', 'cross-agent-r1', code);
	return { processManager, chunks, dispatch, emitData, emitExit };
}

describe('startCrossAgentRequest dispatch lifecycle', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.mocked(spawnGroupChatAgent).mockResolvedValue({ pid: 123, success: true });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('spawns the consult read-only and caps maestro-p idle wait to the idle budget', async () => {
		const { dispatch } = harness();
		await dispatch();

		const config = vi.mocked(spawnGroupChatAgent).mock.calls[0][0];
		// The consult prompt promises the target it will not write; the spawn is what
		// actually enforces it.
		expect(config.readOnlyMode).toBe(true);
		expect(config.maxWaitSeconds).toBe(IDLE_MS / 1000);
	});

	it('spawns the consult read/write when the user opted into writable mentions', async () => {
		const { dispatch } = harness({ writable: true });
		await dispatch();

		const config = vi.mocked(spawnGroupChatAgent).mock.calls[0][0];
		expect(config.readOnlyMode).toBe(false);
	});

	it('does not kill a target that keeps streaming past the idle budget', async () => {
		const { chunks, dispatch, emitData } = harness();
		await dispatch();

		// Nine minutes of silence, a byte of output, then nine more: a wall-clock
		// budget would have fired by now. The idle budget must not.
		vi.advanceTimersByTime(IDLE_MS - 60_000);
		emitData('still working');
		vi.advanceTimersByTime(IDLE_MS - 60_000);

		expect(chunks).toHaveLength(0);
	});

	it('kills the target and flushes partial output once it goes silent', async () => {
		const { chunks, dispatch, emitData, processManager } = harness();
		await dispatch();

		emitData('half an answer');
		vi.advanceTimersByTime(IDLE_MS);

		expect(processManager.kill).toHaveBeenCalledWith('cross-agent-r1');
		expect(chunks).toHaveLength(1);
		// The work the target DID do survives; it is stamped as a failure, not dropped.
		expect(chunks[0].chunk).toBe('half an answer');
		expect(chunks[0].done).toBe(true);
		expect(chunks[0].error).toContain('went silent');
		// A killed run must not seed a resume id for the next consult.
		expect(chunks[0].targetAgentSessionId).toBeUndefined();
	});

	it('stops a chattering target at the hard ceiling even though it never idles', async () => {
		const { chunks, dispatch, emitData } = harness();
		await dispatch();

		// Output every five minutes forever: the idle timer never fires.
		for (let elapsed = 0; elapsed < HARD_MS; elapsed += 5 * 60 * 1000) {
			vi.advanceTimersByTime(5 * 60 * 1000);
			emitData('.');
		}

		expect(chunks).toHaveLength(1);
		expect(chunks[0].error).toContain('exceeded the 30-minute limit');
	});

	it('settles once: a timeout after exit does not emit a second chunk', async () => {
		const { chunks, dispatch, emitData, emitExit } = harness();
		await dispatch();

		emitData('the answer');
		emitExit(0);
		vi.advanceTimersByTime(HARD_MS * 2);

		expect(chunks).toHaveLength(1);
		expect(chunks[0].error).toBeUndefined();
		expect(chunks[0].chunk).toBe('the answer');
	});

	it('fails fast when the spawner reports failure instead of throwing', async () => {
		vi.mocked(spawnGroupChatAgent).mockResolvedValue({ pid: -1, success: false });
		const { chunks, dispatch } = harness();
		await dispatch();

		// A spawner that returns `success: false` emits no 'exit' event. Without an
		// explicit check the user waits out the full budget for a process that never
		// existed, so the error must land immediately - before any timer advances.
		expect(chunks).toHaveLength(1);
		expect(chunks[0].done).toBe(true);
		expect(chunks[0].error).toContain('could not be started');
	});

	it('stops the timers when the spawn fails, so no late chunk follows', async () => {
		vi.mocked(spawnGroupChatAgent).mockResolvedValue({ pid: -1, success: false });
		const { chunks, dispatch } = harness();
		await dispatch();

		vi.advanceTimersByTime(HARD_MS * 2);
		expect(chunks).toHaveLength(1);
	});
});
