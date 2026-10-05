import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
	startCrossAgentRequest,
	cancelCrossAgentRequestsForSource,
	CROSS_AGENT_SESSION_PREFIX,
	buildCrossAgentPrompt,
	serializeTranscript,
	type CrossAgentTargetSession,
} from '../../main/cross-agent/cross-agent-router';
import type { CrossAgentRequest, CrossAgentResponseChunk } from '../../shared/crossAgentTypes';
import { spawnGroupChatAgent } from '../../main/group-chat/spawnGroupChatAgent';

/**
 * The desktop's binding of the consult service: the dispatch rules themselves (prompt, budgets,
 * completion, Stop) are tested over a fake runner in
 * `src/shared/maestro-lib/agents/__tests__/consult.test.ts`. What is left to prove here is what is
 * the desktop's own: the `ProcessManager` listeners the runner attaches, that they are filtered to
 * the consult's process id, and that every one of them is removed again.
 */

// The spawn collaborator is mocked so these tests exercise the listener lifecycle rather than the
// agent CLI. The parser is an identity fn: the buffer IS the answer.
vi.mock('../../main/group-chat/spawnGroupChatAgent', () => ({
	spawnGroupChatAgent: vi.fn(async () => ({ pid: 123, success: true })),
}));
vi.mock('../../main/group-chat/output-parser', () => ({
	extractTextFromStreamJson: vi.fn((raw: string) => raw),
}));

const IDLE_MS = 10 * 60 * 1000;
const HARD_MS = 30 * 60 * 1000;
const LISTENED = ['data', 'thinking-chunk', 'tool-execution', 'usage', 'exit', 'session-id'];

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

/** Minimal ProcessManager stand-in: the runner only uses on/off/kill. */
class FakeProcessManager extends EventEmitter {
	kill = vi.fn();
}

const targetSession = (): CrossAgentTargetSession => ({
	id: 'tgt',
	name: 'Maestro Marketing',
	toolType: 'claude-code',
	cwd: '/proj',
});

function harness(sshStore: unknown = null) {
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
					fullAccessArgs: ['--dangerously-skip-permissions'],
					readOnlyArgs: ['--permission-mode', 'plan'],
					readOnlyCliEnforced: true,
				}),
			} as never,
			sshStore: sshStore as never,
			getTargetSession: targetSession,
			onChunk: (c) => chunks.push(c),
		});
	// The runner keys its listeners on `cross-agent-<requestId>`; request() uses 'r1'.
	const sid = `${CROSS_AGENT_SESSION_PREFIX}r1`;
	return {
		processManager,
		chunks,
		dispatch,
		emitData: (text: string) => processManager.emit('data', sid, text),
		emitExit: (code: number) => processManager.emit('exit', sid, code),
		emitThinking: () => processManager.emit('thinking-chunk', sid, 'reasoning...'),
		emitTool: () => processManager.emit('tool-execution', sid, { name: 'Read' }),
		emitUsage: () => processManager.emit('usage', sid, { inputTokens: 1 }),
		emitSession: (id: string) => processManager.emit('session-id', sid, id),
	};
}

describe('the desktop consult runner', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.mocked(spawnGroupChatAgent).mockResolvedValue({ pid: 123, success: true });
	});
	afterEach(() => {
		cancelCrossAgentRequestsForSource('src');
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('exports the prompt builders the renderer and tests still import from here', () => {
		expect(serializeTranscript([{ source: 'user', text: 'Hi' }])).toBe('**User:** Hi');
		expect(buildCrossAgentPrompt(request())).toContain('There is no prior conversation to read');
	});

	it('spawns through the group chat spawn helper over this process manager and SSH store', async () => {
		const sshStore = { getSshRemotes: () => [] };
		const { dispatch, processManager } = harness(sshStore);
		await dispatch();

		const config = vi.mocked(spawnGroupChatAgent).mock.calls[0][0];
		expect(config).toMatchObject({
			sessionId: 'cross-agent-r1',
			agentId: 'claude-code',
			cwd: '/proj',
			readOnlyMode: true,
		});
		expect(config.processManager).toBe(processManager);
		expect(config.sshStore).toBe(sshStore);
	});

	it('buffers the stream and delivers it, with the session id, when the process exits', async () => {
		const { chunks, dispatch, emitData, emitSession, emitExit } = harness();
		await dispatch();

		emitData('the ');
		emitData('answer');
		emitSession('prov-sess-1');
		emitExit(0);

		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({
			chunk: 'the answer',
			done: true,
			targetAgentSessionId: 'prov-sess-1',
		});
	});

	it('attaches every listener before the spawn so no early event is missed', async () => {
		const { dispatch, processManager } = harness();
		vi.mocked(spawnGroupChatAgent).mockImplementationOnce(async () => {
			for (const evt of LISTENED) expect(processManager.listenerCount(evt)).toBeGreaterThan(0);
			return { pid: 1, success: true };
		});
		await dispatch();
		expect.assertions(LISTENED.length);
	});

	it.each([
		['thinking', 'emitThinking'],
		['a tool call', 'emitTool'],
		['a usage report', 'emitUsage'],
	] as const)('treats %s as proof of life, though it carries no data', async (_label, emit) => {
		// A `--print` stream-json consult emits `data` ONLY at the terminal result; intermediate
		// progress goes to these events. Arming the silence budget on `data` alone made it a hard
		// deadline that killed agents which were working perfectly.
		const h = harness();
		await h.dispatch();

		for (let elapsed = 0; elapsed < HARD_MS - IDLE_MS; elapsed += IDLE_MS - 60_000) {
			vi.advanceTimersByTime(IDLE_MS - 60_000);
			h[emit]();
		}

		expect(h.chunks).toHaveLength(0);
	});

	it('ignores events belonging to a different session', async () => {
		// The ProcessManager emitter is shared app-wide; another agent's activity must not keep a
		// genuinely wedged consult alive forever, and its output must not leak into this answer.
		const { chunks, dispatch, processManager, emitExit } = harness();
		await dispatch();

		processManager.emit('data', 'some-other-session', 'not ours');
		vi.advanceTimersByTime(IDLE_MS - 60_000);
		processManager.emit('thinking-chunk', 'some-other-session', 'not ours');
		processManager.emit('exit', 'some-other-session', 0);
		vi.advanceTimersByTime(60_000);

		expect(chunks).toHaveLength(1);
		expect(chunks[0].error).toContain('went silent');
		expect(chunks[0].chunk).toBe('');
		emitExit(0);
		expect(chunks).toHaveLength(1);
	});

	it('removes every listener once the consult ends', async () => {
		// These attach to the shared ProcessManager; leaking one per consult would accumulate for the
		// life of the app.
		const { dispatch, emitExit, processManager } = harness();
		await dispatch();
		expect(LISTENED.every((evt) => processManager.listenerCount(evt) > 0)).toBe(true);

		emitExit(0);

		for (const evt of LISTENED) expect(processManager.listenerCount(evt)).toBe(0);
	});

	it('kills the process and flushes the partial output once it goes silent', async () => {
		const { chunks, dispatch, emitData, processManager } = harness();
		await dispatch();

		emitData('half an answer');
		vi.advanceTimersByTime(IDLE_MS);

		expect(processManager.kill).toHaveBeenCalledWith('cross-agent-r1');
		expect(chunks).toHaveLength(1);
		expect(chunks[0].chunk).toBe('half an answer');
		expect(chunks[0].error).toContain('went silent');
		for (const evt of LISTENED) expect(processManager.listenerCount(evt)).toBe(0);
	});

	it('removes every listener, and kills nothing, when the spawner refuses', async () => {
		vi.mocked(spawnGroupChatAgent).mockResolvedValue({ pid: -1, success: false });
		const { chunks, dispatch, processManager } = harness();
		await dispatch();

		expect(chunks).toHaveLength(1);
		expect(chunks[0].error).toContain('could not be started');
		for (const evt of LISTENED) expect(processManager.listenerCount(evt)).toBe(0);
		expect(processManager.kill).not.toHaveBeenCalled();
	});

	it('removes every listener when the spawner throws', async () => {
		vi.mocked(spawnGroupChatAgent).mockRejectedValue(new Error('spawn exploded'));
		const { chunks, dispatch, processManager } = harness();
		await dispatch();

		expect(chunks).toHaveLength(1);
		expect(chunks[0].error).toBe('spawn exploded');
		for (const evt of LISTENED) expect(processManager.listenerCount(evt)).toBe(0);
	});
});

/**
 * Stop is an AGENT-level action, and a `@mention` fans one turn out across an ephemeral
 * `cross-agent-*` process per consulted target. The handler reaches them through the shim.
 */
describe('cancelCrossAgentRequestsForSource', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.mocked(spawnGroupChatAgent).mockResolvedValue({ pid: 123, success: true });
	});
	afterEach(() => {
		cancelCrossAgentRequestsForSource('src');
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('kills a running consult and settles it as canceled, keeping what it had said', async () => {
		const { chunks, dispatch, processManager, emitData } = harness();
		await dispatch();
		emitData('half an answer');

		expect(cancelCrossAgentRequestsForSource('src')).toBe(1);

		expect(processManager.kill).toHaveBeenCalledWith('cross-agent-r1');
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({ done: true, canceled: true, chunk: 'half an answer' });
		expect(chunks[0].error).toBeUndefined();
		for (const evt of LISTENED) expect(processManager.listenerCount(evt)).toBe(0);
	});

	it('sees consults started by separate calls, since one service serves the whole app', async () => {
		const first = harness();
		await first.dispatch();

		expect(cancelCrossAgentRequestsForSource('src')).toBe(1);
		expect(cancelCrossAgentRequestsForSource('src')).toBe(0);
	});

	it('leaves consults belonging to another source agent alone', async () => {
		const { chunks, dispatch, processManager } = harness();
		await dispatch();

		expect(cancelCrossAgentRequestsForSource('some-other-agent')).toBe(0);
		expect(processManager.kill).not.toHaveBeenCalled();
		expect(chunks).toHaveLength(0);
	});

	it('kills a process that finished spawning after the Stop that ended it', async () => {
		const { chunks, dispatch, processManager } = harness();
		let releaseSpawn: () => void = () => {};
		vi.mocked(spawnGroupChatAgent).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseSpawn = () => resolve({ pid: 123, success: true });
				})
		);

		const pending = dispatch();
		await vi.waitFor(() => expect(spawnGroupChatAgent).toHaveBeenCalled());
		expect(cancelCrossAgentRequestsForSource('src')).toBe(1);
		processManager.kill.mockClear();

		releaseSpawn();
		await pending;

		expect(processManager.kill).toHaveBeenCalledWith('cross-agent-r1');
		expect(chunks).toHaveLength(1);
		expect(chunks[0].canceled).toBe(true);
	});
});
